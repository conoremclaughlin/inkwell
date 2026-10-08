/**
 * Chat Auth Middleware
 *
 * Lighter authentication than adminAuthMiddleware:
 * - Validates Supabase JWT via supabase.auth.getUser()
 * - Resolves the Inkwell account bound to that sign-in (never by email
 *   alone: ink://specs/account-deletion §7); it does not create one
 * - Holds the account's gate for the request (§3), refusing an account that
 *   is being deleted
 * - Attaches req.userId and req.userEmail
 * - Does NOT check trusted_users table (any authenticated user can chat)
 */

import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { Database } from '../data/supabase/types';
import { resolveAccountForPrincipal } from '../services/account-deletion/principal';
import { leaseAccountForRequest } from '../services/account-deletion/request-lease';

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
    const supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const resolved = await resolveAccountForPrincipal(supabase, {
      authUid: user.id,
      email: user.email ?? null,
      create: false,
    });
    if (!resolved.ok) {
      res.status(resolved.status).json({
        error:
          resolved.status === 500 ? 'Authentication error' : 'User not found in Inkwell system',
      });
      return;
    }
    if (!leaseAccountForRequest(res, resolved.userId)) return;

    // Attach user info to request
    const chatReq = req as ChatAuthRequest;
    chatReq.userId = resolved.userId;
    chatReq.userEmail = user.email || '';

    next();
  } catch (error) {
    logger.error('Chat auth error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}
