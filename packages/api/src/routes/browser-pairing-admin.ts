/** Mounted behind the dashboard's existing authentication/workspace middleware. */
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { DataComposer } from '../data/composer';
import {
  browserChatRecipients,
  BrowserRecipientRefusedError,
} from '../services/browser-chat-recipient';
import { BrowserCompanionGrantService } from '../services/browser-companion-grant.service';

interface PairingRequest extends Request {
  inkUserId: string;
  inkWorkspaceId: string;
}
export const browserPairingInput = z
  .object({
    installationId: z.string().trim().min(1),
    installationCommitment: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[0-9a-f]{64}$/),
    recipientId: z.string().uuid().optional(),
    fullToolsApproved: z.literal(true).optional(),
  })
  .strict()
  .refine((input) => !input.recipientId || input.fullToolsApproved === true);

export function createBrowserPairingAdminRouter(getComposer: () => Promise<DataComposer>): Router {
  const router = Router();
  router.get('/recipients', async (req, res) => {
    try {
      const auth = req as PairingRequest;
      const composer = await getComposer();
      const recipients = await browserChatRecipients(composer.getClient(), {
        userId: auth.inkUserId,
        workspaceId: auth.inkWorkspaceId,
      });
      res.json({
        recipients: recipients.map(({ id, displayName }) => ({ id, name: displayName })),
      });
    } catch {
      res.status(503).json({ error: 'browser_recipients_unavailable' });
    }
  });
  router.post('/pairing-code', async (req, res) => {
    const parsed = browserPairingInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_pairing_consent' });
      return;
    }
    try {
      const auth = req as PairingRequest;
      const composer = await getComposer();
      const grants = new BrowserCompanionGrantService(composer.getClient());
      const { fullToolsApproved: _consent, ...input } = parsed.data;
      const created = await grants.createPairingCode({
        userId: auth.inkUserId,
        workspaceId: auth.inkWorkspaceId,
        ...input,
      });
      res.json({
        ...created,
        pairingCode: created.pairingCode.match(/.{1,4}/g)?.join('-'),
        installationId: input.installationId,
        recipientId: input.recipientId ?? null,
      });
    } catch (error) {
      if (error instanceof BrowserRecipientRefusedError) {
        res.status(403).json({ error: error.message });
      } else {
        res.status(503).json({ error: 'pairing_code_create_unavailable' });
      }
    }
  });
  return router;
}
