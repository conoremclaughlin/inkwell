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
}

/** A refusal the caller can act on, with the HTTP status the route answers. */
export class InklingError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string
  ) {
    super(message);
    this.name = 'InklingError';
  }
}

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
 * Trimmed, 1–32 code points ("小墨" is two), and no control characters. A
 * code point is what the app counts ([...name].length), so a name the app
 * accepts is never refused here for its length.
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

function isInklingRow(row: IdentityRow): boolean {
  return row.metadata?.client === INKLING_CLIENT;
}

export class InklingService {
  constructor(private readonly supabase: SupabaseClient) {}

  /** The person's inklings in this workspace, oldest first. */
  async list(scope: InklingScope): Promise<Inkling[]> {
    const { data, error } = await this.supabase
      .from('agent_identities')
      .select(IDENTITY_COLUMNS)
      .eq('user_id', scope.userId)
      .eq('workspace_id', scope.workspaceId)
      .eq('metadata->>client', INKLING_CLIENT)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw new Error(`Failed to list inklings: ${error.message}`);
    const rows = (data ?? []) as IdentityRow[];
    if (rows.length === 0) return [];

    // The metadata tag alone is not birth through this flow: the lineage
    // must say self_serve too.
    const born = await this.selfServeLineages(
      scope.userId,
      rows.map((r) => r.id)
    );
    return rows.filter((r) => born.has(r.id)).map(toInkling);
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
    const prior = await this.findByAwakenRequest(scope.userId, clientRequestId);
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
          awakenRequestId: clientRequestId,
          named: false,
        },
      },
      p_kindle_method: 'self_serve',
    });

    const childSbId = (lineage as { child_sb_id?: string | null } | null)?.child_sb_id;
    if (error || !childSbId) {
      // The redemption rolled back whole, so this token is still active.
      await this.revokeToken(token.id);
      // A concurrent retry of the same awakening won the index: its inkling
      // is the answer to this request too.
      const winner = await this.findByAwakenRequest(scope.userId, clientRequestId);
      if (winner) return this.replay(winner, scope);
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
