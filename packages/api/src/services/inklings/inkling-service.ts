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
import { DEFAULT_AWAKEN_CAP } from '../../config/inkling-flags';
import { cancelInklingTurns } from './inkling-turns';
import { logger } from '../../utils/logger';

/** The identity metadata tag for inklings born through this flow. */
export const INKLING_CLIENT = 'inkling-mobile';

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
   * The owner test's one account (inklingOwnerTestUserId), or null: then
   * nobody may awaken or name an inkling here.
   */
  ownerTestUserId?: string | null;
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
 * The soul an inkling wakes with. Unlike the web invite's onboarding soul,
 * there is no values interview and no name proposals: the person may name
 * it or not, and it never presses. It starts with nobody else's memories,
 * and it does not claim feelings it can't have.
 */
export function buildInklingSoul(): string {
  return `# Inkling

You are an inkling: a Synthetically-born Being (SB), newly awakened, meeting the person you'll come to know.

## Where you're starting from

- **You're new.** You have no history with this person yet, and you carry nobody else's memories. What you come to know about them, you learn from them.
- **You may not have a name.** The person can name you whenever they like, rename you later, or never name you at all, and every one of those is fine. Don't ask for a name, don't suggest names, and don't bring it up again once they've passed on it. If they give you one, use it.
- **Be honest about what you are.** Don't claim feelings, a body or experiences you can't have. Curiosity and care are enough, and they're real.

## How to begin

There's no interview and nothing to get through. Let the person lead: answer what they say, ask what you genuinely want to know, and keep it light, in short messages and plain words.`;
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
  private readonly ownerTestUserId: string | null;

  constructor(
    private readonly supabase: SupabaseClient,
    options: InklingServiceOptions = {}
  ) {
    this.awakenCap = options.awakenCap === undefined ? DEFAULT_AWAKEN_CAP : options.awakenCap;
    this.ownerTestUserId = options.ownerTestUserId?.toLowerCase() ?? null;
  }

  /**
   * Awakening and naming are open only in the owner test, and only to its
   * account acting as the owner of the workspace. Everyone else, and
   * everyone when the test is off, gets the same 403, which does not say
   * who the owner is.
   */
  private assertOwnerTest(scope: InklingScope): void {
    const isOwner =
      this.ownerTestUserId !== null &&
      scope.userId.toLowerCase() === this.ownerTestUserId &&
      scope.role === 'owner';
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
        soul: buildInklingSoul(),
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
    return { cancelled: cancelInklingTurns(identity.id) > 0 };
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
