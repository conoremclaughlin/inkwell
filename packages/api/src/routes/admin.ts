/**
 * Admin REST API Routes
 *
 * Provides HTTP endpoints for the PCP Admin Dashboard to manage:
 * - Trusted users
 * - Authorized groups
 * - Challenge codes
 * - WhatsApp connection status and QR codes
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { getAuthorizationService } from '../services/authorization';
import { logger } from '../utils/logger';
import { env } from '../config/env';

// WhatsApp listener reference (set via setWhatsAppListener)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let whatsAppListener: any = null;

/**
 * Set the WhatsApp listener for admin endpoints
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setWhatsAppListener(listener: any): void {
  whatsAppListener = listener;
}

/**
 * Admin auth middleware
 * Validates Supabase JWT and ensures user is a trusted admin/owner
 */
async function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing authorization header' });
      return;
    }

    const token = authHeader.substring(7);

    // Verify the JWT with Supabase
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    // Check if user email is a trusted user with admin/owner privileges
    // For now, we check if the user's email matches the owner
    // In production, you'd want to check the trusted_users table
    const authService = getAuthorizationService();

    // Get all trusted users and check if this email has admin+ access
    const trustedUsers = await authService.listTrustedUsers();

    // Look up the PCP user by email
    const { data: pcpUser } = await supabase
      .from('users')
      .select('id, telegram_id, whatsapp_id')
      .eq('email', user.email)
      .single();

    if (!pcpUser) {
      res.status(403).json({ error: 'User not found in PCP system' });
      return;
    }

    // Check if any of the user's platform IDs are trusted with admin/owner level
    const isTrusted = trustedUsers.some((tu) => {
      if (tu.trustLevel === 'member') return false;
      if (tu.userId === pcpUser.id) return true;
      if (tu.platform === 'telegram' && pcpUser.telegram_id?.toString() === tu.platformUserId) return true;
      if (tu.platform === 'whatsapp' && pcpUser.whatsapp_id === tu.platformUserId) return true;
      return false;
    });

    if (!isTrusted) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Attach user to request
    (req as Request & { user: typeof user }).user = user;
    next();
  } catch (error) {
    logger.error('Admin auth error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

const router = Router();

// Apply auth middleware to all routes
router.use(adminAuthMiddleware);

// =============================================================================
// Trusted Users
// =============================================================================

/**
 * GET /api/admin/trusted-users
 * List all trusted users
 */
router.get('/trusted-users', async (_req: Request, res: Response) => {
  try {
    const authService = getAuthorizationService();
    const users = await authService.listTrustedUsers();

    res.json({
      users: users.map((u) => ({
        id: u.id,
        platform: u.platform,
        platformUserId: u.platformUserId,
        trustLevel: u.trustLevel,
        addedAt: u.addedAt.toISOString(),
      })),
    });
  } catch (error) {
    logger.error('Failed to list trusted users:', error);
    res.status(500).json({ error: 'Failed to list trusted users' });
  }
});

/**
 * POST /api/admin/trusted-users
 * Add a new trusted user
 */
router.post('/trusted-users', async (req: Request, res: Response) => {
  try {
    const { platform, platformUserId, trustLevel } = req.body;

    if (!platform || !platformUserId) {
      res.status(400).json({ error: 'platform and platformUserId are required' });
      return;
    }

    const authService = getAuthorizationService();

    // For admin dashboard, we use a system admin identity
    // In production, you'd track who added the user
    const result = await authService.addTrustedUser(
      platform,
      platformUserId,
      trustLevel || 'member',
      platformUserId // Self-add for now - in production use the admin's ID
    );

    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to add trusted user:', error);
    res.status(500).json({ error: 'Failed to add trusted user' });
  }
});

/**
 * DELETE /api/admin/trusted-users/:id
 * Remove a trusted user
 */
router.delete('/trusted-users/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

    // Don't allow deleting owners
    const { data: user } = await supabase
      .from('trusted_users')
      .select('trust_level')
      .eq('id', id)
      .single();

    if (user?.trust_level === 'owner') {
      res.status(403).json({ error: 'Cannot remove owner' });
      return;
    }

    const { error } = await supabase
      .from('trusted_users')
      .delete()
      .eq('id', id);

    if (error) {
      res.status(500).json({ error: 'Failed to delete user' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete trusted user:', error);
    res.status(500).json({ error: 'Failed to delete trusted user' });
  }
});

// =============================================================================
// Authorized Groups
// =============================================================================

/**
 * GET /api/admin/groups
 * List all authorized groups
 */
router.get('/groups', async (_req: Request, res: Response) => {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

    const { data, error } = await supabase
      .from('authorized_groups')
      .select('*')
      .order('authorized_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Failed to list groups' });
      return;
    }

    res.json({
      groups: (data || []).map((g) => ({
        id: g.id,
        platform: g.platform,
        platformGroupId: g.platform_group_id,
        groupName: g.group_name,
        authorizationMethod: g.authorization_method,
        authorizedAt: g.authorized_at,
        status: g.status,
      })),
    });
  } catch (error) {
    logger.error('Failed to list groups:', error);
    res.status(500).json({ error: 'Failed to list groups' });
  }
});

/**
 * POST /api/admin/groups/:id/revoke
 * Revoke a group authorization
 */
router.post('/groups/:id/revoke', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

    const { error } = await supabase
      .from('authorized_groups')
      .update({
        status: 'revoked',
        revoked_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      res.status(500).json({ error: 'Failed to revoke group' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to revoke group:', error);
    res.status(500).json({ error: 'Failed to revoke group' });
  }
});

// =============================================================================
// Challenge Codes
// =============================================================================

/**
 * GET /api/admin/challenge-codes
 * List all challenge codes
 */
router.get('/challenge-codes', async (_req: Request, res: Response) => {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

    const { data, error } = await supabase
      .from('group_challenge_codes')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      res.status(500).json({ error: 'Failed to list codes' });
      return;
    }

    res.json({
      codes: (data || []).map((c) => ({
        id: c.id,
        code: c.code,
        createdAt: c.created_at,
        expiresAt: c.expires_at,
        usedAt: c.used_at,
        usedForPlatform: c.used_for_platform,
        usedForGroupId: c.used_for_group_id,
      })),
    });
  } catch (error) {
    logger.error('Failed to list challenge codes:', error);
    res.status(500).json({ error: 'Failed to list codes' });
  }
});

/**
 * POST /api/admin/challenge-codes
 * Generate a new challenge code
 */
router.post('/challenge-codes', async (_req: Request, res: Response) => {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

    // Check rate limit
    const { count } = await supabase
      .from('group_challenge_codes')
      .select('*', { count: 'exact', head: true })
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString());

    if (count && count >= 5) {
      res.status(429).json({ error: 'Maximum 5 active codes allowed' });
      return;
    }

    // Generate code
    const code = Array.from({ length: 6 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]
    ).join('');

    const { data, error } = await supabase
      .from('group_challenge_codes')
      .insert({ code })
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to generate code' });
      return;
    }

    res.json({
      code: data.code,
      expiresAt: data.expires_at,
    });
  } catch (error) {
    logger.error('Failed to generate challenge code:', error);
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

// =============================================================================
// WhatsApp
// =============================================================================

/**
 * GET /api/admin/whatsapp/status
 * Get WhatsApp connection status
 */
router.get('/whatsapp/status', async (_req: Request, res: Response) => {
  try {
    if (!whatsAppListener) {
      res.json({ connected: false, error: 'WhatsApp not configured' });
      return;
    }

    res.json({
      connected: whatsAppListener.connected,
      running: whatsAppListener.running,
    });
  } catch (error) {
    logger.error('Failed to get WhatsApp status:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * GET /api/admin/whatsapp/qr
 * SSE endpoint for QR code streaming
 */
router.get('/whatsapp/qr', (req: Request, res: Response) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send initial status
  if (whatsAppListener?.connected) {
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({ type: 'disconnected' })}\n\n`);
  }

  if (!whatsAppListener) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'WhatsApp not configured' })}\n\n`);
    return;
  }

  // Listen for QR codes
  const qrHandler = (qr: string) => {
    // Convert QR string to base64 data URL for display
    res.write(`data: ${JSON.stringify({ type: 'qr', qr })}\n\n`);
  };

  const connectedHandler = (info: { jid: string; e164: string | null }) => {
    res.write(`data: ${JSON.stringify({ type: 'connected', phoneNumber: info.e164 || info.jid })}\n\n`);
  };

  const disconnectedHandler = () => {
    res.write(`data: ${JSON.stringify({ type: 'disconnected' })}\n\n`);
  };

  whatsAppListener.on('qr', qrHandler);
  whatsAppListener.on('connected', connectedHandler);
  whatsAppListener.on('disconnected', disconnectedHandler);
  whatsAppListener.on('loggedOut', disconnectedHandler);

  // Clean up on close
  req.on('close', () => {
    whatsAppListener.off('qr', qrHandler);
    whatsAppListener.off('connected', connectedHandler);
    whatsAppListener.off('disconnected', disconnectedHandler);
    whatsAppListener.off('loggedOut', disconnectedHandler);
  });
});

/**
 * POST /api/admin/whatsapp/logout
 * Logout from WhatsApp
 */
router.post('/whatsapp/logout', async (_req: Request, res: Response) => {
  try {
    if (!whatsAppListener) {
      res.status(400).json({ error: 'WhatsApp not configured' });
      return;
    }

    await whatsAppListener.stop();
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to logout WhatsApp:', error);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

export default router;
