/** Explicit owner text for the current hosted turn. No inbox wake or queue fallback. */
import type { Router, Request, Response } from 'express';
import { parseSessionSteering } from '@inklabs/shared/runtime';
import type { InkAuthProvider } from '../mcp/auth/ink-auth-provider';
import type { DataComposer } from '../data/composer';
import { getActiveRun, submitRunSteering } from '../services/sessions/active-runs';
import { hasOwnTurnGate } from '../services/sessions/trigger-delivery';

export function addSessionSteeringRoute(
  router: Router,
  deps: { authProvider: InkAuthProvider; dataComposer: DataComposer }
) {
  router.post('/:id/steer', async (req: Request, res: Response): Promise<void> => {
    try {
      const verdict = await deps.authProvider.verifyAccessToken(req.headers.authorization);
      if (!verdict.ok) {
        res.status(verdict.status).json({ error: 'Authentication unavailable or refused' });
        return;
      }
      const auth = verdict.token;
      // Neither observer grants nor unsigned context headers confer mutation authority.
      if (auth.sbId || auth.sbSlug || auth.sessionId || auth.contactId) {
        res.status(403).json({ error: 'Owning user credentials required' });
        return;
      }
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ error: 'Expected turnEpoch, messageId and text' });
        return;
      }
      const { turnEpoch, ...input } = body;
      const request = parseSessionSteering(input);
      if (
        !request ||
        typeof turnEpoch !== 'string' ||
        !turnEpoch ||
        turnEpoch.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(turnEpoch) ||
        typeof req.params.id !== 'string' ||
        !req.params.id
      ) {
        res.status(400).json({ error: 'Expected turnEpoch, messageId and text' });
        return;
      }
      const client = deps.dataComposer.getClient();
      const { data: session, error } = await client
        .from('sessions')
        .select('user_id, sb_id, contact_id, cli_attached, turn_epoch')
        .eq('id', req.params.id)
        .single();
      if (error || !session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      if (session.user_id !== auth.userId) {
        res.status(403).json({ error: 'Not your session' });
        return;
      }
      // This first slice does not re-run contact or Inkling input admission.
      // Refuse those targets, and legacy rows whose identity is not established.
      if (session.contact_id !== null || !session.sb_id) {
        res.status(409).json({ error: 'Target does not support direct steering' });
        return;
      }
      const { data: identity, error: identityError } = await client
        .from('agent_identities')
        .select('id, user_id, agent_id, metadata')
        .eq('id', session.sb_id)
        .maybeSingle();
      if (identityError) {
        res.status(503).json({ error: 'Target identity unavailable' });
        return;
      }
      if (
        !identity ||
        identity.id !== session.sb_id ||
        identity.user_id !== auth.userId ||
        !identity.metadata ||
        typeof identity.metadata !== 'object' ||
        Array.isArray(identity.metadata) ||
        hasOwnTurnGate(identity.metadata)
      ) {
        res.status(409).json({ error: 'Target does not support direct steering' });
        return;
      }
      const run = getActiveRun(req.params.id);
      if (
        session.cli_attached !== false ||
        session.turn_epoch !== turnEpoch ||
        run?.userId !== auth.userId ||
        run?.sbSlug !== identity.agent_id
      ) {
        res.status(409).json({ error: 'No matching detached hosted owner' });
        return;
      }
      // The mailbox rechecks its exact generation after its asynchronous durable
      // acknowledgment. A lost owner is unknown/refused, never another queued turn.
      const receipt = await submitRunSteering(req.params.id, turnEpoch, request);
      res
        .status(receipt.status === 'pending' ? 202 : receipt.status === 'inserted' ? 200 : 409)
        .json({ ...receipt, turnEpoch });
    } catch {
      res.status(503).json({ error: 'Session steering unavailable' });
    }
  });
}
