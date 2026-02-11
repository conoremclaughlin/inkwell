/**
 * Kindle REST API Routes
 *
 * Endpoints for the kindle (SB birth) flow:
 * - POST /create-token - Create a shareable invite token
 * - POST /redeem - Redeem a token (starts onboarding)
 * - GET /token/:token - Get token info (public, for landing page)
 * - GET /:kindleId - Get kindle status + onboarding state
 * - POST /:kindleId/complete - Finalize name + identity
 */

import { Router, Request, Response } from 'express';
import { chatAuthMiddleware, type ChatAuthRequest } from './chat-auth';
import { getKindleService } from '../services/kindle/kindle-service';
import { logger } from '../utils/logger';

export function createKindleRouter(): Router {
  const router = Router();

  /**
   * GET /api/kindle/token/:token
   * Public endpoint — get token info for the landing page.
   * No auth required.
   */
  router.get('/token/:token', async (req: Request, res: Response) => {
    try {
      const { token } = req.params;
      const kindleService = getKindleService();
      const tokenData = await kindleService.getToken(token);

      if (!tokenData) {
        res.status(404).json({ error: 'Token not found' });
        return;
      }

      if (tokenData.status !== 'active') {
        res.status(410).json({ error: 'Token has already been used or expired', status: tokenData.status });
        return;
      }

      if (tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date()) {
        res.status(410).json({ error: 'Token has expired', status: 'expired' });
        return;
      }

      // Return public info only (no internal IDs)
      res.json({
        token: tokenData.token,
        valueSeed: tokenData.valueSeed,
        expiresAt: tokenData.expiresAt,
        createdAt: tokenData.createdAt,
      });
    } catch (error) {
      logger.error('Get kindle token error:', error);
      res.status(500).json({ error: 'Failed to get token' });
    }
  });

  // All routes below require auth
  router.use(chatAuthMiddleware);

  /**
   * POST /api/kindle/create-token
   * Create a shareable invite token.
   */
  router.post('/create-token', async (req: Request, res: Response) => {
    try {
      const { userId } = req as ChatAuthRequest;
      const { agentId, expiresInHours } = req.body;

      const kindleService = getKindleService();
      const token = await kindleService.createKindleToken(
        userId,
        agentId,
        expiresInHours || 168
      );

      const webPortalUrl = process.env.WEB_PORTAL_URL || 'http://localhost:3002';
      const inviteUrl = `${webPortalUrl}/kindle/${token.token}`;

      res.json({
        token: token.token,
        inviteUrl,
        expiresAt: token.expiresAt,
        valueSeed: token.valueSeed,
      });
    } catch (error) {
      logger.error('Create kindle token error:', error);
      res.status(500).json({ error: 'Failed to create kindle token' });
    }
  });

  /**
   * POST /api/kindle/redeem
   * Redeem a kindle token — starts the onboarding flow.
   */
  router.post('/redeem', async (req: Request, res: Response) => {
    try {
      const { userId } = req as ChatAuthRequest;
      const { token } = req.body;

      if (!token) {
        res.status(400).json({ error: 'token is required' });
        return;
      }

      const kindleService = getKindleService();
      const lineage = await kindleService.redeemKindleToken(token, userId);

      res.json({
        kindleId: lineage.id,
        agentId: lineage.childAgentId,
        onboardingStatus: lineage.onboardingStatus,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to redeem token';
      logger.error('Redeem kindle token error:', error);
      res.status(400).json({ error: message });
    }
  });

  /**
   * GET /api/kindle/:kindleId
   * Get kindle status + onboarding state.
   */
  router.get('/:kindleId', async (req: Request, res: Response) => {
    try {
      const { kindleId } = req.params;
      const kindleService = getKindleService();
      const lineage = await kindleService.getKindle(kindleId);

      if (!lineage) {
        res.status(404).json({ error: 'Kindle not found' });
        return;
      }

      res.json({ kindle: lineage });
    } catch (error) {
      logger.error('Get kindle error:', error);
      res.status(500).json({ error: 'Failed to get kindle' });
    }
  });

  /**
   * POST /api/kindle/:kindleId/complete
   * Finalize name + identity after onboarding.
   */
  router.post('/:kindleId/complete', async (req: Request, res: Response) => {
    try {
      const { kindleId } = req.params;
      const { chosenName, soulMd } = req.body;

      if (!chosenName) {
        res.status(400).json({ error: 'chosenName is required' });
        return;
      }

      const kindleService = getKindleService();
      const lineage = await kindleService.completeOnboarding(kindleId, chosenName, soulMd);

      res.json({
        kindle: lineage,
        agentId: lineage.childAgentId,
      });
    } catch (error) {
      logger.error('Complete kindle error:', error);
      res.status(500).json({ error: 'Failed to complete onboarding' });
    }
  });

  /**
   * GET /api/kindle/active/me
   * Find any active kindle onboarding for the current user.
   */
  router.get('/active/me', async (req: Request, res: Response) => {
    try {
      const { userId } = req as ChatAuthRequest;
      const kindleService = getKindleService();
      const lineage = await kindleService.findActiveKindleForUser(userId);

      res.json({ kindle: lineage });
    } catch (error) {
      logger.error('Find active kindle error:', error);
      res.status(500).json({ error: 'Failed to find active kindle' });
    }
  });

  return router;
}
