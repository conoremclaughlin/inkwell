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
import { logger } from '../utils/logger';

const VALID_LIFECYCLES = ['running', 'idle', 'compacting', 'completed', 'failed'] as const;
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

      const { sessionId, lifecycle, agentId, workingDir, cliAttached, cliPollAt, alias } =
        req.body as {
          sessionId?: string;
          lifecycle?: string;
          agentId?: string;
          workingDir?: string;
          cliAttached?: boolean;
          cliPollAt?: string;
          alias?: string;
        };

      if (!sessionId) {
        res.status(400).json({ success: false, error: 'sessionId is required' });
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
        alias?: string | null;
      } = {};
      if (lifecycle) updates.lifecycle = lifecycle;
      if (workingDir) updates.workingDir = workingDir;
      if (cliAttached !== undefined) updates.cliAttached = cliAttached;
      if (cliPollAt) updates.cliPollAt = cliPollAt;
      if (alias !== undefined) updates.alias = alias || null;

      const updated = await dataComposer.repositories.memory.updateSession(sessionId, updates);

      if (!updated) {
        res.status(500).json({ success: false, error: 'Failed to update session' });
        return;
      }

      // Lease heartbeat and CLI run boundary. Prompt/compact events renew the
      // lease heartbeat (the primary refresh path, well inside the 30-minute
      // staleness threshold). Stop events (idle/completed) are the moment the
      // CLI turn has actually finished executing in the worktree: ONE ordered
      // chain runs the boundary release first (terminal session, or a
      // pendingRelease deferred by close_thread/close_studio mid-turn) and
      // renews only if nothing was released — release and renewal must never
      // race each other's heartbeat CAS. Fire-and-forget: never delays the
      // hook response.
      const isStopEvent = lifecycle === 'idle' || lifecycle === 'completed';
      if (isStopEvent) {
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
        void leaseService.renewBySession(sessionId, session.userId).catch((err: unknown) => {
          logger.debug('[HookLifecycle] Lease renewal failed (non-fatal)', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      logger.debug('[HookLifecycle] Updated', { sessionId, lifecycle, agentId });
      res.json({ success: true, sessionId, lifecycle });
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
