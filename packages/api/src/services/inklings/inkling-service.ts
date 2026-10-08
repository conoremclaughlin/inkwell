/**
 * Inklings: awakening and naming for the Inkling consumer app.
 *
 * Contract v3 (inkling:thread:app-build, 242d45bf with Lumen's amendments
 * 58202c0a). An inkling is an SB a person awakened from the app: an
 * agent_identities row with metadata.client 'inkling-mobile', born through a
 * self-serve kindle lineage. Nothing else is one, so the app can never list
 * or rename the account's other SBs.
 *
 * - Awakening goes through the existing redemption: the server mints a
 *   parentless token for the person and redeems it at once, so identity and
 *   lineage are created in one transaction. It is complete at creation;
 *   naming is independent and optional forever.
 * - The client's awakenRequestId makes awakening retry-safe: a unique index
 *   on (user_id, metadata->>'awakenRequestId') means one identity per
 *   request, even when two retries race.
 * - Naming changes the display name only. The slug never changes, so
 *   memories, threads and routing follow the inkling.
 * - Nothing here runs a model, opens a thread or wakes anyone.
 *
 * Every lookup is scoped to the person and the workspace the request
 * resolved (AGENTS.md: workspace scope is server-derived).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_AWAKEN_CAP,
  isInklingOwnerTestUser,
  type OwnerTestAllowlist,
} from '../../config/inkling-flags';
import { cancelInklingTurns } from './inkling-turns';
import { dropReplyChainsFor } from './inkling-reply-chain';
import { logger } from '../../utils/logger';
import { INKLING_CLIENT } from './inkling-client';
import { ensureInklingStarterSet, inklingSoul } from './starter-space';

/** The identity metadata tag for inklings born through this flow (defined in inkling-client.ts). */
export { INKLING_CLIENT };

/** The app's own limit (MAX_NAME_LENGTH), in Unicode code points. */
export const MAX_DISPLAY_NAME_CODE_POINTS = 32;

/** The stored name until the person names the inkling. Never shown as a display name. */
const PLACEHOLDER_NAME = 'Unnamed inkling';

/** The self-serve token is redeemed in the same request that mints it. */
const SELF_SERVE_TOKEN_LIFETIME_MS = 5 * 60 * 1000;

/** Concurrent writers of the same identity row: retries before giving up. */
const NAME_WRITE_ATTEMPTS = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** The wire shape (contract v3 §Inkling). */
export interface Inkling {
  /** agent_identities.id: durable, and the seed of the inkling's blot. */
  id: string;
  /** Routing only: never shown, never changes. */
  sbSlug: string;
  /** Null until the person names it. */
  displayName: string | null;
  /** The identity row's created_at. */
  createdAt: string;
  /** True for every inkling this service returns: only those born through this flow. */
  nameable: boolean;
}

/**
 * The read-only profile the app shows for one of the person's own inklings:
 * who it is (soul) and what it holds to (its own values), nothing else. Not
 * the workspace's shared constitution, and never heartbeat, runtime config,
 * backend, metadata, relationships, history or memories.
 */
export interface InklingProfile {
  id: string;
  /** Null until the person names it. */
  displayName: string | null;
  createdAt: string;
  /**
   * When the identity row last changed, for any reason (a rename included).
   * Not when the soul was last written.
   */
  identityUpdatedAt: string;
  /** Null when not written yet. */
  soul: string | null;
  /** This inkling's own values; empty when not written yet. */
  values: string[];
}

/**
 * One approval request an inkling made, as the person's Approvals view shows
 * it (ink://designs/inkling-approvals-extension §A): what was asked and how
 * it stands, never the tool's input, the grant it produced, or who decided.
 */
export interface InklingApproval {
  id: string;
  /** The tool the inkling asked to use. */
  tool: string;
  /** The reason the request gave, cut to APPROVAL_PURPOSE_MAX code points; null when it gave none. */
  purpose: string | null;
  status: InklingApprovalStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
}

/**
 * The stored statuses, with `expired` also covering a pending request past
 * its deadline, as the approval interceptor reads it. Anything else stored
 * reads as `unknown`, never passed through.
 */
export type InklingApprovalStatus =
  | 'pending'
  | 'granted'
  | 'denied'
  | 'expired'
  | 'cancelled'
  | 'unknown';

export interface InklingApprovalsPage {
  approvals: InklingApproval[];
  /** Pass as `before` for the next, older page; null when this was the last. */
  nextBefore: string | null;
}

export const APPROVALS_PAGE_DEFAULT = 20;
export const APPROVALS_PAGE_MAX = 50;
export const APPROVAL_PURPOSE_MAX = 280;

const APPROVAL_COLUMNS = 'id, tool, reason, status, created_at, expires_at, resolved_at';
const STORED_APPROVAL_STATUSES = new Set(['pending', 'granted', 'denied', 'expired', 'cancelled']);

interface ApprovalRow {
  id: string;
  tool: string;
  reason: string | null;
  status: string;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
}

/**
 * A page cursor: the last row's created_at exactly as Postgres returned it,
 * microseconds included, and its id. It never passes through a JS Date,
 * which would cut it to milliseconds and skip rows within one millisecond.
 */
export function encodeApprovalCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify({ c: row.created_at, i: row.id })).toString('base64url');
}

/**
 * A timestamptz as PostgREST returns one: date, time, up to six fractional
 * digits, and an optional offset.
 */
const CURSOR_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?)?$/;

/**
 * A real moment on Postgres's calendar. Postgres refuses an impossible date,
 * hour or offset with an error, which reached the person as a 500 for what is
 * a bad request (Lumen, #767). It accepts 24:00, a leap second and a seventh
 * fractional digit by moving the time, so a cursor carrying one would no
 * longer be the row it names; Postgres never returns any of them.
 */
function isCursorTimestamp(value: string): boolean {
  const match = CURSOR_TIMESTAMP.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (month < 1 || month > 12) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return (
    year >= 1 &&
    day >= 1 &&
    day <= monthDays &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    Number(match[7] ?? 0) <= 15 &&
    Number(match[8] ?? 0) <= 59
  );
}

export function decodeApprovalCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const { c, i } = parsed as { c?: unknown; i?: unknown };
    if (typeof c !== 'string' || !isCursorTimestamp(c)) return null;
    if (!isUuid(i)) return null;
    return { createdAt: c, id: i };
  } catch {
    return null;
  }
}

/** The status the person sees: pending past its deadline (Node's clock, inclusive) is expired. */
export function approvalStatus(
  row: { status: string; expires_at: string },
  now: number
): InklingApprovalStatus {
  if (!STORED_APPROVAL_STATUSES.has(row.status)) return 'unknown';
  if (row.status === 'pending' && Date.parse(row.expires_at) <= now) return 'expired';
  return row.status as InklingApprovalStatus;
}

/** Cut by code points, so a surrogate pair is never split. */
export function approvalPurpose(reason: string | null): string | null {
  if (typeof reason !== 'string' || reason.trim() === '') return null;
  const points = Array.from(reason);
  return points.length <= APPROVAL_PURPOSE_MAX
    ? reason
    : `${points.slice(0, APPROVAL_PURPOSE_MAX - 1).join('')}…`;
}

/**
 * One page of an owner's approval requests from one requester, newest first.
 * The caller has already established that `filter` names the person's own
 * inkling; this only reads. Exported for the database integration test.
 *
 * A keyset on (created_at, id), read as two plain queries: the rest of the
 * cursor's own timestamp, then everything older.
 */
export async function readApprovalsPage(
  supabase: SupabaseClient,
  filter: { userId: string; workspaceId: string; sbId: string },
  opts: { limit?: number; before?: string },
  now: () => number
): Promise<InklingApprovalsPage> {
  const requested = Math.trunc(Number(opts.limit ?? APPROVALS_PAGE_DEFAULT));
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), APPROVALS_PAGE_MAX)
    : APPROVALS_PAGE_DEFAULT;
  const cursor = opts.before === undefined ? null : decodeApprovalCursor(opts.before);
  if (opts.before !== undefined && !cursor) {
    throw new InklingError(400, 'That page cursor is not valid');
  }

  const base = () =>
    supabase
      .from('approval_requests')
      .select(APPROVAL_COLUMNS)
      .eq('user_id', filter.userId)
      .eq('workspace_id', filter.workspaceId)
      .eq('sb_id', filter.sbId);

  const rows: ApprovalRow[] = [];
  if (cursor) {
    const { data, error } = await base()
      .eq('created_at', cursor.createdAt)
      .lt('id', cursor.id)
      .order('id', { ascending: false })
      .limit(limit + 1);
    if (error) throw new Error(`Failed to read the inkling's approvals: ${error.message}`);
    rows.push(...((data ?? []) as ApprovalRow[]));
  }
  if (rows.length <= limit) {
    let older = base();
    if (cursor) older = older.lt('created_at', cursor.createdAt);
    const { data, error } = await older
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1 - rows.length);
    if (error) throw new Error(`Failed to read the inkling's approvals: ${error.message}`);
    rows.push(...((data ?? []) as ApprovalRow[]));
  }

  const page = rows.slice(0, limit);
  const at = now();
  return {
    approvals: page.map((row) => ({
      id: row.id,
      tool: row.tool,
      purpose: approvalPurpose(row.reason),
      status: approvalStatus(row, at),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      resolvedAt: row.resolved_at,
    })),
    nextBefore: rows.length > limit ? encodeApprovalCursor(page[page.length - 1]) : null,
  };
}

export interface InklingScope {
  userId: string;
  workspaceId: string;
  /** The person's role in this workspace. Awakening and naming need 'owner'. */
  role?: string;
}

export interface InklingServiceOptions {
  /** Awakenings per person, enforced inside redeem_kindle_token; null for none. */
  awakenCap?: number | null;
  /**
   * The owner test's accounts (inklingOwnerTestUserIds). Empty or absent:
   * nobody may awaken or name an inkling here.
   */
  ownerTestUserIds?: OwnerTestAllowlist;
  /** The clock an awakening's soul is dated by. */
  now?: () => Date;
}

/** The answer for awakening or naming outside the owner test, whoever is asking. */
export const INKLINGS_DISABLED = 'inklings_disabled';

/** A refusal the caller can act on, with the HTTP status the route answers. */
export class InklingError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
    /** A stable machine-readable reason, for an answer the app must tell apart. */
    readonly code?: string
  ) {
    super(message);
    this.name = 'InklingError';
  }
}

/** The SQLSTATE redeem_kindle_token raises at the awakening cap. */
export const AWAKEN_CAP_SQLSTATE = 'IK001';

interface IdentityRow {
  id: string;
  agent_id: string;
  name: string;
  workspace_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface LineageRow {
  id: string;
  child_sb_id: string | null;
  chosen_name: string | null;
}

const IDENTITY_COLUMNS = 'id, agent_id, name, workspace_id, metadata, created_at, updated_at';

/** A profile's columns: the identity's own soul and values, never anything else on the row. */
const PROFILE_COLUMNS = 'id, name, metadata, created_at, updated_at, soul, values';

interface ProfileRow {
  id: string;
  name: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  soul: unknown;
  values: unknown;
}

/** Only strings with something in them count as values. */
function valuesFrom(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

export function toInkling(row: IdentityRow): Inkling {
  return {
    id: row.id,
    sbSlug: row.agent_id,
    displayName: row.metadata?.named === true ? row.name : null,
    createdAt: row.created_at,
    nameable: true,
  };
}

/** Unicode line breaks besides the C0/C1 controls: a name is one line. */
const REFUSED_IN_NAME = /[\p{Cc}\p{Cs}\u2028\u2029]/u;

/**
 * Something that draws: neither white space nor a default-ignorable code
 * point (zero-width spaces and joiners, the Hangul filler and the like).
 */
const VISIBLE = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}]/u;

/**
 * Trimmed, 1–32 code points ("小墨" is two), at least one visible character,
 * and no control characters. A code point is what the app counts
 * ([...name].length), so a name the app accepts is never refused here for
 * its length.
 */
export function validateDisplayName(
  input: unknown
): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof input !== 'string') return { ok: false, reason: 'displayName must be a string' };
  const value = input.trim();
  const length = [...value].length;
  if (length === 0) return { ok: false, reason: 'displayName must not be empty' };
  if (length > MAX_DISPLAY_NAME_CODE_POINTS) {
    return {
      ok: false,
      reason: `displayName must be at most ${MAX_DISPLAY_NAME_CODE_POINTS} characters`,
    };
  }
  if (REFUSED_IN_NAME.test(value)) {
    return { ok: false, reason: 'displayName must not contain control characters' };
  }
  if (!VISIBLE.test(value)) {
    return { ok: false, reason: 'displayName must contain at least one visible character' };
  }
  return { ok: true, value };
}

/**
 * The soul an inkling wakes with: its own document, which it writes in. The
 * text is the starter documents' (starter-space.ts), in one place for every
 * path that awakens an inkling. Unlike the web invite's onboarding soul,
 * there is no values interview and no name proposals.
 */
export function buildInklingSoul(awakeSince: Date): string {
  return inklingSoul(awakeSince);
}

/**
 * Rows per request when listing: well under PostgREST's default 1000-row
 * cap, and the length of each lineage lookup's `in` list.
 */
export const LIST_PAGE_SIZE = 100;

/** created_at, then id: the order the list promises. */
function oldestFirst(a: IdentityRow, b: IdentityRow): number {
  const byTime = Date.parse(a.created_at) - Date.parse(b.created_at);
  return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function isInklingRow(row: IdentityRow): boolean {
  return row.metadata?.client === INKLING_CLIENT;
}

export class InklingService {
  private readonly awakenCap: number | null;
  private readonly ownerTestUserIds: OwnerTestAllowlist;
  private readonly now: () => Date;

  constructor(
    private readonly supabase: SupabaseClient,
    options: InklingServiceOptions = {}
  ) {
    this.awakenCap = options.awakenCap === undefined ? DEFAULT_AWAKEN_CAP : options.awakenCap;
    this.ownerTestUserIds = options.ownerTestUserIds ?? new Set();
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Awakening and naming are open only in the owner test, and only to one
   * of its accounts acting as the owner of the workspace. Everyone else,
   * and everyone when the test is off, gets the same 403, which does not
   * say who is in the test.
   */
  private assertOwnerTest(scope: InklingScope): void {
    const isOwner =
      isInklingOwnerTestUser(scope.userId, this.ownerTestUserIds) && scope.role === 'owner';
    if (!isOwner) {
      throw new InklingError(403, 'Inklings are not open on this server', INKLINGS_DISABLED);
    }
  }

  /**
   * The person's inklings in this workspace, oldest first, all of them.
   * Read in pages by id, so no request is cut short by PostgREST's row cap
   * and each lineage lookup's `in` list stays bounded. Only an empty page
   * ends the read: a short one can be the server's row cap, not the end.
   */
  async list(scope: InklingScope): Promise<Inkling[]> {
    const inklings: IdentityRow[] = [];
    let after: string | null = null;
    for (;;) {
      let query = this.supabase
        .from('agent_identities')
        .select(IDENTITY_COLUMNS)
        .eq('user_id', scope.userId)
        .eq('workspace_id', scope.workspaceId)
        .eq('metadata->>client', INKLING_CLIENT);
      if (after) query = query.gt('id', after);
      const { data, error } = await query.order('id', { ascending: true }).limit(LIST_PAGE_SIZE);
      if (error) throw new Error(`Failed to list inklings: ${error.message}`);
      const page = (data ?? []) as IdentityRow[];
      if (page.length === 0) break;

      // The metadata tag alone is not birth through this flow: the lineage
      // must say self_serve too.
      const born = await this.selfServeLineages(
        scope.userId,
        page.map((r) => r.id)
      );
      inklings.push(...page.filter((r) => born.has(r.id)));
      after = page[page.length - 1].id;
    }
    return inklings.sort(oldestFirst).map(toInkling);
  }

  /**
   * Awaken a new inkling for this request id, or return the one it already
   * awakened. The same id from another workspace is a conflict, never the
   * other workspace's inkling.
   */
  async awaken(
    scope: InklingScope,
    clientRequestId: string
  ): Promise<{ inkling: Inkling; replayed: boolean }> {
    // A UUID's letter case is spelling, not identity, and the id is stored
    // and compared as text: one spelling for every lookup and the write.
    this.assertOwnerTest(scope);
    // A space that never had the starter set gets it now, whenever and however
    // it was made (starter-space.ts). Best effort: the inkling still wakes if
    // this fails, and the next awakening tries again.
    await ensureInklingStarterSet(this.supabase, scope.workspaceId, scope.userId).catch((error) =>
      logger.warn('Inkling awakened without its space starter set', {
        workspaceId: scope.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    const requestId = clientRequestId.toLowerCase();
    const prior = await this.findByAwakenRequest(scope.userId, requestId);
    if (prior) return this.replay(prior, scope);

    const token = await this.mintSelfServeToken(scope.userId);
    const { data: lineage, error } = await this.supabase.rpc('redeem_kindle_token', {
      p_token: token.token,
      p_new_user_id: scope.userId,
      p_workspace_id: scope.workspaceId,
      p_identity: {
        name: PLACEHOLDER_NAME,
        role: 'Inkling',
        description: 'An inkling awakened in the Inkling app',
        soul: buildInklingSoul(this.now()),
        values: [],
        metadata: {
          prototype: true,
          client: INKLING_CLIENT,
          awakenRequestId: requestId,
          named: false,
          // Born under the owner test: the only inklings a turn may start
          // for, and only while the test is on for this same account.
          ownerTest: true,
        },
      },
      p_kindle_method: 'self_serve',
      p_awaken_cap: this.awakenCap,
    });

    const childSbId = (lineage as { child_sb_id?: string | null } | null)?.child_sb_id;
    if (error || !childSbId) {
      // The redemption rolled back whole, so this token is still active.
      await this.revokeToken(token.id);
      // A concurrent retry of the same awakening won the index: its inkling
      // is the answer to this request too.
      const winner = await this.findByAwakenRequest(scope.userId, requestId);
      if (winner) return this.replay(winner, scope);
      if (error?.code === AWAKEN_CAP_SQLSTATE) {
        throw new InklingError(
          409,
          `You can awaken at most ${this.awakenCap} inklings for now`,
          'awakening_cap_reached'
        );
      }
      throw new Error(`Failed to awaken an inkling: ${error?.message ?? 'no identity bound'}`);
    }

    const identity = await this.readIdentity(childSbId, scope);
    if (!identity) throw new Error(`Awakened identity ${childSbId} could not be read back`);
    logger.info('Inkling awakened', {
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      sbId: identity.id,
    });
    return { inkling: toInkling(identity), replayed: false };
  }

  /**
   * One of the person's own inklings, read-only: its id, name, when it was
   * awakened, when its row last changed, its soul and its own values.
   *
   * The same reader as list: this person, this workspace, the inkling tag and
   * a self-serve lineage, all required. A malformed id, an unknown one,
   * another person's, another workspace's, an agent that isn't an inkling,
   * and one without the lineage all get the same 404.
   */
  async profile(scope: InklingScope, inklingId: string): Promise<InklingProfile> {
    const row = await this.readOwnInkling<ProfileRow>(
      scope,
      inklingId,
      PROFILE_COLUMNS,
      "Failed to read the inkling's profile"
    );
    return {
      id: row.id,
      displayName: row.metadata?.named === true ? row.name : null,
      createdAt: row.created_at,
      identityUpdatedAt: row.updated_at,
      soul: typeof row.soul === 'string' && row.soul.trim() !== '' ? row.soul : null,
      values: valuesFrom(row.values),
    };
  }

  /**
   * The approval requests one of the person's own inklings made, newest
   * first, read-only (ink://designs/inkling-approvals-extension §A).
   *
   * The same reader as profile: this person, this workspace, the inkling
   * tag and a self-serve lineage, or the same 404. Only requests whose
   * requester was recorded from a signed token (`sb_id`) are listed;
   * older requests, and ones made with a person's token, carry none, so the
   * list is what was attributed, not a promise that nothing else was asked.
   *
   * Paged by a keyset on (created_at, id), read as two plain queries: the
   * rest of the cursor's own timestamp, then everything older.
   */
  async approvals(
    scope: InklingScope,
    inklingId: string,
    opts: { limit?: number; before?: string } = {},
    now: () => number = Date.now
  ): Promise<InklingApprovalsPage> {
    await this.readOwnInkling<{ id: string }>(
      scope,
      inklingId,
      'id',
      "Failed to read the inkling's approvals"
    );

    return readApprovalsPage(
      this.supabase,
      { userId: scope.userId, workspaceId: scope.workspaceId, sbId: inklingId },
      opts,
      now
    );
  }

  /**
   * One of the person's own inklings, or the same 404 for anything else: a
   * malformed id, an unknown one, another person's, another workspace's, an
   * agent that isn't an inkling, and one without a self-serve lineage. The
   * reader profile and approvals share, so they cannot drift apart.
   */
  private async readOwnInkling<T extends { id: string }>(
    scope: InklingScope,
    inklingId: string,
    columns: string,
    failure: string
  ): Promise<T> {
    const missing = () => new InklingError(404, 'No inkling with that id');
    if (!isUuid(inklingId)) throw missing();
    const { data, error } = await this.supabase
      .from('agent_identities')
      .select(columns)
      .eq('id', inklingId)
      .eq('user_id', scope.userId)
      .eq('workspace_id', scope.workspaceId)
      .eq('metadata->>client', INKLING_CLIENT)
      .maybeSingle();
    if (error) throw new Error(`${failure}: ${error.message}`);
    const row = data as T | null;
    if (!row) throw missing();
    if (!(await this.selfServeLineages(scope.userId, [row.id])).has(row.id)) throw missing();
    return row;
  }

  /**
   * Set an inkling's display name. Idempotent, and renamable forever. The
   * slug is never touched; the lineage records the chosen name.
   */
  async name(scope: InklingScope, inklingId: string, displayName: string): Promise<Inkling> {
    this.assertOwnerTest(scope);
    const identity = isUuid(inklingId) ? await this.readIdentity(inklingId, scope) : null;
    if (!identity) throw new InklingError(404, 'No inkling with that id');
    const lineage = (await this.selfServeLineages(scope.userId, [identity.id])).get(identity.id);
    if (!lineage || !isInklingRow(identity)) {
      throw new InklingError(409, 'Only an inkling awakened in the Inkling app can be named here');
    }

    const named = await this.writeName(identity, scope, displayName);
    if (lineage.chosen_name !== displayName) {
      const { error } = await this.supabase
        .from('kindle_lineage')
        .update({ chosen_name: displayName })
        .eq('id', lineage.id);
      if (error) throw new Error(`Failed to record the chosen name: ${error.message}`);
    }
    return toInkling(named);
  }

  /**
   * Stop this inkling's running turn, if it has one in this server process
   * (inkling-turns.ts). Owner test only, and only the caller's own inkling.
   * `cancelled` says whether a turn was running to stop.
   */
  async cancel(scope: InklingScope, inklingId: string): Promise<{ cancelled: boolean }> {
    this.assertOwnerTest(scope);
    const identity = isUuid(inklingId) ? await this.readIdentity(inklingId, scope) : null;
    if (!identity || !isInklingRow(identity)) {
      throw new InklingError(404, 'No inkling with that id');
    }
    // Waiting members first: aborting the running turn ends it, and an ended
    // turn wakes the next member in turn (inkling-reply-chain.ts).
    const dropped = dropReplyChainsFor(identity.id);
    const aborted = cancelInklingTurns(identity.id);
    return { cancelled: aborted > 0 || dropped > 0 };
  }

  /**
   * One conditional update per attempt: the row is rewritten only if nobody
   * changed it since it was read (another writer may be setting other
   * metadata, such as runtimeConfig, and must not be clobbered). A losing
   * attempt re-reads and tries again.
   */
  private async writeName(
    identity: IdentityRow,
    scope: InklingScope,
    displayName: string
  ): Promise<IdentityRow> {
    let current = identity;
    for (let attempt = 0; attempt < NAME_WRITE_ATTEMPTS; attempt++) {
      if (current.name === displayName && current.metadata?.named === true) return current;
      const { data, error } = await this.supabase
        .from('agent_identities')
        .update({ name: displayName, metadata: { ...(current.metadata ?? {}), named: true } })
        .eq('id', current.id)
        .eq('user_id', scope.userId)
        .eq('workspace_id', scope.workspaceId)
        .eq('updated_at', current.updated_at)
        .select(IDENTITY_COLUMNS)
        .maybeSingle();
      if (error) throw new Error(`Failed to name the inkling: ${error.message}`);
      if (data) return data as IdentityRow;
      const reread = await this.readIdentity(current.id, scope);
      if (!reread) throw new InklingError(404, 'No inkling with that id');
      current = reread;
    }
    throw new Error('Failed to name the inkling: the identity kept changing underneath the write');
  }

  private replay(row: IdentityRow, scope: InklingScope): { inkling: Inkling; replayed: true } {
    if (row.workspace_id !== scope.workspaceId) {
      throw new InklingError(409, 'This awakening request was already used in another workspace');
    }
    // Only this flow writes awakenRequestId, but a replay hands back an
    // identity, so it must be one the app may hold: never another SB.
    if (!isInklingRow(row)) {
      throw new InklingError(
        409,
        'This awakening request belongs to something that is not an inkling'
      );
    }
    return { inkling: toInkling(row), replayed: true };
  }

  private async findByAwakenRequest(
    userId: string,
    clientRequestId: string
  ): Promise<IdentityRow | null> {
    // (user_id, awakenRequestId) is unique, so this is at most one row.
    const { data, error } = await this.supabase
      .from('agent_identities')
      .select(IDENTITY_COLUMNS)
      .eq('user_id', userId)
      .eq('metadata->>awakenRequestId', clientRequestId)
      .maybeSingle();
    if (error) throw new Error(`Failed to look up the awakening request: ${error.message}`);
    return (data as IdentityRow | null) ?? null;
  }

  private async readIdentity(id: string, scope: InklingScope): Promise<IdentityRow | null> {
    const { data, error } = await this.supabase
      .from('agent_identities')
      .select(IDENTITY_COLUMNS)
      .eq('id', id)
      .eq('user_id', scope.userId)
      .eq('workspace_id', scope.workspaceId)
      .maybeSingle();
    if (error) throw new Error(`Failed to read the inkling: ${error.message}`);
    return (data as IdentityRow | null) ?? null;
  }

  /** Self-serve lineages for these identities, keyed by identity id. */
  private async selfServeLineages(
    userId: string,
    sbIds: string[]
  ): Promise<Map<string, LineageRow>> {
    const { data, error } = await this.supabase
      .from('kindle_lineage')
      .select('id, child_sb_id, chosen_name')
      .eq('child_user_id', userId)
      .eq('kindle_method', 'self_serve')
      .in('child_sb_id', sbIds);
    if (error) throw new Error(`Failed to read awakening lineage: ${error.message}`);
    const lineages = new Map<string, LineageRow>();
    for (const row of (data ?? []) as LineageRow[]) {
      if (row.child_sb_id) lineages.set(row.child_sb_id, row);
    }
    return lineages;
  }

  private async mintSelfServeToken(userId: string): Promise<{ id: string; token: string }> {
    const { data, error } = await this.supabase
      .from('kindle_tokens')
      .insert({
        creator_user_id: userId,
        creator_agent_id: null,
        value_seed: {},
        expires_at: new Date(Date.now() + SELF_SERVE_TOKEN_LIFETIME_MS).toISOString(),
      })
      .select('id, token')
      .single();
    if (error || !data) {
      throw new Error(`Failed to mint an awakening token: ${error?.message ?? 'no row'}`);
    }
    return data as { id: string; token: string };
  }

  /** Best effort: an unrevoked token still expires within minutes. */
  private async revokeToken(tokenId: string): Promise<void> {
    const { error } = await this.supabase
      .from('kindle_tokens')
      .update({ status: 'revoked' })
      .eq('id', tokenId)
      .eq('status', 'active');
    if (error) {
      logger.warn('Failed to revoke an unused awakening token', { tokenId, error: error.message });
    }
  }
}
