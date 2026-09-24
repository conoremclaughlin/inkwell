/**
 * Browser companion grants — the DB-backed authority behind a `browser_client`
 * token.
 *
 * The token proves who minted it. This proves the user has not since said no.
 * They are separate because a JWT cannot be withdrawn: admin auth Tier 1 is a
 * local `jwt.verify` with no DB read, so whatever "Disconnect" writes, an
 * already-issued token stays cryptographically valid for its whole lifetime.
 * Every companion request therefore re-reads the grant.
 *
 * All liveness is evaluated at read time. Nothing here rides a sweep — see the
 * migration for why a heartbeat-gated reaper would have made expiry untestable
 * in the exact environment this gets developed in.
 */

import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../data/supabase/types';
import { logger } from '../utils/logger';
import type { BrowserClientTokenPayload } from '../auth/browser-client-tokens';

/**
 * Local types for the two new tables and the RPC.
 *
 * The generated `Database` type does not know them until the migration is
 * applied against a project and `generate_typescript_types` is re-run. Adding
 * them by hand to the generated file would compile today and be silently
 * reverted by the next regeneration, breaking the build at a distance — so
 * they are declared here and the client is narrowed once, in the constructor.
 * When the real generated types land, this block deletes and the cast with it.
 */
interface BrowserCompanionGrantRow {
  id: string;
  user_id: string;
  workspace_id: string;
  installation_id: string;
  installation_commitment: string;
  pairing_code_hash: string | null;
  pairing_code_expires_at: string | null;
  pairing_secret_hash: string | null;
  claimed_at: string | null;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface BrowserCompanionGrantEventRow {
  id: string;
  grant_id: string;
  /** Mirrors the CHECK constraint on the column — keep the two in step. */
  event: 'created' | 'claimed' | 'token_issued' | 'refused' | 'revoked';
  reason_code: string | null;
  at: string;
}

interface ConsumeGrantResult {
  outcome: string;
  reason_code: GrantRefusalReason | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * Access to the two new tables goes through an untyped client handle.
 *
 * Narrowing `SupabaseClient` to a locally-declared schema was the first
 * attempt and supabase-js 2.99 resolves `.from()` on a hand-written schema to
 * `never`, so every call site fails to compile. Rather than widen anything in
 * the generated types to make that work, the handle is untyped **here only**
 * and every result is immediately annotated with the interfaces above — the
 * row shapes are still stated, and they are stated in one file next to the
 * queries that depend on them. This whole block goes away when the migration
 * is applied and the generated types carry the tables for real.
 */
type UntypedTableClient = Pick<SupabaseClient, 'from' | 'rpc'>;

/** Machine reason codes. Never a sentence — prose is rendered from these. */
export type GrantRefusalReason =
  | 'grant_not_found'
  | 'grant_unclaimed'
  | 'user_mismatch'
  | 'workspace_mismatch'
  | 'installation_mismatch'
  | 'grant_revoked'
  | 'grant_expired';

export interface GrantState {
  expiresAt: string;
  revokedAt: string | null;
}

export type GrantCheck =
  | ({ ok: true } & GrantState)
  | { ok: false; reason: GrantRefusalReason; state?: Partial<GrantState> };

/** Wall-clock ceiling on a grant. */
export const GRANT_LIFETIME_SECONDS = 12 * 60 * 60;
/** How long a pairing code stays claimable. */
export const PAIRING_CODE_LIFETIME_SECONDS = 10 * 60;

/**
 * The installation commitment is a sha256 hex digest and is checked for that
 * shape before it is stored. Not a security property on its own — the server
 * cannot tell a real digest from 64 random hex characters — but it refuses the
 * two things that would silently disable the binding: an empty string, and a
 * caller that sends the secret itself where the commitment belongs.
 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isInstallationCommitment(value: string): boolean {
  return SHA256_HEX.test(value);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Pairing code: what the dashboard shows and a human transcribes.
 *
 * Same alphabet the mobile pairing code uses — 32 symbols with none of 0/O/1/I
 * — for the same reason: it gets read off a screen.
 */
const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_LENGTH = 12;

export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    // randomInt uses rejection sampling, so it stays unbiased if the alphabet
    // changes length.
    code += PAIRING_CODE_ALPHABET[crypto.randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}

export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-9]/g, '');
}

/** The long-lived secret the extension keeps in `storage.session`. */
function generatePairingSecret(): string {
  return `ink-bc-${crypto.randomBytes(32).toString('hex')}`;
}

export class BrowserCompanionGrantService {
  private readonly client: UntypedTableClient;

  constructor(client: SupabaseClient<Database>) {
    this.client = client as unknown as UntypedTableClient;
  }

  /**
   * The check every companion request makes.
   *
   * One RPC: identity cross-check plus liveness under a single row lock.
   *
   * `requireLive: false` is the revocation exemption. It drops exactly the two
   * liveness conditions and keeps every identity one, so a caller still has to
   * prove the grant is theirs from the installation it was bound to. Only
   * `/auth/revoke` passes it, and that handler reads nothing — see the
   * function body in the migration for why an expired grant must stay
   * revocable at all.
   */
  async checkGrant(
    payload: BrowserClientTokenPayload,
    options: { requireLive: boolean }
  ): Promise<GrantCheck> {
    const { data, error } = await this.client
      .rpc('browser_companion_consume_grant', {
        p_grant_id: payload.grantId,
        p_user_id: payload.sub,
        p_workspace_id: payload.workspaceId,
        p_installation_id: payload.installationId,
        p_require_live: options.requireLive,
      })
      .maybeSingle();

    if (error) {
      // Fail closed. A DB error is not permission — but say which it was, so a
      // refusal caused by an outage is never read back as a revoked grant.
      logger.error('Browser companion grant check failed', {
        grantId: payload.grantId,
        error: error.message,
      });
      throw new Error('grant_check_unavailable');
    }

    const row = data as ConsumeGrantResult | null;

    if (!row) return { ok: false, reason: 'grant_not_found' };

    if (row.outcome !== 'allowed') {
      return {
        ok: false,
        reason: row.reason_code ?? 'grant_not_found',
        state: {
          ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
          ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
        },
      };
    }

    return {
      ok: true,
      expiresAt: row.expires_at ?? new Date().toISOString(),
      revokedAt: row.revoked_at,
    };
  }

  /**
   * Mint a pairing code for a signed-in user. Called from the dashboard, which
   * has already authenticated as that user through admin auth.
   *
   * Returns the plaintext code exactly once. Only its hash is stored.
   */
  async createPairingCode(params: {
    userId: string;
    workspaceId: string;
    installationId: string;
    /** sha256 hex of a secret the installation generated and never sent. */
    installationCommitment: string;
  }): Promise<{ grantId: string; pairingCode: string; pairingCodeExpiresAt: string }> {
    if (!isInstallationCommitment(params.installationCommitment)) {
      throw new Error('installation_commitment_invalid');
    }

    const pairingCode = generatePairingCode();
    const now = Date.now();
    const pairingCodeExpiresAt = new Date(now + PAIRING_CODE_LIFETIME_SECONDS * 1000).toISOString();

    const { data, error } = await this.client
      .from('browser_companion_grants')
      .insert({
        user_id: params.userId,
        workspace_id: params.workspaceId,
        installation_id: params.installationId,
        installation_commitment: params.installationCommitment,
        pairing_code_hash: sha256(pairingCode),
        pairing_code_expires_at: pairingCodeExpiresAt,
        expires_at: new Date(now + GRANT_LIFETIME_SECONDS * 1000).toISOString(),
      })
      .select('id')
      .single();

    const created = data as Pick<BrowserCompanionGrantRow, 'id'> | null;
    if (error || !created) {
      logger.error('Failed to create browser companion pairing code', { error: error?.message });
      throw new Error('pairing_code_create_failed');
    }

    await this.recordEvent(created.id, 'created');

    return { grantId: created.id, pairingCode, pairingCodeExpiresAt };
  }

  /**
   * Claim a pairing code, binding the grant to an installation and returning
   * the pairing secret.
   *
   * Two properties, both in the UPDATE's own predicate rather than in a check
   * above it:
   *
   * **Single-use.** The statement matches on `pairing_code_hash` and clears it
   * in the same breath, so of two racing claimers exactly one gets a secret
   * and there is no read-then-write window. Single-use is therefore a property
   * of the code, not of this endpoint — the distinction the mobile pairing
   * path gets wrong, where the delete-returning lives on the claim route and
   * the code stays exchangeable at `POST /token`.
   *
   * **The claimer is the installation that started it.** `installationSecret`
   * is matched against the commitment stored at issuance. Dropping this and
   * matching on `installation_id` alone would bind nothing: the code is read
   * off a screen and the installation id is handed to the dashboard to mint
   * against, so an observer of both would have had everything needed to claim
   * a code it did not initiate.
   */
  async claimPairingCode(params: {
    pairingCode: string;
    installationId: string;
    installationSecret: string;
  }): Promise<
    | { ok: true; grantId: string; pairingSecret: string; expiresAt: string }
    | { ok: false; reason: 'invalid_or_expired_code' }
  > {
    const pairingSecret = generatePairingSecret();

    const { data, error } = await this.client
      .from('browser_companion_grants')
      .update({
        pairing_code_hash: null,
        pairing_secret_hash: sha256(pairingSecret),
        claimed_at: new Date().toISOString(),
      })
      .eq('pairing_code_hash', sha256(normalizePairingCode(params.pairingCode)))
      .eq('installation_id', params.installationId)
      .eq('installation_commitment', sha256(params.installationSecret))
      .gt('pairing_code_expires_at', new Date().toISOString())
      .is('claimed_at', null)
      .is('revoked_at', null)
      .select('id, expires_at')
      .maybeSingle();

    if (error) {
      logger.error('Browser companion pairing claim failed', { error: error.message });
      throw new Error('pairing_claim_failed');
    }

    const claimed = data as Pick<BrowserCompanionGrantRow, 'id' | 'expires_at'> | null;
    if (!claimed) return { ok: false, reason: 'invalid_or_expired_code' };

    await this.recordEvent(claimed.id, 'claimed');

    return {
      ok: true,
      grantId: claimed.id,
      pairingSecret,
      expiresAt: claimed.expires_at,
    };
  }

  /**
   * Resolve a pairing secret to the grant it belongs to, so a short-lived JWT
   * can be minted for it.
   *
   * Liveness is re-checked through the same RPC every request uses, rather
   * than re-derived here: one enforcement point, one set of reason codes.
   */
  async resolveGrantForSecret(params: {
    pairingSecret: string;
    installationId: string;
  }): Promise<
    | { ok: true; grantId: string; userId: string; workspaceId: string }
    | { ok: false; reason: 'invalid_secret' }
  > {
    const { data, error } = await this.client
      .from('browser_companion_grants')
      .select('id, user_id, workspace_id')
      .eq('pairing_secret_hash', sha256(params.pairingSecret))
      .eq('installation_id', params.installationId)
      .maybeSingle();

    if (error) {
      logger.error('Browser companion secret lookup failed', { error: error.message });
      throw new Error('grant_check_unavailable');
    }

    const grant = data as Pick<BrowserCompanionGrantRow, 'id' | 'user_id' | 'workspace_id'> | null;
    if (!grant) return { ok: false, reason: 'invalid_secret' };

    return {
      ok: true,
      grantId: grant.id,
      userId: grant.user_id,
      workspaceId: grant.workspace_id,
    };
  }

  /** Idempotent: revoking an already-revoked grant is a success, not an error. */
  async revokeGrant(grantId: string, reason = 'user_revoked'): Promise<void> {
    const { error } = await this.client
      .from('browser_companion_grants')
      .update({
        revoked_at: new Date().toISOString(),
        revoked_reason: reason,
        pairing_secret_hash: null,
        pairing_code_hash: null,
      })
      .eq('id', grantId)
      .is('revoked_at', null);

    if (error) {
      logger.error('Browser companion revoke failed', { grantId, error: error.message });
      throw new Error('grant_revoke_failed');
    }

    await this.recordEvent(grantId, 'revoked', reason);
  }

  async recordEvent(
    grantId: string,
    event: BrowserCompanionGrantEventRow['event'],
    reasonCode?: string
  ): Promise<void> {
    const row: Pick<BrowserCompanionGrantEventRow, 'grant_id' | 'event'> &
      Partial<Pick<BrowserCompanionGrantEventRow, 'reason_code'>> = {
      grant_id: grantId,
      event,
      ...(reasonCode ? { reason_code: reasonCode } : {}),
    };

    const { error } = await this.client.from('browser_companion_grant_events').insert(row);

    // An audit write failing must not take the request with it, but it must
    // not pass silently either — a gap in this log is the thing that makes a
    // later incident unreconstructable.
    if (error) {
      logger.error('Failed to record browser companion grant event', {
        grantId,
        event,
        error: error.message,
      });
    }
  }
}
