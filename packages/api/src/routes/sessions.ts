/**
 * Sessions Routes
 *
 * Live observation of a session's turn activity over Server-Sent Events.
 *
 *   GET /api/sessions/:id/events                (SSE, legacy live tap)
 *   GET /api/sessions/:id/events?channel=obs    (SSE, canonical observer channel)
 *
 * Two channels share the endpoint (spec:observer-attach):
 *
 * - **legacy** (default): the best-effort live tap — process-local event ids,
 *   turn-scoped replay. Pre-existing consumers keep this contract unchanged.
 * - **obs**: the deterministic server-side PROJECTION of canonical ledger
 *   entries (type + field allowlists, preview truncation — see
 *   projectObserverEntry), keyed by the ledger's monotonic eid. Frames are
 *   never the raw appended objects; the invariant is rendered stream ≡
 *   projection(ledger). SSE frame id = ledger eid. Cursors are EXCLUSIVE:
 *   `?afterEid=N` (or the
 *   `Last-Event-ID: N` header on reconnect) resumes at the first entry with
 *   eid > N; cursors older than the in-memory ring backfill from the durable
 *   ledger automatically. A subscriber that can't keep up is disconnected
 *   (`event: end`, reason `overflow`) and reconverges by reconnecting from its
 *   last processed eid — its view can never silently diverge from the ledger.
 *
 * Auth mirrors /mcp: a self-issued PCP access token (Bearer). The observer
 * identity comes from VERIFIED JWT claims — never from the client-composed
 * x-ink-context assertion. Authorization (spec §4.6, default deny):
 *   - a user token may observe any session it owns;
 *   - an agent token may observe its own sessions (same identity UUID),
 *     except contact-scoped sessions (contact isolation, v1);
 *   - cross-agent observation requires a session_observe_grants row;
 *     contact-scoped sessions are never observable under v1 grants.
 */

import { Router, type Request, type Response } from 'express';
import type { PcpAuthProvider } from '../mcp/auth/pcp-auth-provider.js';
import type { DataComposer } from '../data/composer.js';
import {
  sessionEventBus,
  type SessionStreamEvent,
  type ObserverEntry,
  type ObserverSink,
  type ObserverSinkEndReason,
} from '../services/sessions/session-event-bus.js';
import { logger } from '../utils/logger.js';

/** Comment ping cadence — keeps the connection alive through idle proxies. */
const SSE_HEARTBEAT_MS = 15_000;

/** Per-user cap across all sessions (env-tunable). */
const MAX_OBSERVER_CONNECTIONS_PER_USER = (() => {
  const raw = Number.parseInt(process.env.SESSION_OBSERVE_MAX_PER_USER ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 16;
})();
const observerConnectionsByUser = new Map<string, number>();

export interface ObserveAuthContext {
  userId: string;
  /** Verified identity UUID when the caller is an agent; absent for user tokens. */
  sbId?: string;
}

export interface ObserveSessionRecord {
  userId: string;
  /** Owning identity UUID (sessions.sb_id); null for legacy rows. */
  sbId: string | null;
  contactId: string | null;
}

export type ObserveDecision =
  | { allowed: true }
  | { allowed: false; status: 403; reason: string }
  | { allowed: false; status: 'needs_grant'; ownerSbId: string };

/**
 * The observe permission matrix (spec:observer-attach §4.6). Pure — grant
 * lookups happen outside; 'needs_grant' tells the caller which owner identity
 * to check the grant table against. Default deny.
 */
export function resolveObservePermission(
  auth: ObserveAuthContext,
  session: ObserveSessionRecord
): ObserveDecision {
  // Ownership scope first: nobody observes another user's sessions, ever.
  if (session.userId !== auth.userId) {
    return { allowed: false, status: 403, reason: 'not_your_user' };
  }

  // User token (no verified agent identity): may observe own sessions.
  if (!auth.sbId) {
    return { allowed: true };
  }

  // Agent token. Contact isolation (v1): contact-scoped sessions are never
  // observable by agents — not even by the owning identity — so one
  // per-contact conversation can never leak into another context merely
  // because the agent identity matches.
  if (session.contactId) {
    return { allowed: false, status: 403, reason: 'contact_isolated' };
  }

  // Own session (same identity UUID) — allowed.
  if (session.sbId && session.sbId === auth.sbId) {
    return { allowed: true };
  }

  // Cross-agent: requires an explicit grant row. Legacy sessions without an
  // owning identity cannot be granted — deny.
  if (!session.sbId) {
    return { allowed: false, status: 403, reason: 'session_has_no_owner_identity' };
  }
  return { allowed: false, status: 'needs_grant', ownerSbId: session.sbId };
}

function parseAfterEid(req: Request): number | undefined {
  const fromHeader = req.headers['last-event-id'];
  const raw =
    typeof req.query.afterEid === 'string'
      ? req.query.afterEid
      : typeof fromHeader === 'string'
        ? fromHeader
        : undefined;
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

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

    let sessionRecord: ObserveSessionRecord;
    try {
      const { data: session, error } = await deps.dataComposer
        .getClient()
        .from('sessions')
        .select('user_id, sb_id, contact_id')
        .eq('id', sessionId)
        .single();

      if (error || !session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      sessionRecord = {
        userId: session.user_id,
        sbId: session.sb_id,
        contactId: session.contact_id,
      };
    } catch (err) {
      logger.error('sessions/:id/events ownership check failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal error' });
      return;
    }

    const isObsChannel = req.query.channel === 'obs';

    // ONE permission matrix for BOTH channels (Lumen review, blocker 2 — a
    // legacy channel with weaker auth is just a bypass around the gate). The
    // legacy stream carries live tool activity; it deserves the same door.
    const decision = resolveObservePermission(
      { userId: auth.userId, sbId: auth.sbId },
      sessionRecord
    );
    if (!decision.allowed) {
      if (decision.status === 'needs_grant') {
        // Cross-agent: allowed only with an unexpired grant row (default deny).
        try {
          const { data: grant } = await deps.dataComposer
            .getClient()
            .from('session_observe_grants')
            .select('id, expires_at')
            .eq('user_id', auth.userId)
            .eq('observer_sb_id', auth.sbId!)
            .eq('owner_sb_id', decision.ownerSbId)
            .maybeSingle();
          const valid =
            grant && (!grant.expires_at || new Date(grant.expires_at).getTime() > Date.now());
          if (!valid) {
            res.status(403).json({ error: 'Forbidden' });
            return;
          }
        } catch (err) {
          logger.error('sessions/:id/events grant check failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          res.status(500).json({ error: 'Internal error' });
          return;
        }
      } else {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
    }

    // Per-user connection cap across all sessions (spec §4.4) — unbounded N
    // must not become event-loop backpressure.
    const userConnections = observerConnectionsByUser.get(auth.userId) ?? 0;
    if (userConnections >= MAX_OBSERVER_CONNECTIONS_PER_USER) {
      res.status(429).json({ error: 'Too many observer connections' });
      return;
    }
    observerConnectionsByUser.set(auth.userId, userConnections + 1);

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

    const heartbeat = setInterval(() => {
      res.write(`: ping\n\n`);
    }, SSE_HEARTBEAT_MS);

    let closed = false;
    let teardown: () => void = () => undefined;
    // Aborted on close so an in-progress bus replay CANCELS instead of
    // running to EOF against a vanished client (Lumen re-review, blocker 2).
    const closeController = new AbortController();
    // Pending drain waiters — resolved on real drain OR on close, so a replay
    // awaiting backpressure always makes progress and settles (blocker 4).
    let drainWaiters: Array<() => void> = [];
    const flushDrainWaiters = (): void => {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const w of waiters) w();
    };
    res.on('drain', flushDrainWaiters);
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      closeController.abort();
      clearInterval(heartbeat);
      const count = observerConnectionsByUser.get(auth.userId) ?? 1;
      if (count <= 1) observerConnectionsByUser.delete(auth.userId);
      else observerConnectionsByUser.set(auth.userId, count - 1);
      flushDrainWaiters(); // never strand a replay mid-backpressure
      teardown();
      logger.debug('SSE session observer disconnected', { sessionId, userId: auth.userId });
    };
    // Installed BEFORE any subscribe so a client vanishing during replay is
    // seen immediately, not only after the subscribe promise settles.
    req.on('close', cleanup);
    res.on('error', cleanup);

    if (isObsChannel) {
      // Canonical observer channel: frame id = ledger eid; exclusive cursor;
      // backpressure honored via res.write()/drain; overflow disconnects.
      const sink: ObserverSink = {
        write(entry: ObserverEntry): boolean {
          if (closed) return true; // no-op after close; teardown is in flight
          return res.write(
            `id: ${entry.eid}\nevent: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`
          );
        },
        waitDrain(): Promise<void> {
          if (closed) return Promise.resolve();
          return new Promise((resolve) => drainWaiters.push(resolve));
        },
        end(reason: ObserverSinkEndReason): void {
          try {
            if (!closed) {
              res.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
              res.end();
            }
          } catch {
            // Socket already gone — nothing to report to.
          }
          cleanup();
        },
      };

      try {
        const unsubscribe = await sessionEventBus.subscribeObserver(sessionId, sink, {
          afterEid: parseAfterEid(req),
          follow: req.query.follow !== 'false',
          signal: closeController.signal,
        });
        teardown = unsubscribe;
        if (closed) unsubscribe(); // client left during replay
      } catch (err) {
        // subscribeObserver already ended the sink (replay_failed / limit).
        logger.warn('sessions/:id/events observer subscribe failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        cleanup();
      }
      logger.debug('SSE observer (obs channel) connected', { sessionId, userId: auth.userId });
      return;
    }

    // Legacy live tap (default): unchanged contract for existing consumers.
    const send = (event: SessionStreamEvent): void => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    teardown = sessionEventBus.subscribe(sessionId, send, { replay: true });
    logger.debug('SSE session observer connected', { sessionId, userId: auth.userId });
  });

  return router;
}
