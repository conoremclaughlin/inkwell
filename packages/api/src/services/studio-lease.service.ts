/**
 * Studio Lease Service
 *
 * A studio is a git worktree and can host exactly one work-thread at a time
 * (spec:trigger-studio-routing v13 §Occupancy). The lease jsonb on studios is
 * the authoritative occupancy record; this service owns its lifecycle.
 *
 * Every transition is programmatic — the holder never has to opt in:
 *   - acquire: at route resolution, via atomic CAS (UPDATE ... WHERE lease IS NULL)
 *   - renew:   heartbeatAt bumped by CLI lifecycle hooks (per prompt) and by
 *              the sweep for sessions with a live process
 *   - release: at the real terminal boundary — deferred while the session's
 *              process (server runner OR attached CLI turn) is still live,
 *              then performed by the run/stop boundary or the sweep
 *   - expire:  heartbeatAt stale beyond LEASE_STALE_MS → claimed, rescued, released
 *
 * TWO PROOFS, NOT ONE — and NEITHER authorizes a release on its own:
 *   - PRESENCE (isSessionLive: in-process run, fresh cli_poll_at, open turn)
 *     gates taking a lease AWAY from a holder that never asked to give it up:
 *     reclaim, adoption, teardown.
 *   - MID-TURN (isSessionMidTurn: in-process run, open cli_turn_at) DEFERS
 *     completing a release the holder ITSELF requested — protection only.
 *   A requested release COMPLETES only at a real boundary: the holder's stop
 *   event (releaseAtBoundary), a terminal session, or presence loss
 *   (canReleaseNow). Client testimony never authorizes early completion —
 *   six PR #506 review rounds of proof schemes each leaked at an ownership
 *   boundary. Accepted residual: an idle holder with an open terminal keeps
 *   its pendingRelease deferred (bounded delay: next stop, or staleness
 *   after the terminal closes) — delayed, never premature.
 *
 * Safety invariants (PR #492 review rounds 1–3, Lumen):
 *   - Every read and CAS is scoped to the owning user.
 *   - Reclaim and expiry FENCE FIRST, RESCUE SECOND, guarded on the exact
 *     prior lease including heartbeatAt.
 *   - A failed rescue produces a DURABLE QUARANTINE: non-vacant,
 *     non-adoptable, healed only by a verified rescue.
 *   - Same-thread adoption requires a provably TERMINAL or STALE holder —
 *     not a liveness probe, whose timing has an admission gap (a session can
 *     hold a lease before its run is registered). A fresh lease held by a
 *     non-terminal session is presumed live and is never moved.
 *   - CLI liveness is `cli_attached` + fresh `cli_poll_at` — a signal only
 *     the CLI itself stamps, immune to terminal writes refreshing the row.
 *   - Every destructive claim (recovery, teardown) carries a unique token as
 *     its sessionId: claims are unforgeable, a FRESH claim is never stolen,
 *     and owners revalidate the token before destruction.
 *   - Deferred releases are recorded ON the lease (pendingRelease) so the
 *     boundary — or the sweep, if the boundary never fires — completes them.
 *
 * Lease events (studio_lease_events) answer the four occupancy questions from
 * recorded data. Renewals are not logged; they would drown the signal.
 */

import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { access, realpath } from 'fs/promises';
import { sep } from 'path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../data/supabase/types';
import { hasActiveRun } from './sessions/active-runs';
import { resolveIdentityId } from '../auth/resolve-identity';
import { logger } from '../utils/logger';
import { grantStudioLease, studioPathConflict, type GrantOutcome } from './lease-grant';

const execFileAsync = promisify(execFile);

export interface StudioLease {
  sessionId: string;
  threadKey: string;
  /**
   * The live multiplex set (v18 S2): every thread currently riding this
   * lease. Sessions conflict over worktrees; threads never do — one session
   * shepherding several PRs holds ONE lease whose set carries all their keys.
   * `threadKey` above stays the first acquisition reason (telemetry and
   * legacy compatibility, never identity): closing a multiplexed thread
   * removes its key from this set without touching the scalar. Absent on
   * leases written before S2 — `leaseThreadKeys()` is the one reader.
   */
  threadKeys?: string[];
  agentId: string;
  /** Canonical identity UUID (agent_identities.id); agentId is the display slug. */
  sbId?: string | null;
  acquiredAt: string;
  heartbeatAt: string;
  /** Routing tier that assigned the studio (visibility: "why is someone grabbing it"). */
  reason?: string;
  /**
   * Durable quarantine / destructive claim: the worktree is being recovered
   * or torn down. Non-vacant and non-adoptable. For claims, sessionId is a
   * unique random token — ownership is unforgeable and fresh claims cannot
   * be stolen by concurrent workers.
   */
  quarantined?: boolean;
  /** What kind of claim holds the studio ('recovery' rescue retries, 'teardown' destruction). */
  claimKind?: 'recovery' | 'teardown';
  /** The real holder session at the time the claim/quarantine was taken (audit). */
  holderSessionId?: string;
  /** The real thread the studio was serving when it entered quarantine. */
  heldThreadKey?: string;
  /**
   * A release was requested while the holder's process was still live
   * (close_thread/close_studio from inside a turn). The run/stop boundary or
   * the sweep completes it once the process has actually left the worktree.
   */
  pendingRelease?: {
    reason: string;
    requestedAt: string;
    /**
     * The closing THREAD that requested this release (v18 S2, Lumen r2).
     * A thread-close marker authorizes only that thread's exit: an append
     * that legitimately lands after the stamp but before the boundary must
     * not be released underneath — the non-terminal boundary reconciles the
     * marker to a key-removal when other threads have since joined. Absent
     * on studio-close, sweep-mortality, and legacy markers, which stay
     * whole-lease.
     */
    threadKey?: string;
  };
}

/** No heartbeat for this long → the lease is stale and may be reclaimed. */
export const LEASE_STALE_MS = 30 * 60 * 1000;

/** cli_poll_at older than this means no live CLI, whatever cli_attached says. */
export const CLI_ATTACHED_FRESH_MS = 10 * 60 * 1000;

/** Ephemeral overflow studios expire this long after creation if never re-leased. */
export const EPHEMERAL_STUDIO_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Reserved threadKey for quarantine/teardown leases. Real threadKeys must
 * match `<type>:<identifier>` (validated at every boundary), so this value —
 * no colon, reserved prefix — can never collide with or be adopted by a real
 * thread.
 */
export const QUARANTINE_THREAD_KEY = '__quarantine__';

/**
 * How many times acquire() re-validates and retries after losing a CAS.
 * Bounded so a pathologically contended studio cannot spin: losing twice
 * means someone else genuinely owns it, and the caller diverts to overflow.
 */
const ACQUIRE_MAX_ATTEMPTS = 3;

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

/**
 * Internal outcome of one pass over an occupied studio. `retry` sends control
 * back to acquire()'s validated ladder: only acquire() grants, and only from
 * a snapshot it has just validated, so no inner path can accept ownership of
 * a studio that changed underneath it.
 */
type AcquireOutcome = AcquireResult | { retry: true };

export interface WorktreeFinalState {
  branch?: string;
  commit?: string;
  dirty?: boolean;
  /** Set when a dirty tree was stashed; the stash commit SHA survives stash drops. */
  rescueStashSha?: string;
  error?: string;
}

/** Does the worktree directory actually exist on disk? An absent worktree has
 * nothing to rescue — treating its capture error as a failed rescue would
 * quarantine forever with no recovery path. */
export async function worktreePresent(worktreePath: string | null | undefined): Promise<boolean> {
  if (!worktreePath) return false;
  return access(worktreePath)
    .then(() => true)
    .catch(() => false);
}

/** Did a rescue-mode capture actually secure the tree? */
export function rescueSucceeded(state: WorktreeFinalState): boolean {
  if (state.error) return false;
  if (state.dirty && !state.rescueStashSha) return false;
  return true;
}

/**
 * The lease's live thread set. A lease that predates multiplexing carries no
 * `threadKeys`, so its scalar `threadKey` IS the set; once the field exists it
 * is authoritative — the scalar is first-acquisition telemetry and a removed
 * key must not resurrect through it. Deduplicated, order preserved.
 */
export function leaseThreadKeys(lease: StudioLease): string[] {
  const set = lease.threadKeys ?? [lease.threadKey];
  return [...new Set(set)];
}

export function isLeaseStale(lease: StudioLease, nowMs: number = Date.now()): boolean {
  const heartbeat = Date.parse(lease.heartbeatAt || lease.acquiredAt);
  if (Number.isNaN(heartbeat)) return true;
  return nowMs - heartbeat > LEASE_STALE_MS;
}

export function parseStudioLease(raw: Json | null | undefined): StudioLease | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.sessionId !== 'string' || typeof obj.threadKey !== 'string') return null;
  const pending =
    obj.pendingRelease && typeof obj.pendingRelease === 'object'
      ? (obj.pendingRelease as Record<string, unknown>)
      : null;
  return {
    sessionId: obj.sessionId,
    threadKey: obj.threadKey,
    // Every casLease rewrite serializes the PARSED lease, so a field the
    // parser drops is a field every renewal/touch silently erases.
    threadKeys: Array.isArray(obj.threadKeys)
      ? obj.threadKeys.filter((k): k is string => typeof k === 'string')
      : undefined,
    agentId: typeof obj.agentId === 'string' ? obj.agentId : '',
    sbId: typeof obj.sbId === 'string' ? obj.sbId : null,
    acquiredAt: typeof obj.acquiredAt === 'string' ? obj.acquiredAt : '',
    heartbeatAt: typeof obj.heartbeatAt === 'string' ? obj.heartbeatAt : '',
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
    quarantined: obj.quarantined === true,
    claimKind:
      obj.claimKind === 'recovery' || obj.claimKind === 'teardown' ? obj.claimKind : undefined,
    holderSessionId: typeof obj.holderSessionId === 'string' ? obj.holderSessionId : undefined,
    heldThreadKey: typeof obj.heldThreadKey === 'string' ? obj.heldThreadKey : undefined,
    pendingRelease:
      pending && typeof pending.reason === 'string' && typeof pending.requestedAt === 'string'
        ? {
            reason: pending.reason,
            requestedAt: pending.requestedAt,
            threadKey: typeof pending.threadKey === 'string' ? pending.threadKey : undefined,
          }
        : undefined,
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
  /**
   * Last-warned multi-hold set per session (S1, spec v18): the multi-hold
   * warning is advisory telemetry, so it fires once per (session, holder-set)
   * change instead of on every poll — re-arming when the set shrinks back to
   * one so a later recurrence logs again.
   */
  private lastWarnedHolderSets = new Map<string, string>();

  constructor(private supabase: SupabaseClient<Database>) {}

  async getLease(
    studioId: string,
    userId?: string
  ): Promise<{
    lease: StudioLease | null;
    worktreePath?: string;
    ephemeral?: boolean;
    status?: string;
  } | null> {
    let query = this.supabase
      .from('studios')
      .select('lease, worktree_path, ephemeral, status')
      .eq('id', studioId);
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query.maybeSingle();
    if (error) {
      logger.warn('[StudioLease] getLease failed', { studioId, error: error.message });
      return null;
    }
    if (!data) return null;
    return {
      lease: parseStudioLease(data.lease),
      worktreePath: data.worktree_path,
      ephemeral: data.ephemeral,
      status: data.status,
    };
  }

  /** Only active/idle studios may be leased — a cleaned or archived row must
   * never route a runner to its (possibly deleted) worktree. */
  private static readonly ACQUIRABLE_STATUSES = ['active', 'idle'];

  /**
   * Is the session's process still executing in a worktree? Covers:
   *   - server-spawned runners (in-process registry)
   *   - CLIs with the channel plugin (`cli_poll_at`, a fine-grained heartbeat
   *     only the plugin stamps)
   *   - CLIs WITHOUT the plugin (`cli_turn_at`, the hook-owned turn signal:
   *     stamped by on-prompt, cleared only by the real on-stop or an
   *     attach/detach boundary — a NEW process attaching, or an explicit
   *     detach, is process proof the prior turn's process is gone)
   *
   * Neither CLI signal is gated on `cli_attached` — terminal APIs clear that
   * flag from inside a live turn, and it must not be able to hide one. The
   * turn signal has NO wall-time expiry: it is a start marker, not a
   * heartbeat, and a legitimate turn may run arbitrarily long. Crashed-turn
   * recovery is the attach/detach boundary clearing it, never elapsed time.
   *
   * FAILS CLOSED: a liveness read that errors reports LIVE — "could not
   * verify the holder is gone" must never authorize a release or reclaim.
   */
  async isSessionLive(sessionId: string, userId?: string): Promise<boolean> {
    if (hasActiveRun(sessionId)) return true;
    let query = this.supabase
      .from('sessions')
      .select('cli_attached, cli_poll_at, cli_turn_at')
      .eq('id', sessionId);
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query.maybeSingle();
    if (error) {
      logger.warn('[StudioLease] Liveness read failed — treating session as LIVE (fail closed)', {
        sessionId,
        error: error.message,
      });
      return true;
    }
    if (!data) return false; // session row genuinely absent
    const polledAt = Date.parse(data.cli_poll_at ?? '');
    if (!Number.isNaN(polledAt) && Date.now() - polledAt < CLI_ATTACHED_FRESH_MS) return true;
    if (data.cli_turn_at) return true; // open turn — live until the real stop
    return false;
  }

  /**
   * May this lease be released right now, with its holder provably out of
   * the worktree? Presumes a fresh non-terminal holder LIVE — the admission
   * gap (a session wins its lease before its run registers) makes "not live
   * right now" an unsafe proof for fresh leases. Release-now requires:
   * not live AND (lease stale OR session terminal).
   */
  private async canReleaseNow(lease: StudioLease, userId?: string): Promise<boolean> {
    if (await this.isSessionLive(lease.sessionId, userId)) return false;
    if (isLeaseStale(lease)) return true;
    return this.isSessionTerminal(lease.sessionId, userId);
  }

  /**
   * Is the session's process INSIDE a turn right now? A strictly narrower
   * question than isSessionLive, used as an ADDITIONAL defer on completing a
   * requested release — protection stacked on protection, never
   * authorization. An open marker always defers; its absence proves nothing
   * (a producer whose prompt post was swallowed is invisible), so completion
   * still requires canReleaseNow's real-boundary proof. Six PR #506 review
   * rounds of trying to promote this marker's absence into an authorization
   * (proof bits, contract claims, tenure scoping) each leaked at an
   * ownership or visibility boundary; the accepted trade is bounded delay —
   * the pr:498/pr:499 idle-open-terminal shape defers until its next stop
   * boundary or the terminal closes — never premature release.
   *
   * FAILS CLOSED: a read error reports MID-TURN — "could not verify the turn
   * has ended" must never help pull a worktree out from under it.
   */
  /**
   * The lifecycle route's prompt fence: HELD is only reported after a
   * successful exact-guarded CAS touch of this studio's lease (round five —
   * a plain read could observe a snapshot an already-running sweep is about
   * to CAS-clear; a renewal failure was silently ignored). The touch bumps
   * heartbeatAt guarded on the exact prior lease, so a concurrent release
   * either already won (we read the cleared/foreign lease → NOT HELD) or
   * loses its own CAS to ours. One re-read absorbs a benignly lost CAS
   * (e.g., the session-wide renewal racing this touch); a second loss means
   * real contention and reports NOT HELD. FAILS CLOSED on any error.
   */
  async touchStudioLeaseForSession(
    studioId: string,
    sessionId: string,
    userId: string
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { data, error } = await this.supabase
        .from('studios')
        .select('lease')
        .eq('id', studioId)
        .eq('user_id', userId)
        .maybeSingle();
      if (error) {
        logger.warn('[StudioLease] Lease-held read failed — reporting NOT HELD (fail closed)', {
          studioId,
          sessionId,
          error: error.message,
        });
        return false;
      }
      const lease = parseStudioLease(data?.lease);
      if (!lease || lease.quarantined || lease.sessionId !== sessionId) return false;
      // casLease carries the pendingRelease-state guard (round seven), so a
      // marker landing between our read and this CAS fails the CAS and the
      // re-read carries it into the rewrite instead of erasing it.
      const touched = await this.casLease(studioId, userId, lease, {
        ...lease,
        heartbeatAt: new Date().toISOString(),
      });
      if (touched) return true;
    }
    return false;
  }

  async isSessionMidTurn(sessionId: string, userId?: string): Promise<boolean> {
    if (hasActiveRun(sessionId)) return true;
    let query = this.supabase.from('sessions').select('cli_turn_at').eq('id', sessionId);
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query.maybeSingle();
    if (error) {
      logger.warn('[StudioLease] Turn read failed — treating session as MID-TURN (fail closed)', {
        sessionId,
        error: error.message,
      });
      return true;
    }
    if (!data) return false; // session row genuinely absent
    return Boolean(data.cli_turn_at);
  }

  /**
   * Has the session durably ended? (ended_at stamped or status completed)
   * FAILS CLOSED: a read error reports NOT terminal — "could not verify"
   * must never count as terminal proof.
   */
  async isSessionTerminal(sessionId: string, userId?: string): Promise<boolean> {
    let query = this.supabase.from('sessions').select('ended_at, status').eq('id', sessionId);
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query.maybeSingle();
    if (error) {
      logger.warn('[StudioLease] Terminality read failed — treating as NOT terminal', {
        sessionId,
        error: error.message,
      });
      return false;
    }
    if (!data) return false;
    return Boolean(data.ended_at) || data.status === 'completed';
  }

  /**
   * Acquire the studio for a (session, thread), atomically.
   *
   * CAS ladder:
   *   0. quarantined/claim      → refuse while fresh; once stale, re-claim and
   *                               retry the rescue — only a VERIFIED rescue
   *                               converts quarantine into an acquisition
   *   1. lease IS NULL          → take it
   *   2. same threadKey         → adopt ONLY from a provably terminal or
   *                               stale-and-not-live holder. A fresh lease
   *                               held by a non-terminal session is presumed
   *                               live — liveness probes have an admission
   *                               gap (acquire precedes run registration), so
   *                               presumption is the only safe default.
   *   3. stale foreign lease    → refuse if the holder is live (renewing on
   *                               its behalf); otherwise CLAIM first (CAS
   *                               guarded on the exact holder including
   *                               heartbeatAt), THEN rescue. Rescue failure
   *                               converts the claim into quarantine.
   *   4. fresh foreign lease    → refuse; caller diverts to overflow
   *
   * Every CAS is additionally guarded on user_id — a studio UUID alone never
   * authorizes a mutation.
   */
  async acquire(req: AcquireRequest): Promise<AcquireResult> {
    const sbId = await this.resolveSbId(req.userId, req.agentId);

    // Bounded validate→grant ladder. EVERY authoritative read passes through
    // refuseUngrantable() before any grant path runs, and a lost CAS
    // RESTARTS the ladder rather than granting on the state it read before
    // the race. Validating only the first read was the round-9 gap: between
    // that read and a lost vacant CAS, another writer can install a terminal
    // same-thread lease while the cwd disappears, and adoption on the reread
    // would then hand out a studio whose worktree is gone.
    for (let attempt = 0; attempt < ACQUIRE_MAX_ATTEMPTS; attempt += 1) {
      const current = await this.getLease(req.studioId, req.userId);
      const refusal = await this.refuseUngrantable(req, current);
      if (refusal) return refusal;

      const now = new Date().toISOString();
      const lease: StudioLease = {
        sessionId: req.sessionId,
        threadKey: req.threadKey,
        threadKeys: [req.threadKey],
        agentId: req.agentId,
        sbId,
        acquiredAt: now,
        heartbeatAt: now,
        reason: req.reason,
      };

      const holder = current?.lease ?? null;
      if (holder) {
        const outcome = await this.resolveOccupied(req, lease, holder, current?.worktreePath);
        // A retry signal means an inner CAS lost: loop to re-read and
        // re-validate rather than trusting the snapshot that lost.
        if ('retry' in outcome) continue;
        return outcome;
      }

      const vacant = await this.grantLease(req, lease, null);
      if (vacant.outcome === 'granted') {
        await this.logEvent(req.userId, req.studioId, 'acquired', {
          sessionId: req.sessionId,
          threadKey: req.threadKey,
          agentId: req.agentId,
          sbId,
          reason: req.reason,
        });
        return { acquired: true, lease };
      }
      if (vacant.outcome === 'path-conflict') {
        // Another thread holds this WORKING TREE through a sibling studio row
        // (several rows can name one checkout — resolveMainStudio gives each
        // SB its own row per path). This row's vacancy was a lie about the
        // tree; surface the sibling's holder so the caller diverts exactly as
        // it would for a row-level conflict (Phase 6b, task c82daba1).
        await this.logEvent(req.userId, req.studioId, 'conflict', {
          sessionId: req.sessionId,
          threadKey: req.threadKey,
          agentId: req.agentId,
          sbId,
          reason: `path held by sibling studio ${vacant.conflictStudioId} (${vacant.conflictHolder?.threadKey ?? 'unknown thread'})`,
        });
        return { acquired: false, holder: vacant.conflictHolder };
      }
      // Lost the vacant CAS — loop and re-validate from scratch.
    }

    logger.warn('[StudioLease] Acquire abandoned after repeated lost races', {
      studioId: req.studioId,
      threadKey: req.threadKey,
      attempts: ACQUIRE_MAX_ATTEMPTS,
    });
    return { acquired: false, holder: null };
  }

  /**
   * The gate every grant path shares: the studio must exist for this user,
   * hold an acquirable status, and have its configured worktree on disk.
   * Returns a refusal result when any of those fail (retiring a dead studio
   * as a side effect), or null when the studio may proceed to the CAS ladder.
   */
  private async refuseUngrantable(
    req: AcquireRequest,
    current: Awaited<ReturnType<StudioLeaseService['getLease']>>
  ): Promise<AcquireResult | null> {
    if (!current) {
      // Studio doesn't exist for this user — refuse; never treat an
      // unverifiable studio as acquirable.
      logger.warn('[StudioLease] Acquire refused — studio not found for user', {
        studioId: req.studioId,
        userId: req.userId,
      });
      return { acquired: false, holder: null };
    }
    if (current.status && !StudioLeaseService.ACQUIRABLE_STATUSES.includes(current.status)) {
      // Cleaned/archived studios are not routable — continuity or an explicit
      // UUID must not send a runner back to a retired (possibly deleted) path.
      logger.warn('[StudioLease] Acquire refused — studio is not in an acquirable status', {
        studioId: req.studioId,
        status: current.status,
      });
      return { acquired: false, holder: null };
    }
    if (current.worktreePath && !(await worktreePresent(current.worktreePath))) {
      // A configured-but-absent worktree is a dead studio. Never grant it —
      // vacant, adoptable, or otherwise — and retire it so it stops
      // circulating. (`removeWorktree: false` closes and externally deleted
      // directories both produce this state.)
      await this.retireMissingWorktree(req, current.lease, current.worktreePath);
      return { acquired: false, holder: null };
    }
    return null;
  }

  /**
   * Retire a studio whose configured worktree is gone: status cleaned +
   * lease NULL, in ONE CAS guarded on the exact state we observed (vacant,
   * or that precise lease). A studio that changed underneath is left alone.
   *
   * A LIVE holder is never disturbed — its lease stays and the sweep or its
   * own boundary deals with it. There is nothing on disk left to protect,
   * so the point of retiring is only to stop the row being handed out.
   */
  private async retireMissingWorktree(
    req: AcquireRequest,
    lease: StudioLease | null,
    worktreePath: string
  ): Promise<void> {
    // A FRESH destructive claim belongs to a worker that is mid-teardown or
    // mid-recovery RIGHT NOW. close_studio's normal window legitimately has
    // the worktree gone between `git worktree remove` and the owner's
    // finalizeTeardown — and a claim's sessionId is a random token, not a
    // session, so a liveness probe always calls it dead. Retiring here would
    // steal the claim and make the real close's finalize CAS lose and report
    // a false failure. Leave it to its owner, or to the stale sweep if that
    // owner died.
    if (lease?.quarantined && !isLeaseStale(lease)) {
      logger.info(
        '[StudioLease] Missing worktree is under an active claim; leaving it to its owner',
        {
          studioId: req.studioId,
          worktreePath,
          claimKind: lease.claimKind ?? null,
        }
      );
      return;
    }

    if (lease && (await this.isSessionLive(lease.sessionId, req.userId))) {
      logger.error('[StudioLease] Acquire refused — worktree is missing under a LIVE holder', {
        studioId: req.studioId,
        worktreePath,
        holderSessionId: lease.sessionId,
      });
      return;
    }

    let query = this.supabase
      .from('studios')
      .update({ status: 'cleaned', cleaned_at: new Date().toISOString(), lease: null })
      .eq('id', req.studioId)
      .eq('user_id', req.userId);
    query = lease
      ? query
          .eq('lease->>sessionId', lease.sessionId)
          .eq('lease->>acquiredAt', lease.acquiredAt)
          .eq('lease->>heartbeatAt', lease.heartbeatAt)
      : query.is('lease', null);

    const { data } = await query.select('id');
    if (!data?.length) return;

    // Same contract as every other successful release/cleaning exit (S1,
    // Lumen r1 on PR #550): a retired ephemeral must not stay any session's
    // thread-continuity address.
    await this.repointSessionsOffEphemeral(req.studioId, req.userId);

    logger.warn('[StudioLease] Retired studio with absent worktree', {
      studioId: req.studioId,
      worktreePath,
      hadLease: Boolean(lease),
    });
    await this.logEvent(req.userId, req.studioId, 'released', {
      sessionId: lease?.holderSessionId ?? lease?.sessionId,
      threadKey: lease?.heldThreadKey ?? lease?.threadKey,
      agentId: lease?.agentId ?? req.agentId,
      sbId: lease?.sbId,
      reason: 'worktree-absent-retired',
    });
  }

  /**
   * Every GRANT goes through the path-serialized grant_studio_lease RPC:
   * advisory xact lock on (user, worktree_path) held across the sibling scan
   * AND the CAS, so two rows naming one tree cannot both admit a writer.
   * expectedPrior NULL = vacant grant; non-null = exact-prior handover/adopt
   * (v14 invariant: grants CAS from a validated snapshot). Non-grant
   * transitions (release, renewal, claims, quarantine) stay on casLease —
   * they never ADD a writer to a tree.
   */
  private async grantLease(
    req: AcquireRequest,
    lease: StudioLease,
    expectedPrior: StudioLease | null
  ): Promise<GrantOutcome> {
    return grantStudioLease(this.supabase, {
      studioId: req.studioId,
      userId: req.userId,
      lease,
      expectedPrior,
    });
  }

  /**
   * CAS the lease from one exact value (incl. heartbeatAt) to another.
   * `requireAcquirableStatus` gates writes that GRANT a lease (adopt,
   * recovery handover) on active/idle — a cleaned studio must never be
   * re-leased through continuity or an explicit UUID. Releases and
   * quarantine transitions run regardless of status.
   */
  private async casLease(
    studioId: string,
    userId: string,
    from: StudioLease,
    to: StudioLease | null,
    opts: { requireAcquirableStatus?: boolean } = {}
  ): Promise<boolean> {
    let query = this.supabase
      .from('studios')
      .update({ lease: to as unknown as Json })
      .eq('id', studioId)
      .eq('user_id', userId)
      .eq('lease->>sessionId', from.sessionId)
      .eq('lease->>acquiredAt', from.acquiredAt)
      .eq('lease->>heartbeatAt', from.heartbeatAt);
    // pendingRelease is the ONE lease mutation that changes neither session,
    // acquiredAt, nor heartbeatAt — so without this guard, any whole-JSON
    // rewrite (a renewal, a touch) racing close_thread's marker would match
    // the three fields above and silently ERASE the release request while
    // close_thread reports success (round seven; first seen on the touch in
    // round six, then red-verified on renewBySession). Guarding the exact
    // pendingRelease state `from` was read with makes every CAS
    // transition-safe: a marker landing after the read fails the CAS, and
    // the caller's re-read carries it forward instead of overwriting it.
    query = from.pendingRelease
      ? query.eq('lease->pendingRelease->>requestedAt', from.pendingRelease.requestedAt)
      : query.is('lease->pendingRelease', null);
    // threadKeys is the SECOND lease mutation with the pendingRelease shape
    // (v18 S2): a set-REMOVE changes neither session, acquiredAt, heartbeatAt,
    // nor pendingRelease, so without this guard two concurrent thread-closes
    // both match, and the later write resurrects the key the earlier one
    // removed (append is incidentally protected by its heartbeat bump; remove
    // is not). Guarding the exact prior set makes every rewrite re-read the
    // winner's state instead of overwriting it. jsonb equality is structural
    // and array-order-sensitive; the service always rewrites from a parsed
    // read, so order is stable.
    query = from.threadKeys
      ? query.eq('lease->threadKeys', JSON.stringify(from.threadKeys))
      : query.is('lease->threadKeys', null);
    if (opts.requireAcquirableStatus) {
      query = query.in('status', StudioLeaseService.ACQUIRABLE_STATUSES);
    }
    const { data } = await query.select('id');
    return Boolean(data?.length);
  }

  /**
   * Atomic teardown finalization: status → cleaned, cleaned_at stamped, and
   * the lease cleared in ONE user+exact-claim-guarded CAS. Returns false when
   * the claim no longer matches (stolen/aged) — the caller must not report
   * success. This is the only way a teardown/reconciliation may publish its
   * end state; separate markCleaned + clear steps can interleave with a claim
   * replacement.
   */
  async finalizeTeardown(studioId: string, userId: string, claim: StudioLease): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('studios')
      .update({ status: 'cleaned', cleaned_at: new Date().toISOString(), lease: null })
      .eq('id', studioId)
      .eq('user_id', userId)
      .eq('lease->>sessionId', claim.sessionId)
      .eq('lease->>acquiredAt', claim.acquiredAt)
      .eq('lease->>heartbeatAt', claim.heartbeatAt)
      .select('id');
    if (error) {
      logger.warn('[StudioLease] finalizeTeardown failed', { studioId, error: error.message });
      return false;
    }
    const finalized = Boolean(data?.length);
    if (finalized) await this.repointSessionsOffEphemeral(studioId, userId);
    return finalized;
  }

  /**
   * S1 (spec v18): a released or torn-down ephemeral must not remain any
   * session's address — thread-continuity keeps resolving `sessions.studio_id`
   * long after the studio stopped serving anyone (the pr:545 orphan was still
   * its holder's recorded studio five days after the PR merged). Repoint
   * sessions to the ephemeral's first durable (non-ephemeral, non-cleaned)
   * ancestor, or NULL when none survives. The `.eq('studio_id', …)` guard is
   * the CAS: only sessions still pointing at the ephemeral move. Hygiene, not
   * safety — failures warn and never block the release that already happened.
   */
  private async repointSessionsOffEphemeral(studioId: string, userId: string): Promise<void> {
    try {
      const { data: studio } = await this.supabase
        .from('studios')
        .select('id, ephemeral, parent_studio_id')
        .eq('id', studioId)
        .eq('user_id', userId)
        .maybeSingle();
      if (studio?.ephemeral !== true) return;

      let ancestorId: string | null = null;
      const seen = new Set<string>([studioId]);
      let parentId = (studio.parent_studio_id as string | null) ?? null;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const { data: parent } = await this.supabase
          .from('studios')
          .select('id, ephemeral, parent_studio_id, status')
          .eq('id', parentId)
          .eq('user_id', userId)
          .maybeSingle();
        if (!parent) break;
        if (parent.ephemeral !== true && parent.status !== 'cleaned') {
          ancestorId = parent.id;
          break;
        }
        parentId = (parent.parent_studio_id as string | null) ?? null;
      }

      const { error } = await this.supabase
        .from('sessions')
        .update({ studio_id: ancestorId })
        .eq('user_id', userId)
        .eq('studio_id', studioId);
      if (error) throw new Error(error.message);
    } catch (err) {
      logger.warn('[StudioLease] Failed to repoint sessions off released ephemeral', {
        studioId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Build a quarantine/claim record. sessionId is a fresh random token —
   * ownership is unforgeable, so concurrent workers can never both believe
   * they hold the same claim, and event rows always carry a valid uuid.
   */
  private claimRecord(
    holder: StudioLease | null,
    kind: 'recovery' | 'teardown',
    reason: string,
    fallbackThreadKey?: string
  ): StudioLease {
    return {
      sessionId: randomUUID(),
      threadKey: QUARANTINE_THREAD_KEY,
      heldThreadKey: holder?.heldThreadKey ?? holder?.threadKey ?? fallbackThreadKey,
      holderSessionId: holder?.holderSessionId ?? holder?.sessionId,
      agentId: holder?.agentId ?? 'system',
      sbId: holder?.sbId ?? null,
      acquiredAt: holder?.acquiredAt ?? new Date().toISOString(),
      heartbeatAt: new Date().toISOString(), // rate-limits retries to LEASE_STALE_MS
      reason,
      quarantined: true,
      claimKind: kind,
    };
  }

  /**
   * Fence-then-rescue against an exact observed holder. The fence is a
   * RECOVERY CLAIM (quarantined, unique token) — never the requester's normal
   * lease, which duplicate acquires could adopt and close paths could clear
   * mid-rescue. Only after a verified rescue does the claim hand over to the
   * requester's lease, CAS-guarded on the claim's own token. A failed rescue
   * leaves that exact claim in place as the durable quarantine.
   */
  private async claimAndRescue(
    req: AcquireRequest,
    lease: StudioLease,
    holder: StudioLease,
    worktreePath: string | undefined,
    eventReason: string
  ): Promise<AcquireResult> {
    const recovery = this.claimRecord(holder, 'recovery', 'recovery:in-progress');
    const claimed = await this.casLease(req.studioId, req.userId, holder, recovery);
    if (!claimed) {
      const reread = await this.getLease(req.studioId, req.userId);
      return { acquired: false, holder: reread?.lease ?? holder };
    }

    // PATH FENCE BEFORE RESCUE (PR #517 round 1 blocker 4). The claim above
    // is row-local; the rescue below MUTATES the tree (stash/reset). If a
    // sibling row holds a fresh lease on the same tree, rescuing here would
    // stomp a live writer's checkout and discover the conflict only at
    // handover — too late. Check now, under the same advisory lock the grant
    // uses; our claim blocks new sibling grants, so check-then-rescue cannot
    // be raced. On conflict, RESTORE the observed holder (exact-claim CAS)
    // and refuse with the sibling surfaced. Fails closed: an unverifiable
    // check restores and refuses too.
    const pathState = await studioPathConflict(this.supabase, {
      studioId: req.studioId,
      userId: req.userId,
    });
    if (pathState.conflict) {
      const restored = await this.casLease(req.studioId, req.userId, recovery, holder);
      if (!restored) {
        logger.error('[StudioLease] Could not restore holder after path-fenced refusal', {
          studioId: req.studioId,
          holderSessionId: holder.sessionId,
        });
      }
      logger.warn('[StudioLease] Reclaim refused — sibling row holds the same tree', {
        studioId: req.studioId,
        conflictStudioId: pathState.conflictStudioId ?? null,
        conflictThreadKey: pathState.conflictHolder?.threadKey ?? null,
      });
      return { acquired: false, holder: pathState.conflictHolder ?? holder };
    }

    // A configured worktree that is ABSENT on disk is a dead studio, not an
    // acquirable one: never hand a runner a nonexistent cwd, and never
    // publish it back as vacancy. Retire it — cleaned + lease NULL in one
    // claim-guarded CAS — and refuse; the caller diverts to overflow.
    if (worktreePath && !(await worktreePresent(worktreePath))) {
      const retired = await this.finalizeTeardown(req.studioId, req.userId, recovery);
      if (retired) {
        logger.warn('[StudioLease] Retired studio with absent worktree during reclaim', {
          studioId: req.studioId,
          worktreePath,
          previousHolder: { sessionId: holder.sessionId, threadKey: holder.threadKey },
        });
        await this.logEvent(req.userId, req.studioId, 'released', {
          sessionId: holder.holderSessionId ?? holder.sessionId,
          threadKey: holder.heldThreadKey ?? holder.threadKey,
          agentId: holder.agentId,
          sbId: holder.sbId,
          reason: 'worktree-absent-retired',
          detail: { previousHolder: holder as unknown as Json },
        });
      }
      return { acquired: false, holder: null };
    }

    if (worktreePath) {
      const rescue = await captureWorktreeState(worktreePath, {
        rescue: true,
        rescueLabel: holder.heldThreadKey ?? holder.threadKey,
      });
      if (!rescueSucceeded(rescue)) {
        // The recovery claim IS the durable quarantine: non-vacant,
        // non-adoptable, retried once stale. Nothing to CAS — we already
        // hold it, so no concurrent mutation can strip the quarantine.
        logger.error('[StudioLease] Rescue failed — studio quarantined', {
          studioId: req.studioId,
          previousHolder: { sessionId: holder.sessionId, threadKey: holder.threadKey },
          rescue,
        });
        await this.logEvent(req.userId, req.studioId, 'conflict', {
          sessionId: recovery.holderSessionId,
          threadKey: recovery.heldThreadKey,
          agentId: holder.agentId,
          sbId: holder.sbId,
          reason: 'rescue-failed-quarantined',
          detail: {
            previousHolder: holder as unknown as Json,
            rescue: rescue as unknown as Json,
          },
        });
        return { acquired: false, holder: recovery };
      }

      // Hand over: claim (our token) → requester's lease. Losing this CAS
      // means the claim aged out and was taken — abort, never assume. The
      // grant is path-serialized: a fresh foreign lease on a sibling row for
      // the same tree blocks it (Phase 6b).
      const handedOver = await this.grantLease(req, lease, recovery);
      if (handedOver.outcome === 'path-conflict') {
        return { acquired: false, holder: handedOver.conflictHolder };
      }
      if (handedOver.outcome !== 'granted') {
        logger.error('[StudioLease] Recovery claim lost before handover; refusing', {
          studioId: req.studioId,
          requestingSessionId: req.sessionId,
        });
        const reread = await this.getLease(req.studioId, req.userId);
        return { acquired: false, holder: reread?.lease ?? null };
      }

      logger.warn('[StudioLease] Reclaimed lease after verified rescue', {
        studioId: req.studioId,
        from: { sessionId: holder.sessionId, threadKey: holder.threadKey },
        to: { sessionId: req.sessionId, threadKey: req.threadKey },
        rescue,
      });
      await this.logEvent(req.userId, req.studioId, 'reclaimed', {
        sessionId: req.sessionId,
        threadKey: req.threadKey,
        agentId: req.agentId,
        sbId: lease.sbId,
        reason: eventReason,
        detail: {
          previousHolder: holder as unknown as Json,
          rescue: rescue as unknown as Json,
        },
      });
      return { acquired: true, lease, reclaimedFrom: holder };
    }

    // No worktree to rescue — hand the claim straight over (path-serialized).
    const handedOver = await this.grantLease(req, lease, recovery);
    if (handedOver.outcome === 'path-conflict') {
      return { acquired: false, holder: handedOver.conflictHolder };
    }
    if (handedOver.outcome !== 'granted') {
      const reread = await this.getLease(req.studioId, req.userId);
      return { acquired: false, holder: reread?.lease ?? null };
    }
    await this.logEvent(req.userId, req.studioId, 'reclaimed', {
      sessionId: req.sessionId,
      threadKey: req.threadKey,
      agentId: req.agentId,
      sbId: lease.sbId,
      reason: eventReason,
      detail: { previousHolder: holder as unknown as Json },
    });
    return { acquired: true, lease, reclaimedFrom: holder };
  }

  private async resolveOccupied(
    req: AcquireRequest,
    lease: StudioLease,
    holder: StudioLease,
    worktreePath?: string
  ): Promise<AcquireOutcome> {
    const now = new Date().toISOString();

    // 0) Quarantine / destructive claim — checked BEFORE adoption so these
    //    can never be adopted. Fresh refuses outright (the claim's owner is
    //    working); stale may be re-claimed, but only a verified rescue
    //    converts it.
    if (holder.quarantined) {
      if (!isLeaseStale(holder)) {
        return { acquired: false, holder };
      }
      return this.claimAndRescue(req, lease, holder, worktreePath, 'quarantine-recovered');
    }

    // 1.5) Same SESSION, new thread (v18 S2) — sessions conflict, threads
    //    multiplex. The holder IS the requester, so there is no cross-process
    //    contention to arbitrate: append the key to the live set and bump the
    //    heartbeat (the holder's own acquire is a genuine liveness signal).
    //    casLease, not grantLease — no new writer enters the tree, and the
    //    exact-prior guard (including pendingRelease state) makes the append
    //    transition-safe: it can never erase a concurrently-stamped release
    //    request, and a stamped pendingRelease is carried forward untouched —
    //    an append protects the set, it never re-authorizes a dying lease.
    if (holder.sessionId === req.sessionId) {
      const live = leaseThreadKeys(holder);
      if (!live.includes(req.threadKey)) {
        const appended: StudioLease = {
          ...holder,
          threadKeys: [...live, req.threadKey],
          heartbeatAt: now,
          reason: req.reason ?? holder.reason,
        };
        if (!(await this.casLease(req.studioId, req.userId, holder, appended))) {
          // Lost the CAS — hand control back to acquire()'s validated ladder.
          return { retry: true };
        }
        await this.logEvent(req.userId, req.studioId, 'acquired', {
          sessionId: req.sessionId,
          threadKey: req.threadKey,
          agentId: req.agentId,
          sbId: lease.sbId ?? holder.sbId,
          reason: 'multiplex-append',
          detail: { threadKeys: appended.threadKeys as unknown as Json },
        });
        logger.info('[StudioLease] Thread multiplexed onto holder lease', {
          studioId: req.studioId,
          sessionId: req.sessionId,
          threadKey: req.threadKey,
          threadKeys: appended.threadKeys,
        });
        return { acquired: true, lease: appended };
      }
      // Key already in the set — fall through to the same-thread rung, which
      // grants the holder's own re-acquire (heartbeat bump) as before.
    }

    // 2) Same thread — the lease follows the thread, but only away from a
    //    holder that is provably TERMINAL or STALE-and-not-live. Liveness
    //    probes alone have an admission gap: a session acquires its lease in
    //    getOrCreateSession before its run registers, so "not live right now"
    //    does not mean "not about to run". Presume a fresh lease live.
    //    v18 S2: membership is against the LIVE SET — a multiplexed key
    //    follows its thread exactly like the scalar always has, and an
    //    adoption carries the whole set (the studio still serves those
    //    threads; their next messages route to the successor).
    if (leaseThreadKeys(holder).includes(req.threadKey)) {
      if (holder.sessionId !== req.sessionId) {
        // Liveness first: a TERMINAL DB row is not proof the process has left
        // the worktree — end_session stamps terminal state from inside an
        // active turn. Only the boundary clearing the process signals makes
        // the studio movable.
        if (await this.isSessionLive(holder.sessionId, req.userId)) {
          if (isLeaseStale(holder)) {
            await this.renewBySession(holder.sessionId, req.userId);
          }
          logger.warn('[StudioLease] Adoption refused — holder process is live', {
            studioId: req.studioId,
            threadKey: req.threadKey,
            holderSessionId: holder.sessionId,
            requestingSessionId: req.sessionId,
          });
          return { acquired: false, holder };
        }
        const terminal = await this.isSessionTerminal(holder.sessionId, req.userId);
        if (!terminal && !isLeaseStale(holder)) {
          // Fresh, non-terminal, "not live right now" — the admission gap
          // makes that unprovable. Presume live; refuse.
          logger.warn('[StudioLease] Adoption refused — holder is not terminal', {
            studioId: req.studioId,
            threadKey: req.threadKey,
            holderSessionId: holder.sessionId,
            requestingSessionId: req.sessionId,
          });
          return { acquired: false, holder };
        }
      }
      const adopted: StudioLease = {
        ...holder,
        sessionId: req.sessionId,
        agentId: req.agentId,
        sbId: lease.sbId ?? holder.sbId,
        heartbeatAt: now,
        reason: req.reason ?? holder.reason,
      };
      const won = await this.grantLease(req, adopted, holder);
      if (won.outcome === 'granted') {
        return { acquired: true, lease: adopted };
      }
      if (won.outcome === 'path-conflict') {
        // A different thread freshly holds the tree through a sibling row.
        // Adoption of THIS row would still put a second thread on the tree —
        // refuse and let the caller divert (Phase 6b).
        return { acquired: false, holder: won.conflictHolder };
      }
      // Lost the adopt race. Ownership is NEVER accepted from an unvalidated
      // snapshot — not even when the reread shows our own session holding the
      // lease, because the studio it sits on may have changed underneath
      // (status flipped, worktree deleted). Hand control back to acquire()'s
      // validated ladder, which re-reads, re-validates, and re-attempts; if
      // this session really does hold it, the next pass adopts its own lease
      // and grants. (Round 10 — the same defect round 9 fixed one layer up.)
      return { retry: true };
    }

    // 3) Stale foreign lease — refuse for live holders, else fence and rescue.
    if (isLeaseStale(holder)) {
      // A live process (in-process run OR freshly-polling CLI) means the
      // session is mid-turn and its renewals are lagging — renew on its
      // behalf instead of stealing the worktree. The heartbeat CAS inside
      // claimAndRescue remains the final race guard.
      if (await this.isSessionLive(holder.sessionId, req.userId)) {
        await this.renewBySession(holder.sessionId, req.userId);
        return { acquired: false, holder };
      }
      return this.claimAndRescue(
        req,
        lease,
        holder,
        worktreePath,
        `stale since ${holder.heartbeatAt || holder.acquiredAt}`
      );
    }

    // 4) Fresh foreign lease — refuse; the caller diverts to overflow.
    return { acquired: false, holder };
  }

  /**
   * Every studio this session currently holds a non-quarantine lease on.
   *
   * "One session holds at most one studio" is an invariant the service
   * assumes but nothing enforces — jsonb carries no unique constraint, so the
   * database cannot object. It is violated in practice: an agent that opens a
   * second thread from inside a live session acquires a second studio, and
   * session 4896f302 was observed holding two at once. The previous
   * `.limit(1).maybeSingle()` then made every release path pick ONE of them in
   * unspecified order and silently strand the rest — a leased worktree with no
   * live holder and no pending release, invisible to the sweep.
   *
   * Until the storage rework can express this as UNIQUE (session_id), the
   * lifecycle operates on the whole set.
   */
  private async studiosHeldBy(
    sessionId: string,
    userId?: string
  ): Promise<
    Array<{
      id: string;
      user_id: string;
      lease: StudioLease;
      worktree_path: string | null;
      ephemeral: boolean;
      expires_at: string | null;
    }>
  > {
    let query = this.supabase
      .from('studios')
      .select('id, user_id, lease, worktree_path, ephemeral, expires_at')
      .eq('lease->>sessionId', sessionId);
    if (userId) query = query.eq('user_id', userId);
    const { data } = await query;
    if (!data?.length) return [];

    const held = [];
    for (const row of data) {
      const lease = parseStudioLease(row.lease);
      if (!lease || lease.quarantined) continue;
      held.push({
        id: row.id,
        user_id: row.user_id,
        lease,
        worktree_path: row.worktree_path ?? null,
        ephemeral: row.ephemeral === true,
        expires_at: (row.expires_at as string | null) ?? null,
      });
    }
    if (held.length > 1) {
      // Advisory telemetry: once per holder-set change, not per poll — an
      // attached terminal calls this every ~10s and the unchanged multi-hold
      // was producing ~8.6k identical lines/day (spec v18 S1).
      const setKey = held
        .map((h) => h.id)
        .sort()
        .join(',');
      if (this.lastWarnedHolderSets.get(sessionId) !== setKey) {
        this.lastWarnedHolderSets.set(sessionId, setKey);
        logger.warn('[StudioLease] Session holds multiple studios — acting on all of them', {
          sessionId,
          studioIds: held.map((h) => h.id),
        });
      }
    } else {
      this.lastWarnedHolderSets.delete(sessionId);
    }
    return held;
  }

  /**
   * S1 (spec v18): is this an EXPIRED ephemeral whose holder session is
   * positively verified to be operating from a different worktree? Only such
   * a lease may be denied renewal — the poll heartbeat of a terminal that is
   * not even inside the tree must not manufacture freshness for a studio the
   * TTL already ended (the pr:545 orphan renewed for five days this way).
   *
   * Every uncertain read preserves the lease (fail closed): a durable studio,
   * an unexpired TTL, a claim/quarantine record, an open turn or in-process
   * run, a missing session row or working_dir, a canonicalization failure,
   * and a working_dir inside the studio's tree all report false. This
   * predicate never authorizes destruction — it only stops synthetic
   * renewals and lets the sweep stamp pendingRelease, which completes at the
   * holder's real boundary exactly as v17 requires.
   */
  private async isEphemeralHeldElsewhere(
    row: {
      ephemeral: boolean;
      expires_at: string | null;
      worktree_path: string | null;
    },
    lease: StudioLease,
    userId?: string
  ): Promise<boolean> {
    if (!row.ephemeral || !row.worktree_path) return false;
    if (lease.quarantined || lease.claimKind) return false;
    const expiresAt = Date.parse(row.expires_at ?? '');
    if (Number.isNaN(expiresAt) || expiresAt > Date.now()) return false;
    if (await this.isSessionMidTurn(lease.sessionId, userId)) return false;

    let query = this.supabase.from('sessions').select('working_dir').eq('id', lease.sessionId);
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query.maybeSingle();
    if (error || !data?.working_dir) return false;

    let holderDir: string;
    let studioDir: string;
    try {
      [holderDir, studioDir] = await Promise.all([
        realpath(data.working_dir),
        realpath(row.worktree_path),
      ]);
    } catch {
      return false;
    }
    return holderDir !== studioDir && !holderDir.startsWith(studioDir + sep);
  }

  /**
   * Bump heartbeatAt on every studio this session holds. Called from the CLI
   * lifecycle hook route on every prompt, and by the sweep for sessions with
   * a live process. Never renews a quarantine record — quarantine heals
   * through rescue, not heartbeats. Returns true if any lease was renewed.
   */
  async renewBySession(sessionId: string, userId?: string): Promise<boolean> {
    let any = false;
    for (const row of await this.studiosHeldBy(sessionId, userId)) {
      // S1 (spec v18): a verified-elsewhere holder must not keep an expired
      // ephemeral fresh — this is the first of the two renewal paths, and
      // the sweep's on-behalf renewal funnels through here too, so one gate
      // covers both. Uncertainty renews as before.
      if (await this.isEphemeralHeldElsewhere(row, row.lease, userId ?? row.user_id)) {
        logger.debug('[StudioLease] Skipping renewal — expired ephemeral held from elsewhere', {
          studioId: row.id,
          sessionId,
          threadKey: row.lease.threadKey,
        });
        continue;
      }
      const renewed: StudioLease = { ...row.lease, heartbeatAt: new Date().toISOString() };
      if (await this.casLease(row.id, row.user_id, row.lease, renewed)) any = true;
    }
    return any;
  }

  /**
   * Release what this session holds — but only once its process has actually
   * left the worktree (no in-process run, no freshly-polling attached CLI).
   * Deferred releases are picked up at the corresponding run boundary:
   * SessionService's finalized branch for server runs, the lifecycle stop hook
   * for CLI turns, the sweep as backstop.
   */
  async releaseUnlessRunning(
    sessionId: string,
    opts: { userId?: string; reason?: string } = {}
  ): Promise<boolean> {
    let any = false;
    for (const row of await this.studiosHeldBy(sessionId, opts.userId)) {
      if (!(await this.canReleaseNow(row.lease, opts.userId ?? row.user_id))) {
        logger.info('[StudioLease] Release deferred — no safe terminal/stale proof yet', {
          sessionId,
          studioId: row.id,
          reason: opts.reason,
        });
        continue;
      }
      if (
        await this.releaseStudio(row.id, row.user_id, row.lease, row.worktree_path, {
          reason: opts.reason ?? 'session-end',
        })
      ) {
        any = true;
      }
    }
    return any;
  }

  /**
   * Boundary release: called when a session's process has provably finished a
   * turn (server run finalized, or CLI stop hook). Releases when the session
   * is terminal OR the lease carries a pendingRelease marker (a close_thread/
   * close_studio requested mid-turn). Returns true when a release happened.
   */
  async releaseAtBoundary(
    sessionId: string,
    opts: { userId?: string; sessionTerminal: boolean; reason: string }
  ): Promise<boolean> {
    let any = false;
    for (const row of await this.studiosHeldBy(sessionId, opts.userId)) {
      if (!opts.sessionTerminal && !row.lease.pendingRelease) continue;
      // A NON-terminal boundary completes only what the marker still
      // justifies (Lumen r2): a thread-scoped marker whose lease has since
      // multiplexed other threads reconciles to a key-removal — the session
      // lives, keeps the studio, and only the closed thread exits. A
      // terminal session's process is gone from the tree, so the whole
      // lease releases regardless of what the set carries.
      const marker = row.lease.pendingRelease;
      if (!opts.sessionTerminal && marker?.threadKey) {
        const others = leaseThreadKeys(row.lease).filter((k) => k !== marker.threadKey);
        if (others.length > 0) {
          const reconciled: StudioLease = {
            ...row.lease,
            threadKeys: others,
            pendingRelease: undefined,
          };
          if (await this.casLease(row.id, row.user_id, row.lease, reconciled)) {
            logger.info(
              '[StudioLease] Thread-close marker reconciled at boundary — lease survives for remaining threads',
              {
                studioId: row.id,
                sessionId,
                closedThreadKey: marker.threadKey,
                remaining: others,
              }
            );
          }
          // A lost CAS leaves the marker for the next boundary or the sweep.
          continue;
        }
      }
      if (
        await this.releaseStudio(row.id, row.user_id, row.lease, row.worktree_path, {
          reason: marker?.reason ?? opts.reason,
          closingThreadKey: marker?.threadKey,
        })
      ) {
        any = true;
      }
    }
    return any;
  }

  /**
   * Release what this session holds, immediately. Captures final worktree
   * state (branch/commit/dirty) and stamps it into the owning thread's
   * metadata so "what did they leave behind" is answerable after the fact.
   * Quarantine records are not releasable this way — they heal through rescue.
   */
  async releaseBySession(
    sessionId: string,
    opts: { userId?: string; reason?: string } = {}
  ): Promise<boolean> {
    let any = false;
    for (const row of await this.studiosHeldBy(sessionId, opts.userId)) {
      if (
        await this.releaseStudio(row.id, row.user_id, row.lease, row.worktree_path, {
          reason: opts.reason ?? 'session-end',
        })
      ) {
        any = true;
      }
    }
    return any;
  }

  /**
   * Release a studio's lease, or mark it pendingRelease when the holder's
   * process is still live. Wired into close_studio. Never releases a live
   * holder's worktree out from under it — the boundary completes the release.
   */
  async releaseByStudio(
    studioId: string,
    opts: { userId: string; reason?: string }
  ): Promise<'released' | 'deferred' | 'none'> {
    const { data } = await this.supabase
      .from('studios')
      .select('id, user_id, lease, worktree_path')
      .eq('id', studioId)
      .eq('user_id', opts.userId)
      .not('lease', 'is', null)
      .maybeSingle();
    const lease = parseStudioLease(data?.lease);
    if (!data || !lease || lease.quarantined) return 'none';

    // Same conservative rule as adoption: a fresh non-terminal holder is
    // presumed live (admission gap) — defer, never clear.
    if (!(await this.canReleaseNow(lease, opts.userId))) {
      const marked = await this.markPendingRelease(
        data.id,
        data.user_id,
        lease,
        opts.reason ?? 'studio-closed'
      );
      return marked ? 'deferred' : 'none';
    }

    const released = await this.releaseStudio(data.id, data.user_id, lease, data.worktree_path, {
      reason: opts.reason ?? 'studio-closed',
    });
    return released ? 'released' : 'none';
  }

  /**
   * Release every studio this user's thread holds — deferring, not clearing,
   * any lease whose holder process is still live (close_thread is commonly
   * called from inside the holder's own turn; clearing then would hand the
   * worktree to another thread while the process is still cd'd into it).
   */
  async releaseByThread(
    userId: string,
    threadKey: string,
    opts: { reason?: string } = {}
  ): Promise<{ released: number; deferred: number; removed: number; studioIds: string[] }> {
    // Membership is against the LIVE SET, not the scalar (v18 S2): a
    // multiplexed key never appears in `lease->>threadKey`, and a scalar
    // whose key was already removed from the set must not match again.
    // Leased studios per user are few — read them all and filter parsed.
    const { data } = await this.supabase
      .from('studios')
      .select('id, user_id, lease, worktree_path')
      .eq('user_id', userId)
      .not('lease', 'is', null);
    if (!data?.length) return { released: 0, deferred: 0, removed: 0, studioIds: [] };

    let released = 0;
    let deferred = 0;
    let removed = 0;
    // Every studio whose lease the thread rode, whatever the outcome — the
    // caller feeds these to ephemeral teardown as candidates, because after a
    // whole-lease release nothing on the row remembers the closing thread
    // (`studios.thread_key` is the CREATED-FOR thread, and the last live key
    // need not be it — Lumen r1 P1-2).
    const studioIds: string[] = [];
    for (const row of data) {
      const initial = parseStudioLease(row.lease);
      if (!initial || initial.quarantined) continue;
      if (!leaseThreadKeys(initial).includes(threadKey)) continue;
      studioIds.push(row.id);
      const outcome = await this.releaseThreadFromLease(
        row.id,
        row.user_id,
        initial,
        row.worktree_path,
        threadKey,
        opts.reason ?? 'thread-closed'
      );
      if (outcome === 'released') released += 1;
      else if (outcome === 'deferred') deferred += 1;
      else if (outcome === 'removed') removed += 1;
    }
    return { released, deferred, removed, studioIds };
  }

  /**
   * One thread's exit from one lease (v18 S2). The minimal close invariant
   * (Lumen r2): while any OTHER live key remains, closing this thread
   * CAS-removes its key from the set and nothing more — the lease, the
   * holder, and the worktree all survive. Only the LAST key's close reaches
   * the whole-lease release/defer. The branch is re-decided from a fresh
   * read after every lost CAS, because which case applies can change under
   * us — a concurrent close of the sibling key turns "remove mine" into
   * "mine is now the last key". The scalar `threadKey` is first-acquisition
   * telemetry and is never rewritten; a stamped pendingRelease is carried
   * forward untouched (protection is never erased by bookkeeping).
   */
  private async releaseThreadFromLease(
    studioId: string,
    userId: string,
    initial: StudioLease,
    worktreePath: string | null,
    threadKey: string,
    reason: string
  ): Promise<'released' | 'deferred' | 'removed' | 'none'> {
    let lease = initial;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remaining = leaseThreadKeys(lease).filter((k) => k !== threadKey);

      if (remaining.length === 0) {
        // Last key — but "last" is only true until proven by a winning CAS.
        // An append racing this close turns [A] into [A,B] between our read
        // and our write; a whole-lease stamp or clear that retried blindly
        // from the NEW state would defer live B to death at the holder's
        // boundary, and a plain failure would strand closed A in the set
        // (Lumen r1 P1-1). So both transitions here are SINGLE exact-state
        // CASes — a loss falls through to the re-read, which re-decides the
        // branch from what actually won.
        // Same conservative rule as adoption: a fresh non-terminal holder is
        // presumed live (admission gap) — defer, never clear.
        if (!(await this.canReleaseNow(lease, userId))) {
          // The marker records WHICH thread's close asked (Lumen r2): an
          // append landing after this stamp is legitimate, and the boundary
          // must not release it underneath — it reconciles thread-scoped
          // markers instead of clearing whole-lease.
          const marked: StudioLease = {
            ...lease,
            pendingRelease: { reason, requestedAt: new Date().toISOString(), threadKey },
          };
          if (await this.casLease(studioId, userId, lease, marked)) {
            logger.info('[StudioLease] Release deferred to holder boundary (pendingRelease)', {
              studioId,
              sessionId: lease.sessionId,
              reason,
            });
            return 'deferred';
          }
        } else if (
          await this.releaseStudio(studioId, userId, lease, worktreePath, {
            reason,
            closingThreadKey: threadKey,
          })
        ) {
          return 'released';
        }
        // Lost the CAS — fall through to re-read and re-decide.
      } else {
        const trimmed: StudioLease = { ...lease, threadKeys: remaining };
        if (await this.casLease(studioId, userId, lease, trimmed)) {
          logger.info('[StudioLease] Thread key removed from multiplexed lease', {
            studioId,
            sessionId: lease.sessionId,
            threadKey,
            remaining,
          });
          return 'removed';
        }
      }

      const reread = await this.getLease(studioId, userId);
      if (!reread?.lease || reread.lease.sessionId !== lease.sessionId) return 'none';
      if (!leaseThreadKeys(reread.lease).includes(threadKey)) return 'none';
      lease = reread.lease;
    }
    logger.warn('[StudioLease] Failed to remove thread key after retries', {
      studioId,
      sessionId: initial.sessionId,
      threadKey,
    });
    return 'none';
  }

  /**
   * Stamp pendingRelease onto a live holder's lease (CAS-guarded; retries
   * once against a racing renewal). The run/stop boundary or the sweep
   * completes the release once the process leaves the worktree.
   */
  private async markPendingRelease(
    studioId: string,
    userId: string,
    lease: StudioLease,
    reason: string
  ): Promise<boolean> {
    let current = lease;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const marked: StudioLease = {
        ...current,
        pendingRelease: { reason, requestedAt: new Date().toISOString() },
      };
      if (await this.casLease(studioId, userId, current, marked)) {
        logger.info('[StudioLease] Release deferred to holder boundary (pendingRelease)', {
          studioId,
          sessionId: current.sessionId,
          reason,
        });
        return true;
      }
      const reread = await this.getLease(studioId, userId);
      if (!reread?.lease || reread.lease.sessionId !== current.sessionId) return false;
      current = reread.lease;
    }
    logger.warn('[StudioLease] Failed to mark pendingRelease after retries (sweep will backstop)', {
      studioId,
      sessionId: lease.sessionId,
      reason,
    });
    return false;
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
    opts: { reason: string; closingThreadKey?: string }
  ): Promise<boolean> {
    const cleared = await this.casLease(studioId, userId, lease, null);
    if (!cleared) return false;

    await this.repointSessionsOffEphemeral(studioId, userId);

    const finalState = worktreePath ? await captureWorktreeState(worktreePath) : undefined;

    const heldMs = Date.now() - Date.parse(lease.acquiredAt);
    await this.logEvent(userId, studioId, 'released', {
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

    // A thread-close release stamps the CLOSING thread's record — under
    // multiplexing the last live key need not be the scalar first-acquirer.
    await this.stampThreadFinalState(
      userId,
      opts.closingThreadKey ?? lease.threadKey,
      studioId,
      finalState
    );
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
   * Heartbeat sweep. For each leased studio:
   *
   *   - pendingRelease whose holder is no longer live → complete the deferred
   *     release (boundary backstop).
   *   - stale lease with a live process → renew on the holder's behalf.
   *   - stale lease, holder gone → CAS-claim to a recovery quarantine (unique
   *     token), rescue, then clear to vacancy ('expired'). Failed rescue
   *     keeps the quarantine; stale quarantines are retried the same way.
   */
  async sweepExpiredLeases(): Promise<{
    expired: number;
    renewed: number;
    quarantined: number;
    released: number;
  }> {
    const { data, error } = await this.supabase
      .from('studios')
      .select('id, user_id, lease, worktree_path, ephemeral, expires_at')
      .not('lease', 'is', null);
    if (error || !data?.length) return { expired: 0, renewed: 0, quarantined: 0, released: 0 };

    let expired = 0;
    let renewed = 0;
    let quarantined = 0;
    let released = 0;
    for (const row of data) {
      const lease = parseStudioLease(row.lease);
      if (!lease) continue;

      // Deferred-release backstop for holders whose boundary never fires
      // (crashed processes, closed terminals). An open turn marker always
      // defers; beyond that, completion requires the real-boundary proof
      // below — an idle attached terminal therefore keeps its deferred
      // release pending (bounded delay), because its "done-ness" cannot be
      // proven from here, only from its own stop event.
      if (lease.pendingRelease && !lease.quarantined) {
        if (!(await this.isSessionMidTurn(lease.sessionId, row.user_id))) {
          // Completion authority lives at REAL boundaries only: the holder's
          // stop event (releaseAtBoundary), a terminal session, or presence
          // loss. Six review rounds proved client-pushed testimony cannot
          // safely AUTHORIZE a release — every proof scheme leaked at an
          // ownership or visibility boundary — so the sweep completes a
          // pendingRelease only when the holder is provably gone
          // (canReleaseNow: not live AND (stale OR terminal)). The accepted
          // residual: an idle holder whose terminal stays open keeps its
          // pendingRelease deferred (and renewed below) until its next stop
          // boundary or the terminal closes — delayed, never premature.
          if (await this.canReleaseNow(lease, row.user_id)) {
            // Whole-lease even for a thread-scoped marker: canReleaseNow
            // means the holder is provably GONE, so the lease serves nobody
            // — reconciling here would leave a dead session holding a tree.
            // Multiplexed survivors re-acquire vacant on their next message.
            const ok = await this.releaseStudio(row.id, row.user_id, lease, row.worktree_path, {
              reason: lease.pendingRelease.reason,
              closingThreadKey: lease.pendingRelease.threadKey,
            });
            if (ok) released += 1;
            continue;
          }
        }
      }

      if (!isLeaseStale(lease)) continue;

      if (!lease.quarantined && (await this.isSessionLive(lease.sessionId, row.user_id))) {
        // S1 (spec v18): the second renewal path. A live holder verifiably
        // operating elsewhere must not get an expired ephemeral renewed on
        // its behalf — stamp pendingRelease instead. Protection, never
        // authorization: completion still happens only at the holder's real
        // boundary (releaseAtBoundary honors the marker at the next stop
        // event) or once presence is genuinely lost (canReleaseNow).
        if (
          !lease.pendingRelease &&
          (await this.isEphemeralHeldElsewhere(
            {
              ephemeral: row.ephemeral === true,
              expires_at: row.expires_at ?? null,
              worktree_path: row.worktree_path,
            },
            lease,
            row.user_id
          ))
        ) {
          await this.markPendingRelease(row.id, row.user_id, lease, 'expired-elsewhere-held');
          continue;
        }
        const ok = await this.renewBySession(lease.sessionId, row.user_id);
        if (ok) renewed += 1;
        continue;
      }

      // Fence: convert the stale lease (or stale quarantine) into a fresh
      // recovery claim. A concurrent renewal or acquisition defeats this.
      const claim = this.claimRecord(
        lease,
        'recovery',
        lease.quarantined ? 'quarantine:retry' : 'quarantine:expiry-claim'
      );
      const claimWon = await this.casLease(row.id, row.user_id, lease, claim);
      if (!claimWon) continue; // renewed, released, or acquired concurrently — not ours

      const hasPath = Boolean(row.worktree_path);
      const present = hasPath && (await worktreePresent(row.worktree_path));

      // A configured-but-ABSENT worktree is a dead studio (round 7): finalize
      // to cleaned + lease NULL in ONE claim-guarded CAS — never publish it
      // back as an acquirable vacancy pointing at a nonexistent cwd. Covers
      // interrupted teardowns and externally deleted worktrees alike.
      if (hasPath && !present) {
        const finalized = await this.finalizeTeardown(row.id, row.user_id, claim);
        if (finalized) {
          logger.warn('[StudioLease] Retired studio with absent worktree', {
            studioId: row.id,
            worktreePath: row.worktree_path,
            priorClaimKind: lease.claimKind ?? null,
          });
          await this.logEvent(row.user_id, row.id, 'released', {
            sessionId: claim.holderSessionId,
            threadKey: claim.heldThreadKey,
            agentId: lease.agentId,
            sbId: lease.sbId,
            reason:
              lease.claimKind === 'teardown'
                ? 'teardown-finalized-worktree-absent'
                : 'worktree-absent-retired',
          });
          released += 1;
        }
        continue;
      }

      // An absent worktree has nothing to rescue — a capture error there is
      // not a failed rescue, and must not quarantine forever.
      const rescue = present
        ? await captureWorktreeState(row.worktree_path as string, {
            rescue: true,
            rescueLabel: claim.heldThreadKey ?? lease.threadKey,
          })
        : undefined;

      if (rescue && !rescueSucceeded(rescue)) {
        quarantined += 1;
        logger.error('[StudioLease] Expiry rescue failed — studio quarantined until next sweep', {
          studioId: row.id,
          holder: { sessionId: claim.holderSessionId, threadKey: claim.heldThreadKey },
          rescue,
        });
        await this.logEvent(row.user_id, row.id, 'conflict', {
          sessionId: claim.holderSessionId,
          threadKey: claim.heldThreadKey,
          agentId: lease.agentId,
          sbId: lease.sbId,
          reason: 'expiry-rescue-failed-quarantined',
          detail: { rescue: rescue as unknown as Json },
        });
        continue;
      }

      // The clear must actually WIN before anything is reported (Lumen r1 on
      // PR #550): a claim replaced underneath — another worker's fresh claim,
      // a concurrent acquisition — means this expiry did not happen. Falling
      // through would repoint sessions, emit an 'expired' event, and count a
      // release that never cleared.
      const cleared = await this.casLease(row.id, row.user_id, claim, null);
      if (!cleared) continue;
      await this.repointSessionsOffEphemeral(row.id, row.user_id);

      const heldMs = Date.now() - Date.parse(lease.acquiredAt);
      logger.warn('[StudioLease] Lease expired and was released', {
        studioId: row.id,
        sessionId: claim.holderSessionId,
        threadKey: claim.heldThreadKey,
        staleSince: lease.heartbeatAt || lease.acquiredAt,
        finalState: rescue,
      });
      await this.logEvent(row.user_id, row.id, 'expired', {
        sessionId: claim.holderSessionId,
        threadKey: claim.heldThreadKey,
        agentId: lease.agentId,
        sbId: lease.sbId,
        reason: lease.quarantined
          ? 'quarantine-recovered'
          : `no heartbeat since ${lease.heartbeatAt || lease.acquiredAt}`,
        detail: {
          heldMs: Number.isNaN(heldMs) ? null : heldMs,
          finalState: (rescue ?? null) as unknown as Json,
        },
      });
      if (claim.heldThreadKey) {
        await this.stampThreadFinalState(row.user_id, claim.heldThreadKey, row.id, rescue);
      }
      expired += 1;
    }
    return { expired, renewed, quarantined, released };
  }

  /**
   * Atomically claim a studio for teardown. The claim is a quarantine-style
   * lease with a unique token that `acquire` refuses — closing the
   * acquire-between-check-and-remove race. Returns the claim on success,
   * null when the studio must not be torn down now.
   *
   * Claimable states:
   *   - vacant (lease IS NULL)
   *   - a STALE quarantine/claim (a fresh one belongs to a worker that is
   *     mid-rescue or mid-removal RIGHT NOW — stealing it would run two
   *     destructive operations concurrently)
   *   - a lease held by `expectedThreadKey` whose holder process is not live
   */
  async claimForTeardown(
    studioId: string,
    userId: string,
    opts: { expectedThreadKey?: string; reason: string }
  ): Promise<StudioLease | null> {
    const current = await this.getLease(studioId, userId);
    if (!current) return null;
    const holder = current.lease;

    const claim = this.claimRecord(holder, 'teardown', opts.reason, opts.expectedThreadKey);

    if (!holder) {
      const { data } = await this.supabase
        .from('studios')
        .update({ lease: claim as unknown as Json })
        .eq('id', studioId)
        .eq('user_id', userId)
        .is('lease', null)
        .select('id');
      return data?.length ? claim : null;
    }

    if (holder.quarantined) {
      if (!isLeaseStale(holder)) {
        logger.info('[StudioLease] Teardown claim refused — active claim in progress', {
          studioId,
          claimKind: holder.claimKind ?? null,
        });
        return null;
      }
      return (await this.casLease(studioId, userId, holder, claim)) ? claim : null;
    }

    const live = leaseThreadKeys(holder);
    if (opts.expectedThreadKey && live.includes(opts.expectedThreadKey)) {
      // The minimal close invariant (v18 S2, Lumen r2): a lease still
      // multiplexing OTHER live threads is never torn down — `studios
      // .thread_key` selected this studio as a candidate, but the empty set
      // plus a valid holder boundary is what authorizes. Membership is
      // against the live set: the last surviving key need not be the scalar
      // first-acquirer.
      const others = live.filter((k) => k !== opts.expectedThreadKey);
      if (others.length > 0) {
        logger.info('[StudioLease] Teardown claim refused — other threads still multiplex lease', {
          studioId,
          expectedThreadKey: opts.expectedThreadKey,
          remainingThreadKeys: others,
        });
        return null;
      }
      // Same release-now proof as everywhere else: a fresh non-terminal
      // holder is presumed live (admission gap) — never torn down under it.
      if (!(await this.canReleaseNow(holder, userId))) {
        logger.warn('[StudioLease] Teardown claim refused — holder lacks terminal/stale proof', {
          studioId,
          holderSessionId: holder.sessionId,
        });
        return null;
      }
      return (await this.casLease(studioId, userId, holder, claim)) ? claim : null;
    }

    logger.warn('[StudioLease] Teardown claim refused — studio held by another thread', {
      studioId,
      holderThreadKey: holder.threadKey,
      expectedThreadKey: opts.expectedThreadKey ?? null,
    });
    return null;
  }

  /**
   * Token revalidation before destruction: is this exact claim (by unique
   * token) still on the studio? A stolen or aged-out claim must abort the
   * destructive step.
   */
  async verifyClaim(studioId: string, userId: string, claim: StudioLease): Promise<boolean> {
    const current = await this.getLease(studioId, userId);
    return current?.lease?.sessionId === claim.sessionId;
  }

  /** Clear a teardown claim (post-removal, or when aborting a claim taken in error). */
  async clearTeardownClaim(studioId: string, userId: string, claim: StudioLease): Promise<boolean> {
    return this.casLease(studioId, userId, claim, null);
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
