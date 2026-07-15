/**
 * Sessions Routes
 *
 * Live observation of a session's turn activity over Server-Sent Events.
 *
 *   GET /api/sessions/:id/events   (SSE)
 *
 * The server-spawned ink worker publishes each NDJSON event it emits to the
 * in-process session event bus (see session-event-bus.ts). This endpoint streams
 * those events to any authorized observer — an attached `ink chat` terminal, the
 * web dashboard timeline — so background/heartbeat work can be watched live
 * instead of surfacing only via coarse activity polling.
 *
 * Auth mirrors /mcp: a self-issued PCP access token (Bearer). Authorization is
 * ownership-scoped — you may only observe sessions owned by your user.
 */

import { Router, type Request, type Response } from 'express';
import type { PcpAuthProvider } from '../mcp/auth/pcp-auth-provider.js';
import type { DataComposer } from '../data/composer.js';
import {
  sessionEventBus,
  type SessionStreamEvent,
} from '../services/sessions/session-event-bus.js';
import { logger } from '../utils/logger.js';

/** Comment ping cadence — keeps the connection alive through idle proxies. */
const SSE_HEARTBEAT_MS = 15_000;

export function createSessionsRouter(deps: {
  authProvider: PcpAuthProvider;
  dataComposer: DataComposer;
}): Router {
  const router = Router();

  router.get('/:id/events', async (req: Request, res: Response): Promise<void> => {
    const auth = deps.authProvider.verifyAccessToken(req.headers.authorization);
    if (!auth) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const sessionId = req.params.id;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing session id' });
      return;
    }

    // Ownership scope: only observe sessions owned by the caller's user. Prevents
    // one user (or agent) from tapping another's live event stream.
    try {
      const { data: session, error } = await deps.dataComposer
        .getClient()
        .from('sessions')
        .select('user_id')
        .eq('id', sessionId)
        .single();

      if (error || !session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      if (session.user_id !== auth.userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
    } catch (err) {
      logger.error('sessions/:id/events ownership check failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal error' });
      return;
    }

    // Open the SSE stream. No body parsing, no buffering, no socket timeout.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable proxy buffering (nginx) so events flush immediately.
      'X-Accel-Buffering': 'no',
    });
    req.socket.setTimeout(0);
    res.write(`event: connected\ndata: ${JSON.stringify({ sessionId })}\n\n`);

    const send = (event: SessionStreamEvent): void => {
      // If the client is gone, writes fail — the close handler tears down.
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // Replay the recent tail (so a mid-turn attach isn't blank) then stream live.
    const unsubscribe = sessionEventBus.subscribe(sessionId, send, { replay: true });

    const heartbeat = setInterval(() => {
      res.write(`: ping\n\n`);
    }, SSE_HEARTBEAT_MS);

    logger.debug('SSE session observer connected', { sessionId, userId: auth.userId });

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      logger.debug('SSE session observer disconnected', { sessionId, userId: auth.userId });
    };

    req.on('close', cleanup);
    res.on('error', cleanup);
  });

  return router;
}
