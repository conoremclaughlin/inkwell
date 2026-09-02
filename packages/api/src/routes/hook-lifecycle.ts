/**
 * Hook Lifecycle Routes
 *
 * REST endpoints for deterministic session lifecycle management.
 * Called by CLI hooks (on-prompt, on-stop, pre-compact, post-compact) — NOT by agents.
 * Bypasses MCP entirely so lifecycle state stays out of agent-facing tool schemas.
 *
 * Auth: same JWT token used by MCP requests. Hooks already have it via getValidAccessToken().
 * Ownership: verifies the session belongs to the authenticated user before mutating.
 */

import { Router, type Request, type Response } from 'express';
import type { DataComposer } from '../data/composer';
import { PcpAuthProvider } from '../mcp/auth/pcp-auth-provider';
import { StudioLeaseService } from '../services/studio-lease.service';
import { releaseGraphClaimsForSession } from '../services/graph-executor.service';
import { logger } from '../utils/logger';

const VALID_LIFECYCLES = ['running', 'idle', 'compacting', 'completed', 'failed'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Lifecycle = (typeof VALID_LIFECYCLES)[number];

export function createHookLifecycleRouter(dataComposer: DataComposer): Router {
  const router = Router();
  const authProvider = new PcpAuthProvider();
  const leaseService = new StudioLeaseService(dataComposer.getClient());

  /**
   * POST /api/hooks/lifecycle
   *
   * Update a session's lifecycle state. Called by CLI hooks:
   *   on-prompt  → lifecycle: 'running'
   *   on-stop    → lifecycle: 'idle'
   *   pre-compact → lifecycle: 'compacting'
   *   post-compact → lifecycle: 'idle'
   *
   * Body: { sessionId, lifecycle, agentId?, workingDir? }
   * Auth: Bearer token (same as MCP)
   */
  router.post('/lifecycle', async (req: Request, res: Response) => {
    try {
      // Authenticate using same JWT as MCP requests
      const userData = authProvider.verifyAccessToken(req.headers.authorization);
      if (!userData) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const {
        sessionId,
        lifecycle,
        event,
        agentId,
        workingDir,
        cliAttached,
        cliPollAt,
        alias,
        studioId,
        headless,
        reclaimOf,
        turnEpoch,
        turnEpochMissing,
      } = req.body as {
        sessionId?: string;
        lifecycle?: string;
        /**
         * Which hook fired: 'prompt' | 'stop' | 'pre-compact' | 'post-compact'.
         * Lifecycle values alone are ambiguous — post-compact also sends
         * 'idle' while the same turn continues, so ONLY event === 'stop'
         * marks the real CLI turn boundary. Legacy senders without the
         * field get renewals but never boundary releases.
         */
        event?: string;
        agentId?: string;
        workingDir?: string;
        cliAttached?: boolean;
        cliPollAt?: string;
        alias?: string;
        /** Caller's worktree studio, for the fenced lease-held report. */
        studioId?: string;
        /**
         * Server-spawned turn: the server's pre-turn write already owns the
         * turn epoch, so a prompt event must NOT claim a fresh one — rotating
         * here would fence the server's own finalize out of its turn
         * (PR #563 round 6).
         */
        headless?: boolean;
        /**
         * Marker-reclaim (round 9): the pending-takeover marker's birth time.
         * The claim is CASed against the stop tombstone — a stop newer than
         * this refuses the claim atomically, so a parked reclaim can never
         * re-mark a finished turn as running.
         */
        reclaimOf?: string;
        /**
         * Stop events (round 10): the epoch of the CLI turn that is ending,
         * round-tripped from the prompt claim's response via the on-prompt
         * hook's epoch record. The lease boundary fences on it — the server
         * cannot infer which turn a stop ends, because a successor may
         * already own the row when a late stop lands. Absent for legacy
         * senders: their boundary releases unfenced, as before.
         */
        turnEpoch?: string;
        /**
         * Round 11: a MODERN stop whose epoch record is unavailable (local
         * write failed, record lost). Distinguishes "legacy sender" from
         * "epoch expected but missing" — the latter FAILS CLOSED: no row
         * stop-write, no destructive boundary releases; the sweep and the
         * detach boundary recover the session instead.
         */
        turnEpochMissing?: boolean;
      };

      if (!sessionId) {
        res.status(400).json({ success: false, error: 'sessionId is required' });
        return;
      }

      // Reject non-UUID session ids BEFORE they reach Postgres. Without this,
      // a malformed id (e.g. a test fixture like "sess-1" leaking from an
      // integration run pointed at this server) raises 22P02 inside
      // getSession, and every such request error-spams the log with a stack
      // trace for what is simply bad caller input.
      if (!UUID_RE.test(sessionId)) {
        res.status(400).json({ success: false, error: 'sessionId must be a UUID' });
        return;
      }

      // lifecycle is required unless cliAttached, cliPollAt, or alias is the only update
      if (
        (!lifecycle || !VALID_LIFECYCLES.includes(lifecycle as Lifecycle)) &&
        cliAttached === undefined &&
        cliPollAt === undefined &&
        alias === undefined
      ) {
        res.status(400).json({
          success: false,
          error: `lifecycle must be one of: ${VALID_LIFECYCLES.join(', ')}`,
        });
        return;
      }

      // Verify session ownership before mutating
      const session = await dataComposer.repositories.memory.getSession(sessionId);
      if (!session) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }
      if (session.userId !== userData.userId) {
        res.status(403).json({ success: false, error: 'Session does not belong to this user' });
        return;
      }

      const updates: {
        lifecycle?: string;
        workingDir?: string;
        cliAttached?: boolean;
        cliPollAt?: string;
        cliTurnAt?: string | null;
        cliTurnStoppedAt?: string | null;
        alias?: string | null;
      } = {};
      if (lifecycle) updates.lifecycle = lifecycle;
      if (workingDir) updates.workingDir = workingDir;
      if (cliAttached !== undefined) updates.cliAttached = cliAttached;
      if (cliPollAt) updates.cliPollAt = cliPollAt;
      if (alias !== undefined) updates.alias = alias || null;

      // Hook-owned CLI turn signal: on-prompt opens the turn, and ONLY the
      // real on-stop closes it (post-compact 'idle' leaves it set — the same
      // turn resumes). Lease liveness reads this, so terminal APIs can never
      // hide a live turn or resurrect a dead one. The signal has no wall-time
      // expiry; its crash recovery is the DETACH boundary — an explicit
      // cliAttached:false (headless reconcile, plugin disconnect) is process
      // proof that any interactive turn's process is gone. An ATTACH
      // (cliAttached:true) must NOT clear it: the CLI re-asserts attachment
      // right after every prompt event, and clearing there would kill the
      // marker the prompt just opened, leaving no-plugin CLIs unprotected for
      // the whole turn (PR #492 round 6). Legacy senders without the event
      // field: infer prompt from lifecycle 'running' (safe — it only extends
      // protection), never infer stop.
      if (cliAttached === false) updates.cliTurnAt = null;
      const isPromptEvent = event === 'prompt' || (!event && lifecycle === 'running');
      const isStopEvent = event === 'stop';
      // Round 11: a modern stop names the epoch it is ending, or admits the
      // record is missing. Only a LEGACY stop (neither field) still performs
      // the unfenced idle + marker-clear + tombstone write below — modern
      // stops go through the epoch CAS, and a modern stop with a lost record
      // writes nothing (fail closed; the detach boundary and sweep recover).
      const stopEpoch = isStopEvent && typeof turnEpoch === 'string' ? turnEpoch : undefined;
      const stopEpochMissing = isStopEvent && !stopEpoch && turnEpochMissing === true;
      if (isPromptEvent) updates.cliTurnAt = new Date().toISOString();
      if (isStopEvent && !stopEpoch && !stopEpochMissing) {
        updates.cliTurnAt = null;
        // The stop tombstone (round 9): the atomic revocation record every
        // later marker-reclaim CASes against.
        updates.cliTurnStoppedAt = new Date().toISOString();
      }
      if (stopEpoch || stopEpochMissing) {
        // Modern stops never write lifecycle through the unfenced path.
        delete updates.lifecycle;
      }

      // Ownership claim (PR #563 round 4). A CLI prompt taking over a session
      // whose row is STUCK at `running` is a running → running write — no
      // lifecycle transition for the epoch trigger to see, and this route
      // writes no metadata — so a stale server turn's fenced finalize would
      // still match its old epoch and clobber this CLI session's state.
      // claim_turn_epoch is one atomic jsonb_set: fresh epoch, no
      // read-modify-write replay window, and every stale fence goes dark.
      // Claimed BEFORE the lifecycle write so a failure here fails the whole
      // prompt visibly instead of leaving an unfenced takeover.
      let claimedEpoch: string | undefined;
      if (isPromptEvent && !headless) {
        // Rounds 4–5: claim_turn_epoch(p_set_running) is ONE statement —
        // fresh epoch, lifecycle=running, and the turn marker together. A
        // claim can no longer succeed while the lifecycle write fails, which
        // would have stolen ownership with no running state behind it.
        // Round 9: a RECLAIM additionally CASes against the stop tombstone —
        // zero rows means the turn already stopped, and the reclaim must
        // report that distinctly so the caller retires its marker.
        // Round 12: the claim and the lease protection are ONE atomic
        // success boundary. The RPC locks the studio row, verifies the
        // lease still belongs to this session, and only then claims the
        // epoch + stamps EVERY lease the session holds (round 13) — a lost
        // lease refuses the WHOLE takeover with nothing committed.
        const claimStudioId =
          typeof studioId === 'string' && studioId && studioId !== 'main' ? studioId : undefined;
        // Round 14: the round-13 application-level reacquire is GONE — its
        // vacancy check, grant, and claim were three separate commits, and
        // every seam between them was a boundary failure (revoked studios
        // reacquired under closed threads, the release's repoint racing the
        // grant, a stopped retry stranding a fresh lease). The regrant now
        // rides INTO the claim: one RPC, one studio row lock, one
        // transaction. The RPC installs it only when the studio is vacant
        // AND eligible — acquirable status, unexpired, the thread not
        // closed (revocation-aware), no sibling row holding the same
        // checkout — and only AFTER the tombstone CAS passes, so a stopped
        // reclaim grants nothing.
        const regrant = claimStudioId
          ? {
              sessionId,
              threadKey: session.threadKey ?? `session:${sessionId}`,
              threadKeys: [session.threadKey ?? `session:${sessionId}`],
              agentId: agentId ?? session.agentId ?? 'unknown',
              // Round 15: the canonical identity UUID, from the SESSION row
              // (server-trusted) — never just the ambiguous slug.
              ...(session.sbId ? { sbId: session.sbId } : {}),
              reason: 'cli-prompt-regrant',
            }
          : undefined;
        const { data: claimed, error: claimError } = await dataComposer
          .getClient()
          .rpc('claim_turn_epoch', {
            p_session_id: sessionId,
            p_set_running: true,
            ...(reclaimOf ? { p_not_stopped_after: reclaimOf } : {}),
            ...(claimStudioId ? { p_studio_id: claimStudioId } : {}),
            ...(regrant ? { p_regrant: regrant } : {}),
          } as never);
        const verdict = (claimed ?? null) as {
          outcome?: string;
          epoch?: string;
          regranted?: boolean;
        } | null;

        if (!claimError && verdict?.outcome === 'forbidden') {
          // Round 15 P0: the studio belongs to a DIFFERENT user than the
          // session. The RPC refused before touching anything; surface it as
          // an authorization failure, never a lease report.
          logger.error('[HookLifecycle] Cross-tenant claim refused', { sessionId, studioId });
          res.status(403).json({ success: false, error: 'studio does not belong to this user' });
          return;
        }

        if (claimError) {
          logger.error('[HookLifecycle] Turn-epoch claim failed; refusing prompt takeover', {
            sessionId,
            error: claimError.message,
          });
          res.status(500).json({ success: false, error: 'turn-epoch claim failed' });
          return;
        }
        if (verdict?.outcome === 'stopped') {
          if (reclaimOf) {
            logger.info('[HookLifecycle] Reclaim refused; the turn already stopped', {
              sessionId,
            });
            res.status(409).json({ success: false, code: 'stopped' });
            return;
          }
          res.status(500).json({ success: false, error: 'turn-epoch claim matched no session' });
          return;
        }
        if (verdict?.outcome === 'lease-lost') {
          // The lease is gone and the RPC's regrant eligibility refused:
          // another holder, a closed thread (deliberate revocation), an
          // expired or retired studio, or a sibling row on the checkout.
          // Nothing was committed — the caller's failed-takeover handling
          // (gate/block/marker) runs against a CLEAN row.
          logger.warn('[HookLifecycle] Prompt takeover refused — lease no longer held', {
            sessionId,
            studioId,
          });
          res.json({ success: true, sessionId, lifecycle, studioLeaseHeld: false });
          return;
        }
        // Round 13: the verdict space is EXHAUSTIVE — claimed with a string
        // epoch, stopped, or lease-lost. Anything else (legacy function
        // shape, null data, unknown outcome) is an unrecognized contract and
        // must fail closed rather than fall through to a success response
        // that reports held/ownership nothing established.
        if (verdict?.outcome !== 'claimed' || typeof verdict.epoch !== 'string') {
          logger.error('[HookLifecycle] Unrecognized claim verdict; refusing prompt takeover', {
            sessionId,
            verdict: JSON.stringify(verdict ?? null),
          });
          res.status(500).json({ success: false, error: 'unrecognized claim verdict' });
          return;
        }
        claimedEpoch = verdict.epoch;
        // The RPC IS the ownership write — lifecycle and the turn marker
        // landed atomically inside its CAS. Writing them AGAIN below would
        // be a second, UNFENCED ownership write: a stop (idle + tombstone)
        // landing between the RPC and that write would be overwritten and
        // the finished turn re-marked running (round 10). The claim is the
        // single writer for these fields.
        delete updates.lifecycle;
        delete updates.cliTurnAt;
      }

      // Modern stop (round 11): idle + marker clear + tombstone land in ONE
      // epoch-fenced statement. Zero rows means a successor turn owns the
      // row — this stop is LATE, and writing anything (or releasing any
      // resource) would clobber the successor. Report stale and do nothing.
      if (stopEpoch) {
        const { data: stoppedRows, error: stopError } = await dataComposer
          .getClient()
          .from('sessions')
          .update({
            lifecycle: 'idle',
            cli_turn_at: null,
            cli_turn_stopped_at: new Date().toISOString(),
          })
          .eq('id', sessionId)
          .eq('turn_epoch', stopEpoch)
          .select('id');
        if (stopError) {
          logger.error('[HookLifecycle] Fenced stop write failed', {
            sessionId,
            error: stopError.message,
          });
          res.status(500).json({ success: false, error: 'stop write failed' });
          return;
        }
        if (!stoppedRows || stoppedRows.length === 0) {
          logger.info('[HookLifecycle] Stale stop — a successor turn owns the session', {
            sessionId,
            stopEpoch,
          });
          res.json({ success: true, sessionId, lifecycle, stale: true });
          return;
        }
      }

      if (Object.keys(updates).length > 0) {
        // Ride-along bookkeeping (workingDir, attachment, alias). After a
        // COMMITTED ownership write — a claimed prompt, or a fenced stop that
        // matched — two rules (rounds 11–12):
        //   * failure must not report the takeover/stop as failed: the row
        //     already carries the truth, and a 500 makes gated callers block
        //     a turn whose claim landed, stranding the row running.
        //   * the write itself is FENCED on the committed epoch: a late A
        //     ride-along landing after successor B's claim would otherwise
        //     overwrite B's working_dir — which isEphemeralHeldElsewhere()
        //     reads to decide lease renewal/teardown. Zero rows = stale
        //     no-op.
        const committedEpoch = claimedEpoch ?? stopEpoch;
        if (committedEpoch !== undefined) {
          const fencedRideAlong: Record<string, unknown> = {};
          if (updates.workingDir !== undefined) fencedRideAlong.working_dir = updates.workingDir;
          if (updates.cliAttached !== undefined) fencedRideAlong.cli_attached = updates.cliAttached;
          if (updates.cliPollAt !== undefined) fencedRideAlong.cli_poll_at = updates.cliPollAt;
          if (updates.alias !== undefined) fencedRideAlong.alias = updates.alias;
          if (updates.cliTurnAt !== undefined) fencedRideAlong.cli_turn_at = updates.cliTurnAt;
          if (Object.keys(fencedRideAlong).length > 0) {
            try {
              const { data: rideRows, error: rideError } = await dataComposer
                .getClient()
                .from('sessions')
                .update(fencedRideAlong)
                .eq('id', sessionId)
                .eq('turn_epoch', committedEpoch)
                .select('id');
              if (rideError) throw new Error(rideError.message);
              if (!rideRows || rideRows.length === 0) {
                logger.info('[HookLifecycle] Ride-along skipped — a successor owns the row', {
                  sessionId,
                });
              }
            } catch (rideAlongError) {
              logger.warn('[HookLifecycle] Ride-along update failed after a committed claim/stop', {
                sessionId,
                error:
                  rideAlongError instanceof Error ? rideAlongError.message : String(rideAlongError),
              });
            }
          }
        } else {
          const updated = await dataComposer.repositories.memory.updateSession(sessionId, updates);
          if (!updated) {
            res.status(500).json({ success: false, error: 'Failed to update session' });
            return;
          }
        }
      }

      // Lease heartbeat and CLI run boundary. Prompt/compact events renew the
      // lease heartbeat (the primary refresh path, well inside the 30-minute
      // staleness threshold). ONLY the real on-stop hook is the boundary —
      // post-compact also reports lifecycle 'idle' while the same turn
      // continues, so lifecycle alone must never trigger a release. At the
      // boundary, ONE ordered chain runs the release first (terminal session,
      // or a pendingRelease deferred by close_thread/close_studio mid-turn)
      // and renews only if nothing was released — release and renewal must
      // never race each other's heartbeat CAS. Fire-and-forget: never delays
      // the hook response.
      if (isStopEvent && stopEpochMissing) {
        // Round 11, FAIL CLOSED: a modern sender whose epoch record is gone
        // cannot prove which turn this stop ends — destructive boundary
        // effects are suppressed entirely. The lease keeps its heartbeat so
        // nothing rots while the sweep/detach boundary sorts the session out.
        try {
          await leaseService.renewBySession(sessionId, session.userId);
        } catch (err: unknown) {
          logger.debug('[HookLifecycle] Suppressed-stop renewal failed (non-fatal)', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        logger.warn('[HookLifecycle] Stop without epoch record — boundary releases suppressed', {
          sessionId,
        });
        res.json({ success: true, sessionId, lifecycle, suppressed: true });
        return;
      }

      if (isStopEvent) {
        // Captured synchronously at the boundary: the release helper only
        // touches claims from BEFORE this instant, so a delayed release can
        // never take the next turn's claims (Lumen round 3 P1).
        const boundaryAt = new Date().toISOString();
        // Graph claims are turn-scoped: the CLI stop hook IS the real turn
        // boundary. Independent chain, FIRST — a lease-release error must
        // not skip it (round 3 P1); the helper itself never throws.
        // Round 10: the stop identifies the epoch it is ending (round-tripped
        // from the prompt claim). Both resource releases fence on it — a
        // lease or claim a successor turn has since stamped is not this
        // stop's to release. Legacy stops without it release unfenced.
        void releaseGraphClaimsForSession(
          dataComposer.getClient(),
          sessionId,
          'cli-turn-stopped',
          boundaryAt,
          stopEpoch
        ).catch((err: unknown) => {
          logger.warn('[HookLifecycle] CLI-boundary graph claim release failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        void (async () => {
          const postUpdate = await dataComposer.repositories.memory.getSession(sessionId);
          const terminal =
            Boolean(postUpdate?.endedAt) ||
            postUpdate?.status === 'completed' ||
            postUpdate?.lifecycle === 'completed';
          const released = await leaseService.releaseAtBoundary(sessionId, {
            userId: session.userId,
            sessionTerminal: terminal,
            reason: 'cli-turn-stopped',
            expectedTurnEpoch: stopEpoch,
          });
          if (!released) {
            await leaseService.renewBySession(sessionId, session.userId);
          }
        })().catch((err: unknown) => {
          logger.warn('[HookLifecycle] CLI-boundary lease release failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } else {
        // FENCED for prompt events (round four): the renewal is awaited
        // BEFORE the 2xx. The sweep's release CAS is guarded on the exact
        // prior lease (heartbeatAt included), so a renewal that lands first
        // defeats a concurrent release — and if the release already won, the
        // held-check below reads the cleared lease and the response says so,
        // which a gated producer treats as unacknowledged: no turn starts in
        // a worktree whose lease is gone. The old fire-and-forget renewal
        // left a window where a 2xx implied protection the lease no longer
        // had.
        // Round 13: the renewal is a PURE HEARTBEAT. Every lease restamp now
        // happens inside the atomic claim itself (which stamps ALL of the
        // session's leases) — an application-level restamp here was a rewind
        // hazard: a delayed turn A's renewal landing after successor B's
        // claim would stamp B's lease back to A.
        try {
          await leaseService.renewBySession(sessionId, session.userId);
        } catch (err: unknown) {
          logger.debug('[HookLifecycle] Lease renewal failed (non-fatal)', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Per-studio held report for gated prompt callers. HELD requires a
      // successful exact-CAS touch (round five) — a plain read could observe
      // a snapshot an already-running sweep is about to clear, and a failed
      // renewal was silently ignored. Absent for stop events, main, and
      // studioless senders — nothing to fence there.
      let studioLeaseHeld: boolean | undefined;
      if (isPromptEvent && typeof studioId === 'string' && studioId && studioId !== 'main') {
        if (claimedEpoch !== undefined) {
          // Round 12: the claim RPC already verified, locked, and stamped
          // this studio's lease atomically with the epoch claim — reaching
          // here means HELD by construction. A separate touch would be a
          // second read of state the claim just settled.
          studioLeaseHeld = true;
        } else {
          // Headless prompts (server-owned epoch): the exact-CAS touch is
          // still the fenced held report.
          studioLeaseHeld = await leaseService.touchStudioLeaseForSession(
            studioId,
            sessionId,
            session.userId
          );
        }
      }

      logger.debug('[HookLifecycle] Updated', { sessionId, lifecycle, agentId });
      res.json({
        success: true,
        sessionId,
        lifecycle,
        ...(studioLeaseHeld !== undefined ? { studioLeaseHeld } : {}),
        // Round 10: the claimed epoch rides back to the CLI so the eventual
        // stop can identify the turn it is ending.
        ...(claimedEpoch !== undefined ? { turnEpoch: claimedEpoch } : {}),
      });
    } catch (error) {
      logger.error('[HookLifecycle] Error:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  });

  return router;
}
