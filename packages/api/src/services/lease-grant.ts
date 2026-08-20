import { logger } from '../utils/logger';
import type { StudioLease } from './studio-lease.service';

/**
 * The lease-grant boundary (spec: trigger-studio-routing §Phase 6b; task
 * c82daba1 work item a).
 *
 * Every grant — vacant take, adoption, recovery handover — goes through the
 * grant_studio_lease RPC, which holds an advisory xact lock on the canonical
 * backing identity (user_id + worktree_path) across the sibling scan AND the
 * CAS. Row-scoped CAS alone admits two writers to one tree, because several
 * studio rows can name the same checkout (resolveMainStudio: one row per SB
 * per path); and scanning siblings before CASing is still racy, because two
 * callers on two rows both pass the scan before either writes. The invariant
 * lives where every path converges.
 *
 * Extracted as a module with exact-shape tests for the same reason as
 * routing-hold.ts: the failure mode of an RPC call site is a silent signature
 * mismatch, and a shape-tolerant test cannot catch it (PR #514 round 4).
 */

/** Minimal structural client: only the RPC surface this boundary touches. */
export interface RpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

export const LEASE_STALE_MS_DEFAULT = 30 * 60 * 1000;

export type GrantOutcome =
  | { outcome: 'granted' }
  | { outcome: 'lost' }
  | { outcome: 'path-conflict'; conflictStudioId: string; conflictHolder: StudioLease | null };

export interface GrantArgs {
  studioId: string;
  userId: string;
  lease: StudioLease;
  /**
   * Exact prior lease (incl. heartbeatAt) for handover/adoption grants;
   * omit for a vacant grant. Mirrors the v14 invariant: grants CAS from a
   * validated snapshot, never from a re-read.
   */
  expectedPrior?: StudioLease | null;
  staleMs?: number;
}

/**
 * Attempt a grant. FAILS CLOSED: any RPC error or unexpected payload reports
 * `lost` — "could not verify the grant happened" must never be treated as
 * acquired (spec v14 invariant 4).
 */
export async function grantStudioLease(client: unknown, args: GrantArgs): Promise<GrantOutcome> {
  // One controlled cast, here at the boundary: SupabaseClient's generic rpc
  // overloads are not structurally assignable to the minimal surface, and the
  // exact call shape below is what the unit tests pin.
  const rpcClient = client as RpcClient;
  const { studioId, userId, lease, expectedPrior, staleMs } = args;
  try {
    const { data, error } = await rpcClient.rpc('grant_studio_lease', {
      p_studio_id: studioId,
      p_user_id: userId,
      p_lease: lease,
      p_expected_prior: expectedPrior ?? null,
      p_stale_ms: staleMs ?? LEASE_STALE_MS_DEFAULT,
    });

    if (error) {
      logger.warn('[LeaseGrant] RPC failed — reporting lost, never granted', {
        studioId,
        error: error.message,
      });
      return { outcome: 'lost' };
    }

    const payload = data as {
      outcome?: string;
      conflictStudioId?: string;
      conflictHolder?: unknown;
    } | null;
    if (payload?.outcome === 'granted') return { outcome: 'granted' };
    if (payload?.outcome === 'path-conflict') {
      return {
        outcome: 'path-conflict',
        conflictStudioId: payload.conflictStudioId ?? '',
        conflictHolder: (payload.conflictHolder as StudioLease | null) ?? null,
      };
    }
    return { outcome: 'lost' };
  } catch (err) {
    logger.warn('[LeaseGrant] RPC threw — reporting lost, never granted', {
      studioId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { outcome: 'lost' };
  }
}
