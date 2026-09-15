/**
 * Alert webhook routes.
 *
 * The ingest endpoint is deliberately reachable by something dumber than an
 * agent. A checker that needs an OAuth flow, a token refresh, or an LLM is a
 * checker that cannot report the outage that breaks those things — which is
 * exactly the failure this exists for. So ingest accepts a static shared
 * secret alongside the normal bearer token, and the whole path is one POST
 * with no session, no MCP, and no model in the loop.
 *
 *   POST /api/alerts          raise or resolve an alert
 *   POST /api/alerts/checkin  liveness ping ("I ran, nothing to report")
 *   GET  /api/alerts          recent events            (bearer only)
 *   GET  /api/alerts/sources  monitor liveness + staleness verdicts (bearer only)
 */

import { Router, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import type { DataComposer } from '../data/composer';
import { PcpAuthProvider } from '../mcp/auth/pcp-auth-provider';
import { AlertDispatchService } from '../services/alerts/alert-dispatch.service';
import { parseAlertPayload, secretsMatch, sourceStaleness } from '../services/alerts/alert-policy';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Resolve the acting user from either credential.
 *
 * The shared secret is bound to one configured user rather than trusting a
 * userId in the body — a token that can address any user is a token that
 * turns one leaked secret into an alerting channel for the whole system.
 */
function resolveAlertUser(
  req: Request,
  authProvider: PcpAuthProvider
): { userId: string; via: 'token' | 'bearer' } | null {
  const provided = req.header('x-ink-alert-token');
  if (provided && secretsMatch(provided, env.ALERT_INGEST_TOKEN)) {
    if (!env.ALERT_INGEST_USER_ID) {
      logger.error('ALERT_INGEST_TOKEN is set but ALERT_INGEST_USER_ID is not — refusing ingest');
      return null;
    }
    return { userId: env.ALERT_INGEST_USER_ID, via: 'token' };
  }

  const userData = authProvider.verifyAccessToken(req.headers.authorization);
  if (userData) return { userId: userData.userId, via: 'bearer' };

  return null;
}

export function createAlertsRouter(dataComposer: DataComposer): Router {
  const router = Router();
  const authProvider = new PcpAuthProvider();
  const dispatch = new AlertDispatchService(dataComposer);

  router.post('/', async (req: Request, res: Response) => {
    const actor = resolveAlertUser(req, authProvider);
    if (!actor) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    let alert;
    try {
      alert = parseAlertPayload(req.body);
    } catch (error) {
      res.status(400).json({
        success: false,
        error: 'Invalid alert payload',
        issues: error instanceof ZodError ? error.issues : undefined,
      });
      return;
    }

    try {
      const result = await dispatch.ingest(actor.userId, alert);
      // 202: the alert is recorded. Whether a human heard it is reported per
      // sink in `deliveries` rather than folded into this status code —
      // "accepted" and "delivered" are different claims and a checker that
      // conflates them will report success through a dead Telegram token.
      res.status(202).json({ success: true, ...result });
    } catch (error) {
      logger.error('Alert ingest failed', { error, source: alert.source });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to record alert',
      });
    }
  });

  router.post('/checkin', async (req: Request, res: Response) => {
    const actor = resolveAlertUser(req, authProvider);
    if (!actor) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    const { source, expectedIntervalSeconds, detail } = req.body ?? {};
    if (typeof source !== 'string' || !source.trim()) {
      res.status(400).json({ success: false, error: 'source is required' });
      return;
    }
    if (
      expectedIntervalSeconds !== undefined &&
      (!Number.isInteger(expectedIntervalSeconds) || expectedIntervalSeconds <= 0)
    ) {
      res
        .status(400)
        .json({ success: false, error: 'expectedIntervalSeconds must be a positive integer' });
      return;
    }

    try {
      await dispatch.checkIn(actor.userId, {
        source: source.trim(),
        expectedIntervalSeconds,
        detail: typeof detail === 'string' ? detail : undefined,
      });
      res.json({ success: true, source: source.trim() });
    } catch (error) {
      logger.error('Alert check-in failed', { error, source });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to record check-in',
      });
    }
  });

  router.get('/', async (req: Request, res: Response) => {
    const userData = authProvider.verifyAccessToken(req.headers.authorization);
    if (!userData) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const openOnly = req.query.open === 'true';

    let query = dataComposer
      .getClient()
      .from('alert_events')
      .select(
        'id, source, severity, title, detail, dedupe_key, metrics, first_seen_at, last_seen_at, last_notified_at, occurrence_count, resolved_at, delivery'
      )
      .eq('user_id', userData.userId)
      .order('last_seen_at', { ascending: false })
      .limit(limit);
    if (openOnly) query = query.is('resolved_at', null);

    const { data, error } = await query;
    if (error) {
      res.status(500).json({ success: false, error: error.message });
      return;
    }
    res.json({ success: true, events: data ?? [] });
  });

  router.get('/sources', async (req: Request, res: Response) => {
    const userData = authProvider.verifyAccessToken(req.headers.authorization);
    if (!userData) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    const { data, error } = await dataComposer
      .getClient()
      .from('alert_sources')
      .select(
        'id, source, description, expected_interval_seconds, staleness_grace_factor, last_seen_at, last_status, last_detail, stale_alerted_at'
      )
      .eq('user_id', userData.userId)
      .order('source');

    if (error) {
      res.status(500).json({ success: false, error: error.message });
      return;
    }

    const now = new Date();
    // The staleness verdict is computed and returned rather than left for the
    // reader to infer from a timestamp. A state with no age is not a signal.
    const sources = (data ?? []).map((row) => ({
      ...row,
      staleness: sourceStaleness(
        {
          source: row.source,
          lastSeenAt: row.last_seen_at,
          expectedIntervalSeconds: row.expected_interval_seconds,
          stalenessGraceFactor: Number(row.staleness_grace_factor ?? 2),
          staleAlertedAt: row.stale_alerted_at,
        },
        now
      ),
    }));

    res.json({ success: true, sources });
  });

  return router;
}
