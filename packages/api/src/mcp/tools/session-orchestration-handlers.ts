/**
 * Session Orchestration Handlers
 *
 * Tools for agent-to-agent collaboration, particularly for resuming
 * sessions from other agents like Myra.
 */

import { createClient } from '@supabase/supabase-js';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import type { DataComposer } from '../../data/composer';
import { z } from 'zod';

// Schema for get_resumable_sessions
export const getResumableSessionsSchema = {
  agentId: z.string().optional().describe('Filter by agent (e.g., "wren", "myra")'),
  lifecycle: z
    .enum(['idle', 'running', 'completed', 'failed'])
    .optional()
    .describe('Filter by lifecycle state'),
  status: z
    .enum(['active', 'paused', 'resumable'])
    .optional()
    .describe('[Deprecated] Filter by status (default: resumable)'),
};

interface ResumableSession {
  sessionId: string;
  agentId: string;
  backendSessionId: string | null;
  lifecycle: string;
  status: string;
  currentPhase: string | null;
  workingDir: string | null;
  context: string | null;
  startedAt: string;
  updatedAt: string | null;
  resumeCommand: string | null;
}

/**
 * Get sessions that can be resumed by another agent
 */
export async function handleGetResumableSessions(
  args: { agentId?: string; lifecycle?: string; status?: string },
  _dataComposer: DataComposer
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

    let query = supabase.from('sessions').select('*').is('ended_at', null); // Only active/resumable sessions

    // Filter by lifecycle if provided, otherwise fall back to status for backward compat
    if (args.lifecycle) {
      query = query.eq('lifecycle', args.lifecycle);
    } else {
      const status = args.status || 'resumable';
      if (status) {
        query = query.eq('status', status);
      }
    }

    // Filter by agent if specified
    if (args.agentId) {
      query = query.eq('agent_id', args.agentId);
    }

    const { data, error } = await query.order('started_at', { ascending: false });

    if (error) {
      logger.error('Failed to get resumable sessions:', error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: false, error: error.message }),
          },
        ],
      };
    }

    const sessions: ResumableSession[] = (data || []).map((s) => ({
      sessionId: s.id,
      agentId: s.agent_id,
      backendSessionId: s.backend_session_id || s.claude_session_id,
      lifecycle: s.lifecycle || 'idle',
      status: s.status || 'active',
      currentPhase: s.current_phase || null,
      workingDir: s.working_dir,
      context: s.context,
      startedAt: s.started_at,
      updatedAt: s.updated_at,
      resumeCommand:
        s.backend_session_id || s.claude_session_id
          ? `claude --resume ${s.backend_session_id || s.claude_session_id}`
          : null,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            count: sessions.length,
            sessions,
            hint:
              sessions.length > 0
                ? 'Use the resumeCommand to continue a session. Pass a message with --message "your context here"'
                : 'No resumable sessions found.',
          }),
        },
      ],
    };
  } catch (error) {
    logger.error('Error in get_resumable_sessions:', error);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          }),
        },
      ],
    };
  }
}
