/**
 * Studio Lease Service
 *
 * A studio is a git worktree and can host exactly one work-thread at a time
 * (spec:trigger-studio-routing v11 §Occupancy). The lease jsonb on studios is
 * the authoritative occupancy record; this service owns its lifecycle.
 *
 * Every transition is programmatic — the holder never has to opt in:
 *   - acquire: at route resolution, via atomic CAS (UPDATE ... WHERE lease IS NULL)
 *   - renew:   heartbeatAt bumped by CLI lifecycle hooks (per prompt/stop) and
 *              by the sweep for sessions with a live in-process run
 *   - release: on session end, thread close, or close_studio
 *   - expire:  heartbeatAt stale beyond LEASE_STALE_MS → rescued, then reclaimed
 *
 * Reclaim never touches a worktree before taking a safe ref: branch + HEAD are
 * recorded, and a dirty tree is stashed (`ink-lease-rescue:<threadKey>:<ts>`)
 * with the stash commit SHA captured so the work survives even a dropped stash
 * entry. Reclaims log loudly — a crashed session losing its studio is an event
 * someone should be able to reconstruct afterwards.
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
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

export interface StudioLease {
  sessionId: string;
  threadKey: string;
  agentId: string;
  acquiredAt: string;
  heartbeatAt: string;
  /** Routing tier that assigned the studio (visibility: "why is someone grabbing it"). */
  reason?: string;
}

/** No heartbeat for this long → the lease is stale and may be reclaimed. */
export const LEASE_STALE_MS = 30 * 60 * 1000;

/** Ephemeral overflow studios expire this long after creation if never re-leased. */
export const EPHEMERAL_STUDIO_TTL_MS = 72 * 60 * 60 * 1000;

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
  | { acquired: false; holder: StudioLease };

export interface WorktreeFinalState {
  branch?: string;
  commit?: string;
  dirty?: boolean;
  /** Set when a dirty tree was stashed; the stash commit SHA survives stash drops. */
  rescueStashSha?: string;
  error?: string;
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
    acquiredAt: typeof obj.acquiredAt === 'string' ? obj.acquiredAt : '',
    heartbeatAt: typeof obj.heartbeatAt === 'string' ? obj.heartbeatAt : '',
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
  };
}

/**
 * Capture the state of a worktree before a lease transition, taking the safe
 * ref Conor asked for: branch + HEAD always; a stash (with its commit SHA)
 * when the tree is dirty and `rescue` is set. Never throws — a git failure is
 * recorded in the result and must not block lease bookkeeping.
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
      logger.warn('[StudioLease] Rescue stash taken before reclaim', {
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
    studioId: string
  ): Promise<{ lease: StudioLease | null; worktreePath?: string; ephemeral?: boolean } | null> {
    const { data, error } = await this.supabase
      .from('studios')
      .select('lease, worktree_path, ephemeral')
      .eq('id', studioId)
      .maybeSingle();
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
   *   3. stale foreign lease    → rescue the worktree, then reclaim guarded on
   *                               the exact old holder (loser of a reclaim race
   *                               changes nothing)
   *   4. fresh foreign lease    → refuse; caller diverts to overflow
   *
   * A lost CAS race falls through to a re-read, so two concurrent acquires
   * converge on one holder and one refusal — never two holders.
   */
  async acquire(req: AcquireRequest): Promise<AcquireResult> {
    const now = new Date().toISOString();
    const lease: StudioLease = {
      sessionId: req.sessionId,
      threadKey: req.threadKey,
      agentId: req.agentId,
      acquiredAt: now,
      heartbeatAt: now,
      reason: req.reason,
    };

    // 1) Vacant studio.
    const { data: took, error: casError } = await this.supabase
      .from('studios')
      .update({ lease: lease as unknown as Json })
      .eq('id', req.studioId)
      .is('lease', null)
      .select('id');

    if (casError) {
      logger.warn('[StudioLease] acquire CAS failed', {
        studioId: req.studioId,
        error: casError.message,
      });
    }
    if (took?.length) {
      await this.logEvent(req.userId, req.studioId, 'acquired', {
        sessionId: req.sessionId,
        threadKey: req.threadKey,
        agentId: req.agentId,
        reason: req.reason,
      });
      return { acquired: true, lease };
    }

    // Occupied (or a race) — read the current holder.
    const current = await this.getLease(req.studioId);
    const holder = current?.lease;
    if (!holder) {
      // Released between our CAS and the read — one retry.
      const { data: retry } = await this.supabase
        .from('studios')
        .update({ lease: lease as unknown as Json })
        .eq('id', req.studioId)
        .is('lease', null)
        .select('id');
      if (retry?.length) {
        await this.logEvent(req.userId, req.studioId, 'acquired', {
          sessionId: req.sessionId,
          threadKey: req.threadKey,
          agentId: req.agentId,
          reason: req.reason,
        });
        return { acquired: true, lease };
      }
      const reread = await this.getLease(req.studioId);
      if (!reread?.lease) {
        // Still can't see a holder and can't take it — treat as conflict.
        return {
          acquired: false,
          holder: { ...lease, sessionId: 'unknown', threadKey: 'unknown' },
        };
      }
      return this.resolveOccupied(req, reread.lease, current?.worktreePath);
    }

    return this.resolveOccupied(req, holder, current?.worktreePath);
  }

  private async resolveOccupied(
    req: AcquireRequest,
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
        heartbeatAt: now,
        reason: req.reason ?? holder.reason,
      };
      const { data } = await this.supabase
        .from('studios')
        .update({ lease: adopted as unknown as Json })
        .eq('id', req.studioId)
        .eq('lease->>threadKey', req.threadKey)
        .eq('lease->>sessionId', holder.sessionId)
        .select('id');
      if (data?.length) {
        return { acquired: true, lease: adopted };
      }
      // Lost an adopt race to a sibling on the same thread — that's still our
      // thread holding the studio; report acquired with the current holder.
      const reread = await this.getLease(req.studioId);
      if (reread?.lease?.threadKey === req.threadKey) {
        return { acquired: true, lease: reread.lease };
      }
      return { acquired: false, holder: reread?.lease ?? holder };
    }

    // 3) Stale foreign lease — rescue, then reclaim.
    if (isLeaseStale(holder)) {
      // A live in-process run means the session is mid-turn and simply hasn't
      // heartbeated — renew on its behalf instead of stealing the worktree.
      if (hasActiveRun(holder.sessionId)) {
        await this.renewBySession(holder.sessionId);
        return { acquired: false, holder };
      }

      let rescue: WorktreeFinalState | undefined;
      if (worktreePath) {
        rescue = await captureWorktreeState(worktreePath, {
          rescue: true,
          rescueLabel: holder.threadKey,
        });
      }

      const fresh: StudioLease = {
        sessionId: req.sessionId,
        threadKey: req.threadKey,
        agentId: req.agentId,
        acquiredAt: now,
        heartbeatAt: now,
        reason: req.reason,
      };
      const { data } = await this.supabase
        .from('studios')
        .update({ lease: fresh as unknown as Json })
        .eq('id', req.studioId)
        .eq('lease->>sessionId', holder.sessionId)
        .eq('lease->>acquiredAt', holder.acquiredAt)
        .select('id');

      if (data?.length) {
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
          reason: `stale since ${holder.heartbeatAt || holder.acquiredAt}`,
          detail: {
            previousHolder: holder as unknown as Json,
            rescue: (rescue ?? null) as unknown as Json,
          },
        });
        return { acquired: true, lease: fresh, reclaimedFrom: holder };
      }
      // Lost the reclaim race — someone else got there first; re-read and refuse.
      const reread = await this.getLease(req.studioId);
      return { acquired: false, holder: reread?.lease ?? holder };
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
  async renewBySession(sessionId: string): Promise<boolean> {
    const { data } = await this.supabase
      .from('studios')
      .select('id, lease')
      .eq('lease->>sessionId', sessionId)
      .limit(1)
      .maybeSingle();
    const lease = parseLease(data?.lease);
    if (!data || !lease) return false;

    const renewed: StudioLease = { ...lease, heartbeatAt: new Date().toISOString() };
    const { data: updated } = await this.supabase
      .from('studios')
      .update({ lease: renewed as unknown as Json })
      .eq('id', data.id)
      .eq('lease->>sessionId', sessionId)
      .select('id');
    return Boolean(updated?.length);
  }

  /**
   * Release whatever this session holds. Wired into every session-terminal
   * path (SessionService.endSession, MCP end_session, lost-race archive) so
   * release is automatic. Captures final worktree state (branch/commit/dirty)
   * and stamps it into the owning thread's metadata so "what did they leave
   * behind" is answerable after the fact.
   */
  async releaseBySession(
    sessionId: string,
    opts: { userId?: string; reason?: string } = {}
  ): Promise<boolean> {
    const { data } = await this.supabase
      .from('studios')
      .select('id, user_id, lease, worktree_path')
      .eq('lease->>sessionId', sessionId)
      .limit(1)
      .maybeSingle();
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
  async releaseByStudio(studioId: string, opts: { reason?: string } = {}): Promise<boolean> {
    const { data } = await this.supabase
      .from('studios')
      .select('id, user_id, lease, worktree_path')
      .eq('id', studioId)
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

  private async releaseStudio(
    studioId: string,
    userId: string,
    lease: StudioLease,
    worktreePath: string | null,
    opts: { event: 'released' | 'expired'; reason: string }
  ): Promise<boolean> {
    const finalState = worktreePath
      ? await captureWorktreeState(worktreePath, {
          // Expiry means the holder crashed or vanished — protect its work.
          rescue: opts.event === 'expired',
          rescueLabel: lease.threadKey,
        })
      : undefined;

    const { data } = await this.supabase
      .from('studios')
      .update({ lease: null })
      .eq('id', studioId)
      .eq('lease->>sessionId', lease.sessionId)
      .eq('lease->>acquiredAt', lease.acquiredAt)
      .select('id');
    if (!data?.length) return false;

    const heldMs = Date.now() - Date.parse(lease.acquiredAt);
    await this.logEvent(userId, studioId, opts.event, {
      sessionId: lease.sessionId,
      threadKey: lease.threadKey,
      agentId: lease.agentId,
      reason: opts.reason,
      detail: {
        heldMs: Number.isNaN(heldMs) ? null : heldMs,
        finalState: (finalState ?? null) as unknown as Json,
      },
    });

    if (opts.event === 'expired') {
      logger.warn('[StudioLease] Lease expired and was released', {
        studioId,
        sessionId: lease.sessionId,
        threadKey: lease.threadKey,
        staleSince: lease.heartbeatAt || lease.acquiredAt,
        finalState,
      });
    }

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
   * Heartbeat sweep: release stale leases (rescuing worktrees first), renewing
   * instead when the holder has a live in-process run — a long agentic turn is
   * not a crash. Runs on the existing 5-minute heartbeat cron.
   */
  async sweepExpiredLeases(): Promise<{ expired: number; renewed: number }> {
    const { data, error } = await this.supabase
      .from('studios')
      .select('id, user_id, lease, worktree_path')
      .not('lease', 'is', null);
    if (error || !data?.length) return { expired: 0, renewed: 0 };

    let expired = 0;
    let renewed = 0;
    for (const row of data) {
      const lease = parseLease(row.lease);
      if (!lease || !isLeaseStale(lease)) continue;

      if (hasActiveRun(lease.sessionId)) {
        const ok = await this.renewBySession(lease.sessionId);
        if (ok) renewed += 1;
        continue;
      }

      const ok = await this.releaseStudio(row.id, row.user_id, lease, row.worktree_path, {
        event: 'expired',
        reason: `no heartbeat since ${lease.heartbeatAt || lease.acquiredAt}`,
      });
      if (ok) expired += 1;
    }
    return { expired, renewed };
  }

  async logEvent(
    userId: string,
    studioId: string,
    event: LeaseEventType,
    opts: {
      sessionId?: string;
      threadKey?: string;
      agentId?: string;
      reason?: string;
      detail?: Record<string, Json | null>;
    } = {}
  ): Promise<void> {
    try {
      const { error } = await this.supabase.from('studio_lease_events').insert({
        user_id: userId,
        studio_id: studioId,
        session_id: opts.sessionId ?? null,
        thread_key: opts.threadKey ?? null,
        agent_id: opts.agentId ?? null,
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
