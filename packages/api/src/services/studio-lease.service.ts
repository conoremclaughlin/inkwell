/**
 * Studio Lease Service
 *
 * A studio is a git worktree and can host exactly one work-thread at a time
 * (spec:trigger-studio-routing v12 §Occupancy). The lease jsonb on studios is
 * the authoritative occupancy record; this service owns its lifecycle.
 *
 * Every transition is programmatic — the holder never has to opt in:
 *   - acquire: at route resolution, via atomic CAS (UPDATE ... WHERE lease IS NULL)
 *   - renew:   heartbeatAt bumped by CLI lifecycle hooks (per prompt/stop) and
 *              by the sweep for sessions with a live in-process run
 *   - release: on session end, thread close, or close_studio — at the real
 *              terminal boundary (deferred while an in-process run is live)
 *   - expire:  heartbeatAt stale beyond LEASE_STALE_MS → claimed, rescued, released
 *
 * Safety invariants (PR #492 review, Lumen):
 *   - Every read and CAS is scoped to the owning user. A studio UUID alone
 *     never authorizes a lease mutation.
 *   - Reclaim and expiry FENCE FIRST, RESCUE SECOND: the exact prior lease
 *     (including heartbeatAt) is CAS-claimed before any git command runs, so
 *     a holder that renews concurrently defeats the reclaim, and a losing
 *     reclaimer never stashes a live holder's work.
 *   - If rescue fails after claiming, the studio is quarantined (reclaim:
 *     claim released, caller diverts to overflow; expiry: sweeper marker kept,
 *     retried next sweep) — an unrescued worktree is never handed out.
 *
 * Lease events (studio_lease_events) answer the four occupancy questions from
 * recorded data: why grabbed (reason = routing tier), how long held (heldMs),
 * what was happening (threadKey/sessionId), how released (event + final state).
 * Renewals are not logged; they would drown the signal.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../data/supabase/types';
import { hasActiveRun } from './sessions/active-runs';
import { resolveIdentityId } from '../auth/resolve-identity';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

export interface StudioLease {
  sessionId: string;
  threadKey: string;
  agentId: string;
  /** Canonical identity UUID (agent_identities.id); agentId is the display slug. */
  sbId?: string | null;
  acquiredAt: string;
  heartbeatAt: string;
  /** Routing tier that assigned the studio (visibility: "why is someone grabbing it"). */
  reason?: string;
}

/** No heartbeat for this long → the lease is stale and may be reclaimed. */
export const LEASE_STALE_MS = 30 * 60 * 1000;

/** Ephemeral overflow studios expire this long after creation if never re-leased. */
export const EPHEMERAL_STUDIO_TTL_MS = 72 * 60 * 60 * 1000;

/** sessionId prefix for the sweeper's transitional claim during expiry. */
const SWEEP_CLAIM_PREFIX = 'lease-sweep:';

export type LeaseEventType =
  | 'acquired'
  | 'released'
  | 'expired'
  | 'reclaimed'
  | 'overflow'
  | 'conflict';

export interface AcquireRequest {
  studioId: string;
  sessionId: string;
  threadKey: string;
  agentId: string;
  userId: string;
  /** Routing tier / provenance, recorded on the lease and the event. */
  reason?: string;
}

export type AcquireResult =
  | { acquired: true; lease: StudioLease; reclaimedFrom?: StudioLease }
  | { acquired: false; holder: StudioLease | null };

export interface WorktreeFinalState {
  branch?: string;
  commit?: string;
  dirty?: boolean;
  /** Set when a dirty tree was stashed; the stash commit SHA survives stash drops. */
  rescueStashSha?: string;
  error?: string;
}

/** Did a rescue-mode capture actually secure the tree? */
export function rescueSucceeded(state: WorktreeFinalState): boolean {
  if (state.error) return false;
  if (state.dirty && !state.rescueStashSha) return false;
  return true;
}

export function isLeaseStale(lease: StudioLease, nowMs: number = Date.now()): boolean {
  const heartbeat = Date.parse(lease.heartbeatAt || lease.acquiredAt);
  if (Number.isNaN(heartbeat)) return true;
  return nowMs - heartbeat > LEASE_STALE_MS;
}

function parseLease(raw: Json | null | undefined): StudioLease | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.sessionId !== 'string' || typeof obj.threadKey !== 'string') return null;
  return {
    sessionId: obj.sessionId,
    threadKey: obj.threadKey,
    agentId: typeof obj.agentId === 'string' ? obj.agentId : '',
    sbId: typeof obj.sbId === 'string' ? obj.sbId : null,
    acquiredAt: typeof obj.acquiredAt === 'string' ? obj.acquiredAt : '',
    heartbeatAt: typeof obj.heartbeatAt === 'string' ? obj.heartbeatAt : '',
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
  };
}

/**
 * Capture the state of a worktree, taking the safe ref Conor asked for:
 * branch + HEAD always; a stash (with its commit SHA) when the tree is dirty
 * and `rescue` is set. Never throws — a git failure is recorded in the result
 * and callers decide whether it blocks (teardown, reclaim) or not (bookkeeping).
 */
export async function captureWorktreeState(
  worktreePath: string,
  opts: { rescue?: boolean; rescueLabel?: string } = {}
): Promise<WorktreeFinalState> {
  const state: WorktreeFinalState = {};
  try {
    const [branch, commit, status] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath }),
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: worktreePath }),
    ]);
    state.branch = branch.stdout.trim();
    state.commit = commit.stdout.trim();
    state.dirty = status.stdout.trim().length > 0;

    if (state.dirty && opts.rescue) {
      const label = `ink-lease-rescue:${opts.rescueLabel || 'unknown'}:${new Date().toISOString()}`;
      await execFileAsync('git', ['stash', 'push', '--include-untracked', '-m', label], {
        cwd: worktreePath,
      });
      const { stdout: stashSha } = await execFileAsync('git', ['rev-parse', 'stash@{0}'], {
        cwd: worktreePath,
      });
      state.rescueStashSha = stashSha.trim();
      logger.warn('[StudioLease] Rescue stash taken', {
        worktreePath,
        label,
        stashSha: state.rescueStashSha,
      });
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    logger.warn('[StudioLease] Failed to capture worktree state', {
      worktreePath,
      error: state.error,
    });
  }
  return state;
}

export class StudioLeaseService {
  constructor(private supabase: SupabaseClient<Database>) {}

  async getLease(
    studioId: string,
    userId?: string
  ): Promise<{ lease: StudioLease | null; worktreePath?: string; ephemeral?: boolean } | null> {
    let query = this.supabase
      .from('studios')
      .select('lease, worktree_path, ephemeral')
      .eq('id', studioId);
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query.maybeSingle();
    if (error) {
      logger.warn('[StudioLease] getLease failed', { studioId, error: error.message });
      return null;
    }
    if (!data) return null;
    return {
      lease: parseLease(data.lease),
      worktreePath: data.worktree_path,
      ephemeral: data.ephemeral,
    };
  }

  /**
   * Acquire the studio for a (session, thread), atomically.
   *
   * CAS ladder:
   *   1. lease IS NULL          → take it
   *   2. same threadKey         → adopt (leases are per-thread; a newer session
   *                               on the same thread takes the lease over)
   *   3. stale foreign lease    → CLAIM first (CAS guarded on the exact holder
   *                               including heartbeatAt — a concurrent renewal
   *                               defeats the reclaim), THEN rescue. Rescue
   *                               failure releases the claim and refuses.
   *   4. fresh foreign lease    → refuse; caller diverts to overflow
   *
   * Every CAS is additionally guarded on user_id — a studio UUID alone never
   * authorizes a mutation.
   */
  async acquire(req: AcquireRequest): Promise<AcquireResult> {
    const now = new Date().toISOString();
    const sbId = await this.resolveSbId(req.userId, req.agentId);
    const lease: StudioLease = {
      sessionId: req.sessionId,
      threadKey: req.threadKey,
      agentId: req.agentId,
      sbId,
      acquiredAt: now,
      heartbeatAt: now,
      reason: req.reason,
    };

    // 1) Vacant studio.
    if (await this.casVacant(req, lease)) {
      await this.logEvent(req.userId, req.studioId, 'acquired', {
        sessionId: req.sessionId,
        threadKey: req.threadKey,
        agentId: req.agentId,
        sbId,
        reason: req.reason,
      });
      return { acquired: true, lease };
    }

    // Occupied (or a race) — read the current holder, user-scoped.
    const current = await this.getLease(req.studioId, req.userId);
    if (!current) {
      // Studio doesn't exist for this user — refuse; never treat an
      // unverifiable studio as acquirable.
      logger.warn('[StudioLease] Acquire refused — studio not found for user', {
        studioId: req.studioId,
        userId: req.userId,
      });
      return { acquired: false, holder: null };
    }

    const holder = current.lease;
    if (!holder) {
      // Released between our CAS and the read — one retry.
      if (await this.casVacant(req, lease)) {
        await this.logEvent(req.userId, req.studioId, 'acquired', {
          sessionId: req.sessionId,
          threadKey: req.threadKey,
          agentId: req.agentId,
          sbId,
          reason: req.reason,
        });
        return { acquired: true, lease };
      }
      const reread = await this.getLease(req.studioId, req.userId);
      if (reread?.lease) {
        return this.resolveOccupied(req, lease, reread.lease, reread.worktreePath);
      }
      return { acquired: false, holder: null };
    }

    return this.resolveOccupied(req, lease, holder, current.worktreePath);
  }

  private async casVacant(req: AcquireRequest, lease: StudioLease): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('studios')
      .update({ lease: lease as unknown as Json })
      .eq('id', req.studioId)
      .eq('user_id', req.userId)
      .is('lease', null)
      .select('id');
    if (error) {
      logger.warn('[StudioLease] acquire CAS failed', {
        studioId: req.studioId,
        error: error.message,
      });
      return false;
    }
    return Boolean(data?.length);
  }

  private async resolveOccupied(
    req: AcquireRequest,
    lease: StudioLease,
    holder: StudioLease,
    worktreePath?: string
  ): Promise<AcquireResult> {
    const now = new Date().toISOString();

    // 2) Same thread — the lease follows the thread, not the session.
    if (holder.threadKey === req.threadKey) {
      const adopted: StudioLease = {
        ...holder,
        sessionId: req.sessionId,
        agentId: req.agentId,
        sbId: lease.sbId ?? holder.sbId,
        heartbeatAt: now,
        reason: req.reason ?? holder.reason,
      };
      const { data } = await this.supabase
        .from('studios')
        .update({ lease: adopted as unknown as Json })
        .eq('id', req.studioId)
        .eq('user_id', req.userId)
        .eq('lease->>threadKey', req.threadKey)
        .eq('lease->>sessionId', holder.sessionId)
        .select('id');
      if (data?.length) {
        return { acquired: true, lease: adopted };
      }
      // Lost an adopt race to a sibling on the same thread — that's still our
      // thread holding the studio; report acquired with the current holder.
      const reread = await this.getLease(req.studioId, req.userId);
      if (reread?.lease?.threadKey === req.threadKey) {
        return { acquired: true, lease: reread.lease };
      }
      return { acquired: false, holder: reread?.lease ?? holder };
    }

    // 3) Stale foreign lease — fence first, rescue second.
    if (isLeaseStale(holder)) {
      // A live in-process run means the session is mid-turn and simply hasn't
      // heartbeated — renew on its behalf instead of stealing the worktree.
      if (hasActiveRun(holder.sessionId)) {
        await this.renewBySession(holder.sessionId, req.userId);
        return { acquired: false, holder };
      }

      // CLAIM: CAS to our lease guarded on the exact prior holder INCLUDING
      // heartbeatAt. A renewal between our read and this write changes
      // heartbeatAt, so the claim loses and no git command ever runs against
      // the live holder's worktree. Once won, the old holder is fenced out —
      // its renewals no longer match lease->>sessionId.
      const { data: claimed } = await this.supabase
        .from('studios')
        .update({ lease: lease as unknown as Json })
        .eq('id', req.studioId)
        .eq('user_id', req.userId)
        .eq('lease->>sessionId', holder.sessionId)
        .eq('lease->>acquiredAt', holder.acquiredAt)
        .eq('lease->>heartbeatAt', holder.heartbeatAt)
        .select('id');

      if (!claimed?.length) {
        // Lost the claim — holder renewed or someone else reclaimed first.
        const reread = await this.getLease(req.studioId, req.userId);
        return { acquired: false, holder: reread?.lease ?? holder };
      }

      // We hold the studio; now take the safe ref.
      let rescue: WorktreeFinalState | undefined;
      if (worktreePath) {
        rescue = await captureWorktreeState(worktreePath, {
          rescue: true,
          rescueLabel: holder.threadKey,
        });
        if (!rescueSucceeded(rescue)) {
          // QUARANTINE: an unrescued worktree is never handed out. Release
          // our claim and refuse; the caller diverts to overflow. The dirty
          // work stays untouched in place.
          logger.error('[StudioLease] Reclaim aborted — rescue failed; quarantining studio', {
            studioId: req.studioId,
            previousHolder: { sessionId: holder.sessionId, threadKey: holder.threadKey },
            rescue,
          });
          await this.supabase
            .from('studios')
            .update({ lease: null })
            .eq('id', req.studioId)
            .eq('user_id', req.userId)
            .eq('lease->>sessionId', req.sessionId)
            .eq('lease->>acquiredAt', lease.acquiredAt)
            .select('id');
          await this.logEvent(req.userId, req.studioId, 'conflict', {
            sessionId: req.sessionId,
            threadKey: req.threadKey,
            agentId: req.agentId,
            sbId: lease.sbId,
            reason: 'reclaim-aborted-rescue-failed',
            detail: {
              previousHolder: holder as unknown as Json,
              rescue: rescue as unknown as Json,
            },
          });
          return { acquired: false, holder };
        }
      }

      logger.warn('[StudioLease] Reclaimed stale lease', {
        studioId: req.studioId,
        from: { sessionId: holder.sessionId, threadKey: holder.threadKey },
        to: { sessionId: req.sessionId, threadKey: req.threadKey },
        staleSince: holder.heartbeatAt,
        rescue,
      });
      await this.logEvent(req.userId, req.studioId, 'reclaimed', {
        sessionId: req.sessionId,
        threadKey: req.threadKey,
        agentId: req.agentId,
        sbId: lease.sbId,
        reason: `stale since ${holder.heartbeatAt || holder.acquiredAt}`,
        detail: {
          previousHolder: holder as unknown as Json,
          rescue: (rescue ?? null) as unknown as Json,
        },
      });
      return { acquired: true, lease, reclaimedFrom: holder };
    }

    // 4) Fresh foreign lease — refuse; the caller diverts to overflow.
    return { acquired: false, holder };
  }

  /**
   * Bump heartbeatAt for whichever studio this session holds. Called from the
   * CLI lifecycle hook route on every prompt/stop, and by the sweep for
   * sessions with a live in-process run. Cheap no-op when the session holds
   * nothing.
   */
  async renewBySession(sessionId: string, userId?: string): Promise<boolean> {
    let query = this.supabase
      .from('studios')
      .select('id, user_id, lease')
      .eq('lease->>sessionId', sessionId);
    if (userId) query = query.eq('user_id', userId);
    const { data } = await query.limit(1).maybeSingle();
    const lease = parseLease(data?.lease);
    if (!data || !lease) return false;

    const renewed: StudioLease = { ...lease, heartbeatAt: new Date().toISOString() };
    const { data: updated } = await this.supabase
      .from('studios')
      .update({ lease: renewed as unknown as Json })
      .eq('id', data.id)
      .eq('user_id', data.user_id)
      .eq('lease->>sessionId', sessionId)
      .eq('lease->>heartbeatAt', lease.heartbeatAt)
      .select('id');
    return Boolean(updated?.length);
  }

  /**
   * Release whatever this session holds — but only once the session is truly
   * terminal: while an in-process run is still executing in the worktree,
   * release is deferred to the run boundary (SessionService clears the active
   * run and calls releaseBySession then). This is the guard that stops
   * end_session-from-inside-a-turn from handing the studio to another thread
   * while the holder's process is still cd'd into it.
   */
  async releaseUnlessRunning(
    sessionId: string,
    opts: { userId?: string; reason?: string } = {}
  ): Promise<boolean> {
    if (hasActiveRun(sessionId)) {
      logger.info('[StudioLease] Release deferred — session still has a live in-process run', {
        sessionId,
        reason: opts.reason,
      });
      return false;
    }
    return this.releaseBySession(sessionId, opts);
  }

  /**
   * Release whatever this session holds, immediately. Captures final worktree
   * state (branch/commit/dirty) and stamps it into the owning thread's
   * metadata so "what did they leave behind" is answerable after the fact.
   */
  async releaseBySession(
    sessionId: string,
    opts: { userId?: string; reason?: string } = {}
  ): Promise<boolean> {
    let query = this.supabase
      .from('studios')
      .select('id, user_id, lease, worktree_path')
      .eq('lease->>sessionId', sessionId);
    if (opts.userId) query = query.eq('user_id', opts.userId);
    const { data } = await query.limit(1).maybeSingle();
    const lease = parseLease(data?.lease);
    if (!data || !lease) return false;

    return this.releaseStudio(data.id, data.user_id, lease, data.worktree_path, {
      event: 'released',
      reason: opts.reason ?? 'session-end',
    });
  }

  /**
   * Release whatever lease a studio holds, regardless of holder. Wired into
   * close_studio — closing the worktree is a terminal act for its occupant.
   */
  async releaseByStudio(
    studioId: string,
    opts: { userId: string; reason?: string }
  ): Promise<boolean> {
    const { data } = await this.supabase
      .from('studios')
      .select('id, user_id, lease, worktree_path')
      .eq('id', studioId)
      .eq('user_id', opts.userId)
      .not('lease', 'is', null)
      .maybeSingle();
    const lease = parseLease(data?.lease);
    if (!data || !lease) return false;

    return this.releaseStudio(data.id, data.user_id, lease, data.worktree_path, {
      event: 'released',
      reason: opts.reason ?? 'studio-closed',
    });
  }

  /**
   * Release every studio this user's thread holds. Wired into close_thread —
   * the work unit completing is what lets studios go.
   */
  async releaseByThread(
    userId: string,
    threadKey: string,
    opts: { reason?: string } = {}
  ): Promise<number> {
    const { data } = await this.supabase
      .from('studios')
      .select('id, user_id, lease, worktree_path')
      .eq('user_id', userId)
      .eq('lease->>threadKey', threadKey);
    if (!data?.length) return 0;

    let released = 0;
    for (const row of data) {
      const lease = parseLease(row.lease);
      if (!lease) continue;
      const ok = await this.releaseStudio(row.id, row.user_id, lease, row.worktree_path, {
        event: 'released',
        reason: opts.reason ?? 'thread-closed',
      });
      if (ok) released += 1;
    }
    return released;
  }

  /**
   * Normal release: CAS-clear first (guarded on the exact lease including
   * heartbeatAt and user), capture final state second. The capture here is
   * read-only bookkeeping — the holder ended on its own terms, so nothing is
   * stashed and a capture failure never blocks the release.
   */
  private async releaseStudio(
    studioId: string,
    userId: string,
    lease: StudioLease,
    worktreePath: string | null,
    opts: { event: 'released'; reason: string }
  ): Promise<boolean> {
    const { data } = await this.supabase
      .from('studios')
      .update({ lease: null })
      .eq('id', studioId)
      .eq('user_id', userId)
      .eq('lease->>sessionId', lease.sessionId)
      .eq('lease->>acquiredAt', lease.acquiredAt)
      .eq('lease->>heartbeatAt', lease.heartbeatAt)
      .select('id');
    if (!data?.length) return false;

    const finalState = worktreePath ? await captureWorktreeState(worktreePath) : undefined;

    const heldMs = Date.now() - Date.parse(lease.acquiredAt);
    await this.logEvent(userId, studioId, opts.event, {
      sessionId: lease.sessionId,
      threadKey: lease.threadKey,
      agentId: lease.agentId,
      sbId: lease.sbId,
      reason: opts.reason,
      detail: {
        heldMs: Number.isNaN(heldMs) ? null : heldMs,
        finalState: (finalState ?? null) as unknown as Json,
      },
    });

    await this.stampThreadFinalState(userId, lease.threadKey, studioId, finalState);
    return true;
  }

  /**
   * Stamp the released worktree's final state (branch/commit/dirty) into the
   * thread's metadata so the thread records where its work ended up.
   */
  private async stampThreadFinalState(
    userId: string,
    threadKey: string,
    studioId: string,
    finalState?: WorktreeFinalState
  ): Promise<void> {
    if (!finalState || finalState.error) return;
    try {
      const { data: thread } = await this.supabase
        .from('inbox_threads')
        .select('id, metadata')
        .eq('user_id', userId)
        .eq('thread_key', threadKey)
        .maybeSingle();
      if (!thread) return;

      const existing =
        thread.metadata && typeof thread.metadata === 'object' && !Array.isArray(thread.metadata)
          ? (thread.metadata as Record<string, Json>)
          : {};
      await this.supabase
        .from('inbox_threads')
        .update({
          metadata: {
            ...existing,
            leaseFinalState: {
              studioId,
              branch: finalState.branch ?? null,
              commit: finalState.commit ?? null,
              dirty: finalState.dirty ?? null,
              rescueStashSha: finalState.rescueStashSha ?? null,
              releasedAt: new Date().toISOString(),
            },
          } as Json,
        })
        .eq('id', thread.id);
    } catch (err) {
      logger.warn('[StudioLease] Failed to stamp thread final state', {
        threadKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Heartbeat sweep: expire stale leases with the same fence-then-rescue
   * discipline as reclaim. For each stale row:
   *
   *   1. Live in-process run? Renew on the holder's behalf — a long agentic
   *      turn is not a crash.
   *   2. CAS-claim the lease to a sweeper marker, guarded on the exact holder
   *      including heartbeatAt. A concurrent renewal defeats the claim.
   *   3. Rescue the worktree. Success → clear the marker, log 'expired'.
   *      Failure → the marker STAYS (quarantine): it blocks new acquirers,
   *      goes stale itself in LEASE_STALE_MS, and the next sweep retries.
   */
  async sweepExpiredLeases(): Promise<{ expired: number; renewed: number; quarantined: number }> {
    const { data, error } = await this.supabase
      .from('studios')
      .select('id, user_id, lease, worktree_path')
      .not('lease', 'is', null);
    if (error || !data?.length) return { expired: 0, renewed: 0, quarantined: 0 };

    let expired = 0;
    let renewed = 0;
    let quarantined = 0;
    for (const row of data) {
      const lease = parseLease(row.lease);
      if (!lease || !isLeaseStale(lease)) continue;

      if (hasActiveRun(lease.sessionId)) {
        const ok = await this.renewBySession(lease.sessionId, row.user_id);
        if (ok) renewed += 1;
        continue;
      }

      const now = new Date().toISOString();
      const marker: StudioLease = {
        sessionId: `${SWEEP_CLAIM_PREFIX}${lease.sessionId}`,
        threadKey: lease.threadKey,
        agentId: lease.agentId,
        sbId: lease.sbId,
        acquiredAt: lease.acquiredAt, // preserved so heldMs spans the real hold
        heartbeatAt: now,
        reason: 'expiry-claim',
      };
      const { data: claimed } = await this.supabase
        .from('studios')
        .update({ lease: marker as unknown as Json })
        .eq('id', row.id)
        .eq('user_id', row.user_id)
        .eq('lease->>sessionId', lease.sessionId)
        .eq('lease->>acquiredAt', lease.acquiredAt)
        .eq('lease->>heartbeatAt', lease.heartbeatAt)
        .select('id');
      if (!claimed?.length) continue; // renewed or released concurrently — not ours to touch

      const rescue = row.worktree_path
        ? await captureWorktreeState(row.worktree_path, {
            rescue: true,
            rescueLabel: lease.threadKey,
          })
        : undefined;

      if (rescue && !rescueSucceeded(rescue)) {
        quarantined += 1;
        logger.error('[StudioLease] Expiry rescue failed — studio quarantined until next sweep', {
          studioId: row.id,
          holder: { sessionId: lease.sessionId, threadKey: lease.threadKey },
          rescue,
        });
        await this.logEvent(row.user_id, row.id, 'conflict', {
          sessionId: lease.sessionId,
          threadKey: lease.threadKey,
          agentId: lease.agentId,
          sbId: lease.sbId,
          reason: 'expiry-rescue-failed-quarantined',
          detail: { rescue: rescue as unknown as Json },
        });
        continue;
      }

      await this.supabase
        .from('studios')
        .update({ lease: null })
        .eq('id', row.id)
        .eq('user_id', row.user_id)
        .eq('lease->>sessionId', marker.sessionId)
        .select('id');

      const heldMs = Date.now() - Date.parse(lease.acquiredAt);
      logger.warn('[StudioLease] Lease expired and was released', {
        studioId: row.id,
        sessionId: lease.sessionId,
        threadKey: lease.threadKey,
        staleSince: lease.heartbeatAt || lease.acquiredAt,
        finalState: rescue,
      });
      await this.logEvent(row.user_id, row.id, 'expired', {
        sessionId: lease.sessionId,
        threadKey: lease.threadKey,
        agentId: lease.agentId,
        sbId: lease.sbId,
        reason: `no heartbeat since ${lease.heartbeatAt || lease.acquiredAt}`,
        detail: {
          heldMs: Number.isNaN(heldMs) ? null : heldMs,
          finalState: (rescue ?? null) as unknown as Json,
        },
      });
      await this.stampThreadFinalState(row.user_id, lease.threadKey, row.id, rescue);
      expired += 1;
    }
    return { expired, renewed, quarantined };
  }

  private async resolveSbId(userId: string, agentId: string): Promise<string | null> {
    if (!agentId) return null;
    try {
      return await resolveIdentityId(this.supabase, userId, agentId);
    } catch {
      return null;
    }
  }

  async logEvent(
    userId: string,
    studioId: string,
    event: LeaseEventType,
    opts: {
      sessionId?: string;
      threadKey?: string;
      agentId?: string;
      sbId?: string | null;
      reason?: string;
      detail?: Record<string, Json | null>;
    } = {}
  ): Promise<void> {
    try {
      const sbId =
        opts.sbId !== undefined
          ? opts.sbId
          : opts.agentId
            ? await this.resolveSbId(userId, opts.agentId)
            : null;
      const { error } = await this.supabase.from('studio_lease_events').insert({
        user_id: userId,
        studio_id: studioId,
        session_id: opts.sessionId ?? null,
        thread_key: opts.threadKey ?? null,
        agent_id: opts.agentId ?? null,
        sb_id: sbId ?? null,
        event,
        reason: opts.reason ?? null,
        detail: (opts.detail ?? {}) as Json,
      });
      if (error) {
        logger.warn('[StudioLease] Failed to log lease event', {
          studioId,
          event,
          error: error.message,
        });
      }
    } catch (err) {
      logger.warn('[StudioLease] Failed to log lease event', {
        studioId,
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
