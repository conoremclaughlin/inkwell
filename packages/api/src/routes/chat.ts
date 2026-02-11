/**
 * Chat REST API Routes
 *
 * Provides HTTP endpoints for the web chat interface:
 * - POST /message - Send a message to an agent
 * - GET /history - Get chat history with an agent
 * - GET /agents - List available agents
 */

import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { chatAuthMiddleware, type ChatAuthRequest } from './chat-auth';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import type { SessionService } from '../services/sessions/session-service';
import type { SessionRequest } from '../services/sessions/types';

/**
 * Create a chat router with access to the session service.
 */
export function createChatRouter(getSessionService: () => SessionService | null): Router {
  const router = Router();

  // Apply chat auth middleware to all routes
  router.use(chatAuthMiddleware);

  /**
   * POST /api/chat/message
   * Send a message to an agent and get a response.
   * Synchronous: blocks until Claude Code completes.
   */
  router.post('/message', async (req, res: Response) => {
    try {
      const { userId, userEmail } = req as ChatAuthRequest;
      const { agentId, content } = req.body;

      if (!agentId || !content) {
        res.status(400).json({ error: 'agentId and content are required' });
        return;
      }

      const sessionService = getSessionService();
      if (!sessionService) {
        res.status(503).json({ error: 'Session service not available' });
        return;
      }

      // Build SessionRequest
      const sessionRequest: SessionRequest = {
        userId,
        agentId,
        channel: 'web',
        conversationId: `web:${userId}:${agentId}`,
        sender: {
          id: userId,
          name: userEmail,
          username: userEmail,
        },
        content,
        metadata: {
          triggerType: 'message',
          chatType: 'direct',
        },
      };

      const result = await sessionService.handleMessage(sessionRequest);

      res.json({
        success: result.success,
        response: result.finalTextResponse || null,
        sessionId: result.sessionId,
        error: result.error,
      });
    } catch (error) {
      logger.error('Chat message error:', error);
      res.status(500).json({ error: 'Failed to process message' });
    }
  });

  /**
   * GET /api/chat/history
   * Get chat history with an agent.
   * Query params: agentId (required), limit (optional, default 50)
   */
  router.get('/history', async (req, res: Response) => {
    try {
      const { userId } = req as ChatAuthRequest;
      const agentId = req.query.agentId as string;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

      if (!agentId) {
        res.status(400).json({ error: 'agentId query parameter is required' });
        return;
      }

      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

      // Query activity_stream for web chat messages
      const { data, error } = await supabase
        .from('activity_stream')
        .select('id, direction, content, agent_id, created_at')
        .eq('user_id', userId)
        .eq('agent_id', agentId)
        .eq('platform', 'web')
        .eq('type', 'message')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        logger.error('Failed to fetch chat history:', error);
        res.status(500).json({ error: 'Failed to fetch chat history' });
        return;
      }

      // Reverse to chronological order
      const messages = (data || []).reverse().map((m) => ({
        id: m.id,
        direction: m.direction,
        content: m.content,
        agentId: m.agent_id,
        createdAt: m.created_at,
      }));

      res.json({ messages });
    } catch (error) {
      logger.error('Chat history error:', error);
      res.status(500).json({ error: 'Failed to fetch chat history' });
    }
  });

  /**
   * GET /api/chat/agents
   * List available agents for this user.
   */
  router.get('/agents', async (req, res: Response) => {
    try {
      const { userId } = req as ChatAuthRequest;

      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

      // Query agent_identities for this user
      const { data, error } = await supabase
        .from('agent_identities')
        .select('agent_id, name, role, description')
        .eq('user_id', userId)
        .order('agent_id', { ascending: true });

      if (error) {
        logger.error('Failed to fetch agents:', error);
        res.status(500).json({ error: 'Failed to fetch agents' });
        return;
      }

      const agents = (data || []).map((a) => ({
        agentId: a.agent_id,
        name: a.name,
        role: a.role,
        description: a.description,
      }));

      res.json({ agents });
    } catch (error) {
      logger.error('Chat agents error:', error);
      res.status(500).json({ error: 'Failed to fetch agents' });
    }
  });

  return router;
}
