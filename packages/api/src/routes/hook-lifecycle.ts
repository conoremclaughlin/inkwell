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
      if (isPromptEvent) updates.cliTurnAt = new Date().toISOString();
      if (isStopEvent) {
        updates.cliTurnAt = null;
        // The stop tombstone (round 9): the atomic revocation record every
        // later marker-reclaim CASes against.
        updates.cliTurnStoppedAt = new Date().toISOString();
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
        const { data: claimed, error: claimError } = await dataComposer
          .getClient()
          .rpc('claim_turn_epoch', {
            p_session_id: sessionId,
            p_set_running: true,
            ...(reclaimOf ? { p_not_stopped_after: reclaimOf } : {}),
          } as never);
        if (claimError) {
          logger.error('[HookLifecycle] Turn-epoch claim failed; refusing prompt takeover', {
            sessionId,
            error: claimError.message,
          });
          res.status(500).json({ success: false, error: 'turn-epoch claim failed' });
          return;
        }
        if (reclaimOf && !claimed) {
          logger.info('[HookLifecycle] Reclaim refused; the turn already stopped', { sessionId });
          res.status(409).json({ success: false, code: 'stopped' });
          return;
        }
        claimedEpoch = typeof claimed === 'string' ? claimed : undefined;
        // The RPC IS the ownership write — lifecycle and the turn marker
        // landed atomically inside its CAS. Writing them AGAIN below would
        // be a second, UNFENCED ownership write: a stop (idle + tombstone)
        // landing between the RPC and that write would be overwritten and
        // the finished turn re-marked running (round 10). The claim is the
        // single writer for these fields.
        delete updates.lifecycle;
        delete updates.cliTurnAt;
      }

      if (Object.keys(updates).length > 0) {
        const updated = await dataComposer.repositories.memory.updateSession(sessionId, updates);
        if (!updated) {
          res.status(500).json({ success: false, error: 'Failed to update session' });
          return;
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
        const stopEpoch = typeof turnEpoch === 'string' ? turnEpoch : undefined;
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
        // Round 10: a claimed prompt RESTAMPS the lease with the CLI turn's
        // epoch — without this, the lease keeps a server predecessor's stamp
        // and that predecessor's delayed boundary release would still match
        // it and drop the live CLI turn's lease.
        try {
          await leaseService.renewBySession(sessionId, session.userId, claimedEpoch);
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
        studioLeaseHeld = await leaseService.touchStudioLeaseForSession(
          studioId,
          sessionId,
          session.userId,
          claimedEpoch
        );
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
