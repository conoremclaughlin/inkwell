/**
 * Session Orchestration Handlers
 *
 * Tools for agent-to-agent collaboration, particularly for resuming
 * Claude Code sessions from other agents like Myra.
 */

import { createClient } from '@supabase/supabase-js';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import type { DataComposer } from '../../data/composer';
import { z } from 'zod';

// Schema for get_resumable_sessions
export const getResumableSessionsSchema = {
  agentId: z.string().optional().describe('Filter by agent (e.g., "wren", "myra")'),
  status: z
    .enum(['active', 'paused', 'resumable'])
    .optional()
    .describe('Filter by status (default: resumable)'),
};

// Schema for update_session_status
export const updateSessionStatusSchema = {
  sessionId: z.string().uuid().describe('PCP session ID to update'),
  claudeSessionId: z.string().optional().describe('Claude Code session ID for --resume'),
  status: z.enum(['active', 'paused', 'resumable', 'completed']).optional().describe('New status'),
  workingDir: z.string().optional().describe('Working directory'),
  context: z.string().optional().describe('Brief context of current work'),
};

interface ResumableSession {
  sessionId: string;
  agentId: string;
  claudeSessionId: string | null;
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
  args: { agentId?: string; status?: string },
  _dataComposer: DataComposer
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

    let query = supabase.from('sessions').select('*').is('ended_at', null); // Only active/resumable sessions

    // Filter by status (default to 'resumable')
    const status = args.status || 'resumable';
    if (status) {
      query = query.eq('status', status);
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
      claudeSessionId: s.claude_session_id,
      status: s.status || 'active',
      currentPhase: s.current_phase || null,
      workingDir: s.working_dir,
      context: s.context,
      startedAt: s.started_at,
      updatedAt: s.updated_at,
      resumeCommand: s.claude_session_id ? `claude --resume ${s.claude_session_id}` : null,
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

/**
 * Update a session's status and Claude session ID
 * Called by agents to mark their session as resumable
 */
export async function handleUpdateSessionStatus(
  args: {
    sessionId: string;
    claudeSessionId?: string;
    status?: string;
    workingDir?: string;
    context?: string;
  },
  _dataComposer: DataComposer
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (args.claudeSessionId !== undefined) {
      updates.claude_session_id = args.claudeSessionId;
    }
    if (args.status !== undefined) {
      updates.status = args.status;
    }
    if (args.workingDir !== undefined) {
      updates.working_dir = args.workingDir;
    }
    if (args.context !== undefined) {
      updates.context = args.context;
    }

    const { data, error } = await supabase
      .from('sessions')
      .update(updates)
      .eq('id', args.sessionId)
      .select()
      .single();

    if (error) {
      logger.error('Failed to update session status:', error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: false, error: error.message }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            session: {
              id: data.id,
              agentId: data.agent_id,
              claudeSessionId: data.claude_session_id,
              status: data.status,
              workingDir: data.working_dir,
              context: data.context,
            },
          }),
        },
      ],
    };
  } catch (error) {
    logger.error('Error in update_session_status:', error);
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
