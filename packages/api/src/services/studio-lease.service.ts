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
import { access } from 'fs/promises';
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
  pendingRelease?: { reason: string; requestedAt: string };
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
        ? { reason: pending.reason, requestedAt: pending.requestedAt }
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
    return Boolean(data?.length);
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

    // 2) Same thread — the lease follows the thread, but only away from a
    //    holder that is provably TERMINAL or STALE-and-not-live. Liveness
    //    probes alone have an admission gap: a session acquires its lease in
    //    getOrCreateSession before its run registers, so "not live right now"
    //    does not mean "not about to run". Presume a fresh lease live.
    if (holder.threadKey === req.threadKey) {
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
   * Bump heartbeatAt for whichever studio this session holds. Called from the
   * CLI lifecycle hook route on every prompt, and by the sweep for sessions
   * with a live process. Never renews a quarantine record — quarantine heals
   * through rescue, not heartbeats.
   */
  async renewBySession(sessionId: string, userId?: string): Promise<boolean> {
    let query = this.supabase
      .from('studios')
      .select('id, user_id, lease')
      .eq('lease->>sessionId', sessionId);
    if (userId) query = query.eq('user_id', userId);
    const { data } = await query.limit(1).maybeSingle();
    const lease = parseStudioLease(data?.lease);
    if (!data || !lease || lease.quarantined) return false;

    const renewed: StudioLease = { ...lease, heartbeatAt: new Date().toISOString() };
    return this.casLease(data.id, data.user_id, lease, renewed);
  }

  /**
   * Release whatever this session holds — but only once the session's process
   * has actually left the worktree (no in-process run, no freshly-polling
   * attached CLI). Deferred releases are picked up at the corresponding run
   * boundary: SessionService's finalized branch for server runs, the
   * lifecycle stop hook for CLI turns, the sweep as backstop.
   */
  async releaseUnlessRunning(
    sessionId: string,
    opts: { userId?: string; reason?: string } = {}
  ): Promise<boolean> {
    let query = this.supabase
      .from('studios')
      .select('id, user_id, lease, worktree_path')
      .eq('lease->>sessionId', sessionId);
    if (opts.userId) query = query.eq('user_id', opts.userId);
    const { data } = await query.limit(1).maybeSingle();
    const lease = parseStudioLease(data?.lease);
    if (!data || !lease || lease.quarantined) return false;

    if (!(await this.canReleaseNow(lease, opts.userId ?? data.user_id))) {
      logger.info('[StudioLease] Release deferred — no safe terminal/stale proof yet', {
        sessionId,
        reason: opts.reason,
      });
      return false;
    }
    return this.releaseStudio(data.id, data.user_id, lease, data.worktree_path, {
      reason: opts.reason ?? 'session-end',
    });
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
    let query = this.supabase
      .from('studios')
      .select('id, user_id, lease, worktree_path')
      .eq('lease->>sessionId', sessionId);
    if (opts.userId) query = query.eq('user_id', opts.userId);
    const { data } = await query.limit(1).maybeSingle();
    const lease = parseStudioLease(data?.lease);
    if (!data || !lease || lease.quarantined) return false;

    if (!opts.sessionTerminal && !lease.pendingRelease) return false;

    return this.releaseStudio(data.id, data.user_id, lease, data.worktree_path, {
      reason: lease.pendingRelease?.reason ?? opts.reason,
    });
  }

  /**
   * Release whatever this session holds, immediately. Captures final worktree
   * state (branch/commit/dirty) and stamps it into the owning thread's
   * metadata so "what did they leave behind" is answerable after the fact.
   * Quarantine records are not releasable this way — they heal through rescue.
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
    const lease = parseStudioLease(data?.lease);
    if (!data || !lease || lease.quarantined) return false;

    return this.releaseStudio(data.id, data.user_id, lease, data.worktree_path, {
      reason: opts.reason ?? 'session-end',
    });
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
  ): Promise<{ released: number; deferred: number }> {
    const { data } = await this.supabase
      .from('studios')
      .select('id, user_id, lease, worktree_path')
      .eq('user_id', userId)
      .eq('lease->>threadKey', threadKey);
    if (!data?.length) return { released: 0, deferred: 0 };

    let released = 0;
    let deferred = 0;
    for (const row of data) {
      const lease = parseStudioLease(row.lease);
      if (!lease || lease.quarantined) continue;

      // Same conservative rule as adoption: a fresh non-terminal holder is
      // presumed live (admission gap) — defer, never clear.
      if (!(await this.canReleaseNow(lease, userId))) {
        const marked = await this.markPendingRelease(
          row.id,
          row.user_id,
          lease,
          opts.reason ?? 'thread-closed'
        );
        if (marked) deferred += 1;
        continue;
      }

      const ok = await this.releaseStudio(row.id, row.user_id, lease, row.worktree_path, {
        reason: opts.reason ?? 'thread-closed',
      });
      if (ok) released += 1;
    }
    return { released, deferred };
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
    opts: { reason: string }
  ): Promise<boolean> {
    const cleared = await this.casLease(studioId, userId, lease, null);
    if (!cleared) return false;

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
      .select('id, user_id, lease, worktree_path')
      .not('lease', 'is', null);
    if (error || !data?.length) return { expired: 0, renewed: 0, quarantined: 0, released: 0 };

    let expired = 0;
    let renewed = 0;
    let quarantined = 0;
    let released = 0;
    for (const row of data) {
      const lease = parseStudioLease(row.lease);
      if (!lease) continue;

      // Deferred-release backstop: the boundary should have completed this,
      // but a killed CLI or crashed server never fires its boundary. Same
      // release-now proof as everywhere else.
      if (lease.pendingRelease && !lease.quarantined) {
        if (await this.canReleaseNow(lease, row.user_id)) {
          const ok = await this.releaseStudio(row.id, row.user_id, lease, row.worktree_path, {
            reason: lease.pendingRelease.reason,
          });
          if (ok) released += 1;
          continue;
        }
      }

      if (!isLeaseStale(lease)) continue;

      if (!lease.quarantined && (await this.isSessionLive(lease.sessionId, row.user_id))) {
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

      await this.casLease(row.id, row.user_id, claim, null);

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

    if (opts.expectedThreadKey && holder.threadKey === opts.expectedThreadKey) {
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
