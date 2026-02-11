/**
 * Chat Auth Middleware
 *
 * Lighter authentication than adminAuthMiddleware:
 * - Validates Supabase JWT via supabase.auth.getUser()
 * - Looks up PCP user by email
 * - Attaches req.userId and req.userEmail
 * - Does NOT check trusted_users table (any authenticated user can chat)
 */

import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface ChatAuthRequest extends Request {
  userId: string;
  userEmail: string;
}

export async function chatAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing authorization header' });
      return;
    }

    const token = authHeader.substring(7);

    // Verify the JWT with Supabase
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    // Look up the PCP user by email
    const { data: pcpUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', user.email)
      .single();

    if (!pcpUser) {
      res.status(403).json({ error: 'User not found in PCP system' });
      return;
    }

    // Attach user info to request
    const chatReq = req as ChatAuthRequest;
    chatReq.userId = pcpUser.id;
    chatReq.userEmail = user.email || '';

    next();
  } catch (error) {
    logger.error('Chat auth error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}
