/**
 * Memory MCP Tool Handlers
 *
 * Tools for long-term memory storage and session tracking
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';
import { userIdentifierBaseSchema, resolveUserOrThrow } from '../../services/user-resolver';
import type { MemorySource, Salience } from '../../data/models/memory';

// Enums for validation
const memorySourceSchema = z.enum(['conversation', 'observation', 'user_stated', 'inferred', 'session']);
const salienceSchema = z.enum(['low', 'medium', 'high', 'critical']);

// =====================================================
// MEMORY TOOLS
// =====================================================

export const rememberSchema = userIdentifierBaseSchema.extend({
  content: z.string().describe('The content to remember'),
  source: memorySourceSchema.optional().describe('Source of the memory (default: observation)'),
  salience: salienceSchema.optional().describe('Importance level (default: medium)'),
  topics: z.array(z.string()).optional().describe('Topics for categorization'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
  expiresAt: z.string().datetime().optional().describe('Optional expiration date (ISO 8601)'),
});

export const recallSchema = userIdentifierBaseSchema.extend({
  query: z.string().optional().describe('Search query (text search for now, semantic later)'),
  source: memorySourceSchema.optional().describe('Filter by source'),
  salience: salienceSchema.optional().describe('Filter by salience'),
  topics: z.array(z.string()).optional().describe('Filter by topics (any match)'),
  limit: z.number().min(1).max(100).optional().describe('Max results (default: 20)'),
  includeExpired: z.boolean().optional().describe('Include expired memories'),
});

export const forgetSchema = userIdentifierBaseSchema.extend({
  memoryId: z.string().uuid().describe('ID of the memory to forget'),
});

export const updateMemorySchema = userIdentifierBaseSchema.extend({
  memoryId: z.string().uuid().describe('ID of the memory to update'),
  salience: salienceSchema.optional().describe('New salience level'),
  topics: z.array(z.string()).optional().describe('New topics'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata to merge'),
});

// =====================================================
// SESSION TOOLS
// =====================================================

export const startSessionSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().optional().describe('Identifier for the agent (e.g., "claude-code", "telegram-myra")'),
  metadata: z.record(z.unknown()).optional().describe('Additional session metadata'),
});

export const logSessionSchema = userIdentifierBaseSchema.extend({
  sessionId: z.string().uuid().optional().describe('Session ID (uses active session if not provided)'),
  content: z.string().describe('Log entry content'),
  salience: salienceSchema.optional().describe('Importance level (default: medium)'),
});

export const endSessionSchema = userIdentifierBaseSchema.extend({
  sessionId: z.string().uuid().optional().describe('Session ID (uses active session if not provided)'),
  summary: z.string().optional().describe('End-of-session summary'),
});

export const getSessionSchema = userIdentifierBaseSchema.extend({
  sessionId: z.string().uuid().optional().describe('Session ID (returns active session if not provided)'),
  includeLogs: z.boolean().optional().describe('Include session logs (default: false)'),
});

export const listSessionsSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().optional().describe('Filter by agent'),
  limit: z.number().min(1).max(100).optional().describe('Max results (default: 20)'),
});

// =====================================================
// MEMORY HISTORY SCHEMAS
// =====================================================

export const getMemoryHistorySchema = userIdentifierBaseSchema.extend({
  memoryId: z.string().uuid().describe('ID of the memory to get history for'),
});

export const getUserHistorySchema = userIdentifierBaseSchema.extend({
  limit: z.number().min(1).max(100).optional().describe('Max results (default: 50)'),
  changeType: z.enum(['update', 'delete']).optional().describe('Filter by change type'),
});

export const restoreMemorySchema = userIdentifierBaseSchema.extend({
  historyId: z.string().uuid().describe('ID of the history entry to restore from'),
});

// =====================================================
// BOOTSTRAP SCHEMA
// =====================================================

export const bootstrapSchema = userIdentifierBaseSchema.extend({
  includeRecentMemories: z.boolean().optional().describe('Include recent high-salience memories (default: true)'),
  memoryLimit: z.number().min(1).max(20).optional().describe('Max recent memories to include (default: 5)'),
});

// =====================================================
// COMPACTION SCHEMAS
// =====================================================

export const compactSessionSchema = userIdentifierBaseSchema.extend({
  sessionId: z.string().uuid().optional().describe('Session ID to compact (uses active session if not provided)'),
  groupByTopics: z.boolean().optional().describe('Group logs by inferred topics (default: true)'),
  minSalience: z.enum(['low', 'medium', 'high', 'critical']).optional()
    .describe('Minimum salience to include in compaction (default: medium)'),
  preserveLogs: z.boolean().optional().describe('Keep original logs after compaction (default: false)'),
});

// =====================================================
// HANDLERS
// =====================================================

export async function handleRemember(args: unknown, dataComposer: DataComposer) {
  const params = rememberSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const memory = await dataComposer.repositories.memory.remember({
    userId: user.id,
    content: params.content,
    source: params.source as MemorySource,
    salience: params.salience as Salience,
    topics: params.topics,
    metadata: params.metadata,
    expiresAt: params.expiresAt ? new Date(params.expiresAt) : undefined,
  });

  logger.info(`Memory created for user ${user.id}`, { memoryId: memory.id, source: memory.source });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: 'Memory saved successfully',
            user: { id: user.id, resolvedBy },
            memory: {
              id: memory.id,
              source: memory.source,
              salience: memory.salience,
              topics: memory.topics,
              createdAt: memory.createdAt.toISOString(),
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleRecall(args: unknown, dataComposer: DataComposer) {
  const params = recallSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const memories = await dataComposer.repositories.memory.recall(user.id, params.query, {
    source: params.source as MemorySource,
    salience: params.salience as Salience,
    topics: params.topics,
    limit: params.limit,
    includeExpired: params.includeExpired,
  });

  logger.info(`Recalled ${memories.length} memories for user ${user.id}`);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            count: memories.length,
            memories: memories.map((m) => ({
              id: m.id,
              content: m.content,
              source: m.source,
              salience: m.salience,
              topics: m.topics,
              metadata: m.metadata,
              createdAt: m.createdAt.toISOString(),
              expiresAt: m.expiresAt?.toISOString(),
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleForget(args: unknown, dataComposer: DataComposer) {
  const params = forgetSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  await dataComposer.repositories.memory.forget(params.memoryId, user.id);

  logger.info(`Memory forgotten: ${params.memoryId} for user ${user.id}`);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: 'Memory forgotten successfully',
            user: { id: user.id, resolvedBy },
            memoryId: params.memoryId,
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleUpdateMemory(args: unknown, dataComposer: DataComposer) {
  const params = updateMemorySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const memory = await dataComposer.repositories.memory.updateMemory(params.memoryId, user.id, {
    salience: params.salience as Salience,
    topics: params.topics,
    metadata: params.metadata,
  });

  if (!memory) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: false, error: 'Memory not found' }, null, 2),
        },
      ],
    };
  }

  logger.info(`Memory updated: ${params.memoryId} for user ${user.id}`);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: 'Memory updated successfully',
            user: { id: user.id, resolvedBy },
            memory: {
              id: memory.id,
              salience: memory.salience,
              topics: memory.topics,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

// =====================================================
// SESSION HANDLERS
// =====================================================

export async function handleStartSession(args: unknown, dataComposer: DataComposer) {
  const params = startSessionSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  // Check if there's already an active session for this agent
  const existingSession = await dataComposer.repositories.memory.getActiveSession(
    user.id,
    params.agentId
  );

  if (existingSession) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              message: 'Active session already exists',
              user: { id: user.id, resolvedBy },
              session: {
                id: existingSession.id,
                agentId: existingSession.agentId,
                startedAt: existingSession.startedAt.toISOString(),
                isExisting: true,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }

  const session = await dataComposer.repositories.memory.startSession({
    userId: user.id,
    agentId: params.agentId,
    metadata: params.metadata,
  });

  logger.info(`Session started for user ${user.id}`, { sessionId: session.id, agentId: session.agentId });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: 'Session started successfully',
            user: { id: user.id, resolvedBy },
            session: {
              id: session.id,
              agentId: session.agentId,
              startedAt: session.startedAt.toISOString(),
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleLogSession(args: unknown, dataComposer: DataComposer) {
  const params = logSessionSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  // Get session ID (use provided or find active)
  let sessionId = params.sessionId;
  if (!sessionId) {
    const activeSession = await dataComposer.repositories.memory.getActiveSession(user.id);
    if (!activeSession) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { success: false, error: 'No active session found. Start a session first.' },
              null,
              2
            ),
          },
        ],
      };
    }
    sessionId = activeSession.id;
  }

  const log = await dataComposer.repositories.memory.addSessionLog({
    sessionId,
    content: params.content,
    salience: params.salience as Salience,
  });

  logger.info(`Session log added`, { sessionId, logId: log.id });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: 'Session log added',
            user: { id: user.id, resolvedBy },
            log: {
              id: log.id,
              sessionId: log.sessionId,
              salience: log.salience,
              createdAt: log.createdAt.toISOString(),
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleEndSession(args: unknown, dataComposer: DataComposer) {
  const params = endSessionSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  // Get session ID (use provided or find active)
  let sessionId = params.sessionId;
  if (!sessionId) {
    const activeSession = await dataComposer.repositories.memory.getActiveSession(user.id);
    if (!activeSession) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'No active session found.' }, null, 2),
          },
        ],
      };
    }
    sessionId = activeSession.id;
  }

  const session = await dataComposer.repositories.memory.endSession(sessionId, params.summary);

  if (!session) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: false, error: 'Session not found.' }, null, 2),
        },
      ],
    };
  }

  logger.info(`Session ended`, { sessionId: session.id, hasSummary: !!params.summary });

  // If summary provided, also save it as a memory
  if (params.summary) {
    await dataComposer.repositories.memory.remember({
      userId: user.id,
      content: params.summary,
      source: 'session',
      salience: 'high',
      topics: ['session-summary'],
      metadata: { sessionId: session.id, agentId: session.agentId },
    });
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: 'Session ended successfully',
            user: { id: user.id, resolvedBy },
            session: {
              id: session.id,
              agentId: session.agentId,
              startedAt: session.startedAt.toISOString(),
              endedAt: session.endedAt?.toISOString(),
              summary: session.summary,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleGetSession(args: unknown, dataComposer: DataComposer) {
  const params = getSessionSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  let session;
  if (params.sessionId) {
    session = await dataComposer.repositories.memory.getSession(params.sessionId);
  } else {
    session = await dataComposer.repositories.memory.getActiveSession(user.id);
  }

  if (!session) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { success: true, user: { id: user.id, resolvedBy }, session: null },
            null,
            2
          ),
        },
      ],
    };
  }

  let logs;
  if (params.includeLogs) {
    logs = await dataComposer.repositories.memory.getSessionLogs(session.id);
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            session: {
              id: session.id,
              agentId: session.agentId,
              startedAt: session.startedAt.toISOString(),
              endedAt: session.endedAt?.toISOString(),
              summary: session.summary,
              metadata: session.metadata,
              logs: logs?.map((l) => ({
                id: l.id,
                content: l.content,
                salience: l.salience,
                createdAt: l.createdAt.toISOString(),
              })),
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleListSessions(args: unknown, dataComposer: DataComposer) {
  const params = listSessionsSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const sessions = await dataComposer.repositories.memory.listSessions(user.id, {
    agentId: params.agentId,
    limit: params.limit,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            count: sessions.length,
            sessions: sessions.map((s) => ({
              id: s.id,
              agentId: s.agentId,
              startedAt: s.startedAt.toISOString(),
              endedAt: s.endedAt?.toISOString(),
              summary: s.summary,
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}

// =====================================================
// MEMORY HISTORY HANDLERS
// =====================================================

export async function handleGetMemoryHistory(args: unknown, dataComposer: DataComposer) {
  const params = getMemoryHistorySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const history = await dataComposer.repositories.memory.getMemoryHistory(params.memoryId, user.id);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            memoryId: params.memoryId,
            count: history.length,
            history: history.map((h) => ({
              id: h.id,
              version: h.version,
              content: h.content,
              salience: h.salience,
              topics: h.topics,
              changeType: h.changeType,
              createdAt: h.createdAt.toISOString(),
              archivedAt: h.archivedAt.toISOString(),
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleGetUserHistory(args: unknown, dataComposer: DataComposer) {
  const params = getUserHistorySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const history = await dataComposer.repositories.memory.getUserMemoryHistory(user.id, {
    limit: params.limit,
    changeType: params.changeType,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            count: history.length,
            history: history.map((h) => ({
              id: h.id,
              memoryId: h.memoryId,
              version: h.version,
              content: h.content.substring(0, 200) + (h.content.length > 200 ? '...' : ''),
              salience: h.salience,
              changeType: h.changeType,
              archivedAt: h.archivedAt.toISOString(),
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleRestoreMemory(args: unknown, dataComposer: DataComposer) {
  const params = restoreMemorySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const memory = await dataComposer.repositories.memory.restoreMemory(params.historyId, user.id);

  if (!memory) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: false, error: 'History entry not found' }, null, 2),
        },
      ],
    };
  }

  logger.info(`Memory restored from history`, { memoryId: memory.id, historyId: params.historyId });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: 'Memory restored successfully',
            user: { id: user.id, resolvedBy },
            memory: {
              id: memory.id,
              content: memory.content,
              version: memory.version,
              salience: memory.salience,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

// =====================================================
// BOOTSTRAP HANDLER
// =====================================================

/**
 * Bootstrap loads identity core + active context in one call.
 * This is the recommended way to start a new session.
 *
 * Returns:
 * - Identity Core: user, assistant, relationship context
 * - Active Context: current projects, focus, recent high-salience memories
 * - Active Session: current session info if any
 */
export async function handleBootstrap(args: unknown, dataComposer: DataComposer) {
  const params = bootstrapSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const includeMemories = params.includeRecentMemories !== false;
  const memoryLimit = params.memoryLimit || 5;

  // Fetch all context in parallel
  const [contexts, projects, focus, activeSession, recentMemories] = await Promise.all([
    // Identity Core: all context summaries
    dataComposer.repositories.context.findAllByUser(user.id),
    // Active projects
    dataComposer.repositories.projects.findAllByUser(user.id, 'active'),
    // Current focus
    dataComposer.repositories.sessionFocus.findLatestByUser(user.id),
    // Active session
    dataComposer.repositories.memory.getActiveSession(user.id),
    // Recent high-salience memories
    includeMemories
      ? dataComposer.repositories.memory.recall(user.id, undefined, {
          salience: 'high',
          limit: memoryLimit,
        })
      : Promise.resolve([]),
  ]);

  // Organize contexts by type
  const identityCore = {
    user: contexts.find((c) => c.context_type === 'user' && !c.context_key),
    assistant: contexts.find((c) => c.context_type === 'assistant' && !c.context_key),
    relationship: contexts.find((c) => c.context_type === 'relationship' && !c.context_key),
  };

  const projectContexts = contexts.filter((c) => c.context_type === 'project');

  logger.info(`Bootstrap loaded for user ${user.id}`, {
    contextCount: contexts.length,
    projectCount: projects.length,
    memoryCount: recentMemories.length,
    hasActiveSession: !!activeSession,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },

            // Tier 1: Identity Core
            identityCore: {
              user: identityCore.user
                ? { summary: identityCore.user.summary, metadata: identityCore.user.metadata }
                : null,
              assistant: identityCore.assistant
                ? { summary: identityCore.assistant.summary, metadata: identityCore.assistant.metadata }
                : null,
              relationship: identityCore.relationship
                ? { summary: identityCore.relationship.summary, metadata: identityCore.relationship.metadata }
                : null,
            },

            // Tier 2: Active Context
            activeContext: {
              projects: projects.map((p) => ({
                id: p.id,
                name: p.name,
                description: p.description,
                status: p.status,
                techStack: p.tech_stack,
                goals: p.goals,
              })),
              projectContexts: projectContexts.map((c) => ({
                key: c.context_key,
                summary: c.summary,
              })),
              focus: focus
                ? {
                    projectId: focus.project_id,
                    summary: focus.focus_summary,
                    updatedAt: focus.updated_at,
                  }
                : null,
            },

            // Active session
            session: activeSession
              ? {
                  id: activeSession.id,
                  agentId: activeSession.agentId,
                  startedAt: activeSession.startedAt.toISOString(),
                }
              : null,

            // Recent high-salience memories
            recentMemories: recentMemories.map((m) => ({
              id: m.id,
              content: m.content,
              source: m.source,
              topics: m.topics,
              createdAt: m.createdAt.toISOString(),
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}

// =====================================================
// COMPACTION HANDLER
// =====================================================

/**
 * Compact session logs into memories.
 *
 * This implements the compaction strategy from the PCP spec:
 * 1. Group logs by salience
 * 2. Create summarized memories from high-value logs
 * 3. Optionally clear the original logs
 *
 * The result is fewer, higher-quality memories that capture
 * the key decisions and events from the session.
 */
export async function handleCompactSession(args: unknown, dataComposer: DataComposer) {
  const params = compactSessionSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const minSalience = params.minSalience || 'medium';
  const preserveLogs = params.preserveLogs ?? false;

  // Get session ID
  let sessionId = params.sessionId;
  let session;

  if (sessionId) {
    session = await dataComposer.repositories.memory.getSession(sessionId);
  } else {
    session = await dataComposer.repositories.memory.getActiveSession(user.id);
    sessionId = session?.id;
  }

  if (!session || !sessionId) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: false, error: 'No session found to compact' }, null, 2),
        },
      ],
    };
  }

  // Get logs at or above minimum salience
  const logs = await dataComposer.repositories.memory.getSessionLogsBySalience(sessionId, minSalience);

  if (logs.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: 'No logs to compact at specified salience level',
            user: { id: user.id, resolvedBy },
            sessionId,
            logsProcessed: 0,
            memoriesCreated: 0,
          }, null, 2),
        },
      ],
    };
  }

  // Group logs by salience for processing
  const bySalience: Record<string, typeof logs> = {
    critical: [],
    high: [],
    medium: [],
    low: [],
  };

  for (const log of logs) {
    bySalience[log.salience].push(log);
  }

  const memoriesCreated: Array<{ id: string; salience: string; content: string }> = [];

  // Track log IDs per memory for soft-delete linking
  let logsCompacted = 0;

  // Process critical logs - each becomes its own memory
  for (const log of bySalience.critical) {
    const memory = await dataComposer.repositories.memory.remember({
      userId: user.id,
      content: log.content,
      source: 'session',
      salience: 'critical',
      topics: ['session-compaction'],
      metadata: { sessionId, originalLogId: log.id, compactedAt: new Date().toISOString() },
    });
    memoriesCreated.push({ id: memory.id, salience: 'critical', content: log.content.substring(0, 100) });

    // Soft-delete: mark log as compacted with link to memory
    if (!preserveLogs) {
      await dataComposer.repositories.memory.markSpecificLogsCompacted([log.id], memory.id);
      logsCompacted++;
    }
  }

  // Process high salience logs - each becomes its own memory
  for (const log of bySalience.high) {
    const memory = await dataComposer.repositories.memory.remember({
      userId: user.id,
      content: log.content,
      source: 'session',
      salience: 'high',
      topics: ['session-compaction'],
      metadata: { sessionId, originalLogId: log.id, compactedAt: new Date().toISOString() },
    });
    memoriesCreated.push({ id: memory.id, salience: 'high', content: log.content.substring(0, 100) });

    // Soft-delete: mark log as compacted with link to memory
    if (!preserveLogs) {
      await dataComposer.repositories.memory.markSpecificLogsCompacted([log.id], memory.id);
      logsCompacted++;
    }
  }

  // Process medium logs - combine into a single summary memory if multiple
  if (bySalience.medium.length > 0) {
    const combinedContent = bySalience.medium.length === 1
      ? bySalience.medium[0].content
      : `Session notes (${bySalience.medium.length} entries):\n` +
        bySalience.medium.map((l, i) => `${i + 1}. ${l.content}`).join('\n');

    const memory = await dataComposer.repositories.memory.remember({
      userId: user.id,
      content: combinedContent,
      source: 'session',
      salience: 'medium',
      topics: ['session-compaction', 'session-notes'],
      metadata: {
        sessionId,
        logCount: bySalience.medium.length,
        compactedAt: new Date().toISOString(),
      },
    });
    memoriesCreated.push({ id: memory.id, salience: 'medium', content: combinedContent.substring(0, 100) });

    // Soft-delete: mark all medium logs as compacted with link to combined memory
    if (!preserveLogs) {
      const mediumLogIds = bySalience.medium.map(l => l.id);
      logsCompacted += await dataComposer.repositories.memory.markSpecificLogsCompacted(mediumLogIds, memory.id);
    }
  }

  // Mark any remaining low-salience logs as compacted (discarded, no memory link)
  if (!preserveLogs && bySalience.low.length > 0) {
    const lowLogIds = bySalience.low.map(l => l.id);
    logsCompacted += await dataComposer.repositories.memory.markSpecificLogsCompacted(lowLogIds);
  }

  logger.info(`Session compacted`, {
    sessionId,
    logsProcessed: logs.length,
    memoriesCreated: memoriesCreated.length,
    logsCompacted,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: 'Session compacted successfully',
            user: { id: user.id, resolvedBy },
            sessionId,
            logsProcessed: logs.length,
            memoriesCreated: memoriesCreated.length,
            logsCompacted: preserveLogs ? 0 : logsCompacted,
            memories: memoriesCreated,
          },
          null,
          2
        ),
      },
    ],
  };
}
