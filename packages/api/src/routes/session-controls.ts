/** Mutation is deliberately narrower than observation: owning human credentials only. */
import type { Router, Request, Response } from 'express';
import { parseSessionControl } from '@inklabs/shared/runtime';
import type { InkAuthProvider } from '../mcp/auth/ink-auth-provider';
import type { DataComposer } from '../data/composer';
import { getActiveRun, submitRunControl } from '../services/sessions/active-runs';

export function addSessionControlRoute(
  router: Router,
  deps: {
    authProvider: InkAuthProvider;
    dataComposer: DataComposer;
  }
) {
  router.post('/:id/controls', async (req: Request, res: Response): Promise<void> => {
    try {
      const verdict = await deps.authProvider.verifyAccessToken(req.headers.authorization);
      if (!verdict.ok) {
        res.status(verdict.status).json({ error: 'Authentication unavailable or refused' });
        return;
      }
      const auth = verdict.token;
      // Read grants and same-agent tokens do NOT confer mutation rights. Never
      // use an unsigned context header to classify this caller as human.
      if (auth.sbId || auth.sbSlug || auth.sessionId || auth.contactId) {
        res.status(403).json({ error: 'Owning user credentials required' });
        return;
      }
      const { turnEpoch, control, ...extra } = req.body ?? {};
      const request = parseSessionControl(control);
      if (
        Object.keys(extra).length ||
        !request ||
        typeof turnEpoch !== 'string' ||
        !turnEpoch ||
        turnEpoch.length > 128 ||
        typeof req.params.id !== 'string'
      ) {
        res.status(400).json({ error: 'Expected turnEpoch and a supported control' });
        return;
      }
      const { data: session, error } = await deps.dataComposer
        .getClient()
        .from('sessions')
        .select('user_id, cli_attached, turn_epoch')
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
      const run = getActiveRun(req.params.id);
      if (
        session.cli_attached !== false ||
        session.turn_epoch !== turnEpoch ||
        run?.userId !== auth.userId
      ) {
        res.status(409).json({ error: 'No matching detached hosted owner' });
        return;
      }
      // No await between the final local owner check and enqueue. Application
      // rechecks the bound generation, signal and admission again at the boundary.
      const receipt = submitRunControl(req.params.id, turnEpoch, request);
      res
        .status(receipt.status === 'pending' ? 202 : receipt.status === 'applied' ? 200 : 409)
        .json(receipt);
    } catch {
      res.status(503).json({ error: 'Session control unavailable' });
    }
  });
}
