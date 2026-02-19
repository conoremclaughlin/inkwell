/**
 * Memory MCP Tool Handlers
 *
 * Tools for long-term memory storage and session tracking
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';
import { userIdentifierBaseSchema, resolveUserOrThrow } from '../../services/user-resolver';
import { setSessionContext, pinSessionAgent, getRequestContext } from '../../utils/request-context';
import { getEffectiveAgentId } from '../../auth/enforce-identity';
import type { MemorySource, Salience } from '../../data/models/memory';
import { getCloudSkillsService } from '../../skills/cloud-service';

// Helper to safely read a file, returning null if it doesn't exist
async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// Enums for validation
const memorySourceSchema = z.enum([
  'conversation',
  'observation',
  'user_stated',
  'inferred',
  'session',
]);
const salienceSchema = z.enum(['low', 'medium', 'high', 'critical']);

function resolveStudioId(params: { studioId?: string; workspaceId?: string }): string | undefined {
  return params.studioId ?? params.workspaceId;
}

/** Coerce a comma-separated string into a string array so callers can pass either format. */
const topicsSchema = z
  .preprocess(
    (val) =>
      typeof val === 'string'
        ? val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : val,
    z.array(z.string())
  )
  .optional();

// =====================================================
// KNOWLEDGE SUMMARY BUILDER
// =====================================================

/** Default character budget for the bootstrap knowledge summary. Override with BOOTSTRAP_MEMORY_BUDGET env var. */
const DEFAULT_MEMORY_BUDGET = 8000;

function getMemoryBudget(): number {
  const envBudget = process.env.BOOTSTRAP_MEMORY_BUDGET;
  if (envBudget) {
    const parsed = parseInt(envBudget, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MEMORY_BUDGET;
}

interface TopicGroup {
  topicKey: string;
  memories: Array<{
    id: string;
    displayText: string;
    salience: string;
    createdAt: string;
  }>;
  memoryCount: number;
  lastActivity: string;
  topicSummary?: string; // From metadata.topicSummary on the most recent memory
}

/**
 * Build a budget-constrained knowledge summary from memories grouped by topic.
 * Returns both the formatted summary text and a topic index for overflow.
 */
export function buildKnowledgeSummary(memories: import('../../data/models/memory').Memory[]): {
  knowledgeSummary: string;
  topicIndex: Array<{
    topicKey: string;
    memoryCount: number;
    lastActivity: string;
    topicSummary?: string;
  }>;
  memoriesIncluded: number;
} {
  const budget = getMemoryBudget();

  // Group memories by topicKey (or first topic, or 'uncategorized')
  const groups = new Map<string, TopicGroup>();

  for (const m of memories) {
    const key = m.topicKey || (m.topics.length > 0 ? m.topics[0] : 'uncategorized');
    // Critical memories get full content (core identity, worth the budget).
    // High memories get truncated. Skip summary when it's identical to content.
    const rawText = m.summary && m.summary !== m.content ? m.summary : m.content;
    const displayText =
      m.salience === 'critical' ? truncateContent(rawText, 1000) : truncateContent(rawText, 200);
    const createdAt = m.createdAt.toISOString().slice(0, 10); // YYYY-MM-DD

    if (!groups.has(key)) {
      groups.set(key, {
        topicKey: key,
        memories: [],
        memoryCount: 0,
        lastActivity: createdAt,
        topicSummary: (m.metadata?.topicSummary as string) || undefined,
      });
    }

    const group = groups.get(key)!;
    group.memories.push({
      id: m.id,
      displayText,
      salience: m.salience,
      createdAt,
    });
    group.memoryCount++;
    if (createdAt > group.lastActivity) group.lastActivity = createdAt;
    // Use topicSummary from the most recent memory that has one
    if (!group.topicSummary && m.metadata?.topicSummary) {
      group.topicSummary = m.metadata.topicSummary as string;
    }
  }

  // Sort groups: most recent activity first
  const sortedGroups = Array.from(groups.values()).sort((a, b) =>
    b.lastActivity.localeCompare(a.lastActivity)
  );

  // Build the summary within budget
  let summary = '';
  let charsUsed = 0;
  let memoriesIncluded = 0;
  const includedTopics = new Set<string>();
  const overflowTopics: typeof sortedGroups = [];

  for (const group of sortedGroups) {
    // Format this group
    const header = group.topicSummary
      ? `### ${group.topicKey} — ${truncateContent(group.topicSummary, 120)}\n`
      : `### ${group.topicKey}\n`;

    let groupText = header;
    for (const mem of group.memories) {
      groupText += `- ${mem.displayText} (${mem.salience}, ${mem.createdAt})\n`;
    }
    groupText += '\n';

    if (charsUsed + groupText.length <= budget) {
      summary += groupText;
      charsUsed += groupText.length;
      memoriesIncluded += group.memories.length;
      includedTopics.add(group.topicKey);
    } else if (charsUsed + header.length + 50 <= budget) {
      // Try to fit at least the header + first memory
      const firstMem = group.memories[0];
      const partialText =
        header + `- ${firstMem.displayText} (${firstMem.salience}, ${firstMem.createdAt})\n`;
      const suffix =
        group.memories.length > 1
          ? `  ... and ${group.memories.length - 1} more memories\n\n`
          : '\n';
      const totalPartial = partialText + suffix;
      if (charsUsed + totalPartial.length <= budget) {
        summary += totalPartial;
        charsUsed += totalPartial.length;
        memoriesIncluded += 1;
        includedTopics.add(group.topicKey);
      } else {
        overflowTopics.push(group);
      }
    } else {
      overflowTopics.push(group);
    }
  }

  // Build topic index from ALL topics (including overflow)
  const topicIndex = sortedGroups.map((g) => ({
    topicKey: g.topicKey,
    memoryCount: g.memoryCount,
    lastActivity: g.lastActivity,
    topicSummary: g.topicSummary,
  }));

  return { knowledgeSummary: summary.trim(), topicIndex, memoriesIncluded };
}

function truncateContent(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen - 3) + '...';
}

// =====================================================
// MEMORY TOOLS
// =====================================================

export const rememberSchema = userIdentifierBaseSchema.extend({
  content: z.string().describe('The content to remember'),
  summary: z
    .string()
    .optional()
    .describe(
      'One-liner summary of this memory. Used in bootstrap knowledge summary instead of full content. Provide when content is long/detailed.'
    ),
  topicKey: z
    .string()
    .optional()
    .describe(
      'Primary structured topic key following type:identifier convention (e.g., "project:pcp/memory", "decision:jwt-auth", "convention:git"). Auto-added to topics array.'
    ),
  topicSummary: z
    .string()
    .optional()
    .describe(
      'One-liner description of the topic itself (not this memory). Used to build the topic index at bootstrap. Only needed when creating a new topic or updating its description.'
    ),
  source: memorySourceSchema.optional().describe('Source of the memory (default: observation)'),
  salience: salienceSchema.optional().describe('Importance level (default: medium)'),
  topics: topicsSchema.describe('Topics for categorization'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
  expiresAt: z.string().datetime().optional().describe('Optional expiration date (ISO 8601)'),
  agentId: z
    .string()
    .optional()
    .describe('Which AI being created this memory (e.g., "wren", "benson"). Null = shared memory.'),
  studioId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Studio ID — preferred session scope for parallel worktree scenarios. Stored in metadata, not as a first-class field.'
    ),
  workspaceId: z
    .string()
    .uuid()
    .optional()
    .describe('[Deprecated] Workspace ID alias for studioId.'),
});

export const recallSchema = userIdentifierBaseSchema.extend({
  query: z.string().optional().describe('Search query (text search for now, semantic later)'),
  source: memorySourceSchema.optional().describe('Filter by source'),
  salience: salienceSchema.optional().describe('Filter by salience'),
  topics: topicsSchema.describe('Filter by topics (any match)'),
  limit: z.number().min(1).max(100).optional().describe('Max results (default: 20)'),
  includeExpired: z.boolean().optional().describe('Include expired memories'),
  agentId: z
    .string()
    .optional()
    .describe('Filter by agent (e.g., "wren"). Omit to include all memories.'),
  includeShared: z
    .boolean()
    .optional()
    .describe('Include shared memories (agentId=null) when filtering by agentId (default: true)'),
});

export const forgetSchema = userIdentifierBaseSchema.extend({
  memoryId: z.string().uuid().describe('ID of the memory to forget'),
});

export const updateMemorySchema = userIdentifierBaseSchema.extend({
  memoryId: z.string().uuid().describe('ID of the memory to update'),
  salience: salienceSchema.optional().describe('New salience level'),
  topics: topicsSchema.describe('New topics'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata to merge'),
});

// =====================================================
// SESSION TOOLS
// =====================================================

export const startSessionSchema = userIdentifierBaseSchema.extend({
  agentId: z
    .string()
    .optional()
    .describe('Identifier for the agent (e.g., "claude-code", "telegram-myra")'),
  studioId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Studio ID to scope this session to. Allows multiple active sessions per agent (one per studio).'
    ),
  workspaceId: z
    .string()
    .uuid()
    .optional()
    .describe('[Deprecated] Workspace ID alias for studioId.'),
  threadKey: z
    .string()
    .optional()
    .describe(
      'Thread key for session routing (e.g., "pr:32"). If an active session with this threadKey exists for the same agent, it is returned instead of creating a new one.'
    ),
  backend: z
    .string()
    .optional()
    .describe('Backend runtime (e.g., "claude-code", "codex", "gemini")'),
  model: z.string().optional().describe('Model identifier (e.g., "opus-4-6", "sonnet", "o3")'),
  metadata: z.record(z.unknown()).optional().describe('Additional session metadata'),
});

export const logSessionSchema = userIdentifierBaseSchema.extend({
  sessionId: z
    .string()
    .uuid()
    .optional()
    .describe('Session ID (uses active session if not provided)'),
  agentId: z
    .string()
    .optional()
    .describe('Agent identifier for session resolution (e.g., "wren", "benson")'),
  studioId: z
    .string()
    .uuid()
    .optional()
    .describe('Studio ID for session resolution when sessionId not provided'),
  workspaceId: z
    .string()
    .uuid()
    .optional()
    .describe('[Deprecated] Workspace ID alias for studioId.'),
  content: z.string().describe('Log entry content'),
  salience: salienceSchema.optional().describe('Importance level (default: medium)'),
});

export const endSessionSchema = userIdentifierBaseSchema.extend({
  sessionId: z
    .string()
    .uuid()
    .optional()
    .describe('Session ID (uses active session if not provided)'),
  agentId: z
    .string()
    .optional()
    .describe('Agent identifier for session resolution (e.g., "wren", "benson")'),
  studioId: z
    .string()
    .uuid()
    .optional()
    .describe('Studio ID for session resolution when sessionId not provided'),
  workspaceId: z
    .string()
    .uuid()
    .optional()
    .describe('[Deprecated] Workspace ID alias for studioId.'),
  summary: z.string().optional().describe('End-of-session summary'),
});

export const getSessionSchema = userIdentifierBaseSchema.extend({
  sessionId: z
    .string()
    .uuid()
    .optional()
    .describe('Session ID (returns active session if not provided)'),
  agentId: z
    .string()
    .optional()
    .describe('Agent identifier for session resolution (e.g., "wren", "benson")'),
  studioId: z
    .string()
    .uuid()
    .optional()
    .describe('Studio ID for session resolution when sessionId not provided'),
  workspaceId: z
    .string()
    .uuid()
    .optional()
    .describe('[Deprecated] Workspace ID alias for studioId.'),
  includeLogs: z.boolean().optional().describe('Include session logs (default: false)'),
});

export const listSessionsSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().optional().describe('Filter by agent'),
  studioId: z.string().uuid().optional().describe('Filter by studio'),
  workspaceId: z
    .string()
    .uuid()
    .optional()
    .describe('[Deprecated] Workspace ID alias for studioId.'),
  limit: z.number().min(1).max(100).optional().describe('Max results (default: 20)'),
});

// =====================================================
// SESSION PHASE SCHEMA
// =====================================================

export const updateSessionPhaseSchema = userIdentifierBaseSchema.extend({
  sessionId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Session ID (uses active session if not provided). Most reliable way to target a specific session.'
    ),
  studioId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Studio ID for session resolution. When sessionId is not provided, finds the active session in this studio. Useful for parallel worktree scenarios.'
    ),
  workspaceId: z
    .string()
    .uuid()
    .optional()
    .describe('[Deprecated] Workspace ID alias for studioId.'),
  phase: z
    .string()
    .optional()
    .describe(
      'Work phase. Core phases: investigating, implementing, reviewing, paused, complete. Use blocked:<reason> or waiting:<reason> for transitions that auto-create memories.'
    ),
  note: z
    .string()
    .optional()
    .describe(
      "Optional note explaining the phase (e.g., what you're blocked on). Included in auto-created memory for blocked/waiting phases."
    ),
  agentId: z.string().optional().describe('Agent identity for memory attribution'),
  createTask: z
    .boolean()
    .optional()
    .describe('Create a PCP task for blocked/waiting phases (default: false)'),
  // Session metadata fields (absorbed from update_session_status)
  backendSessionId: z
    .string()
    .optional()
    .describe('Backend session ID for resumption (e.g., Claude Code session ID, Codex session ID)'),
  status: z
    .enum(['active', 'paused', 'resumable', 'completed'])
    .optional()
    .describe('Session status'),
  context: z.string().optional().describe('Brief context of current work state'),
  workingDir: z.string().optional().describe('Working directory'),
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
  includeRecentMemories: z
    .boolean()
    .optional()
    .describe('Include recent high-salience memories (default: true)'),
  memoryLimit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Max high-salience memories to fetch for knowledge summary (default: 50). Critical memories always included regardless.'
    ),
  agentId: z
    .string()
    .optional()
    .describe(
      'Agent identity (e.g., "wren", "benson", "myra"). Filters memories and loads identity files.'
    ),
  identityBasePath: z
    .string()
    .optional()
    .describe('Base path for identity files (default: ~/.pcp)'),
});

// =====================================================
// COMPACTION SCHEMAS
// =====================================================

export const compactSessionSchema = userIdentifierBaseSchema.extend({
  sessionId: z
    .string()
    .uuid()
    .optional()
    .describe('Session ID to compact (uses active session if not provided)'),
  agentId: z
    .string()
    .optional()
    .describe('Agent identifier for session resolution (e.g., "wren", "benson")'),
  studioId: z
    .string()
    .uuid()
    .optional()
    .describe('Studio ID for session resolution when sessionId not provided'),
  workspaceId: z
    .string()
    .uuid()
    .optional()
    .describe('[Deprecated] Workspace ID alias for studioId.'),
  groupByTopics: z.boolean().optional().describe('Group logs by inferred topics (default: true)'),
  minSalience: z
    .enum(['low', 'medium', 'high', 'critical'])
    .optional()
    .describe('Minimum salience to include in compaction (default: medium)'),
  preserveLogs: z
    .boolean()
    .optional()
    .describe('Keep original logs after compaction (default: false)'),
});

// =====================================================
// HANDLERS
// =====================================================

export async function handleRemember(args: unknown, dataComposer: DataComposer) {
  const params = rememberSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);
  const studioId = resolveStudioId(params);
  const agentId = getEffectiveAgentId(params.agentId);

  // If there's an active session, attach its ID to the memory metadata for traceability.
  // Never require a session — memories are too important to lose.
  let sessionId: string | undefined;
  try {
    const activeSession = await dataComposer.repositories.memory.getActiveSession(
      user.id,
      agentId,
      studioId
    );
    sessionId = activeSession?.id;
  } catch {
    // Session lookup failed — save the memory anyway
  }

  const metadata = {
    ...params.metadata,
    ...(sessionId ? { sessionId } : {}),
    ...(studioId ? { studioId, workspaceId: studioId } : {}),
    ...(params.topicSummary ? { topicSummary: params.topicSummary } : {}),
  };

  const memory = await dataComposer.repositories.memory.remember({
    userId: user.id,
    content: params.content,
    summary: params.summary,
    topicKey: params.topicKey,
    source: params.source as MemorySource,
    salience: params.salience as Salience,
    topics: params.topics,
    metadata,
    expiresAt: params.expiresAt ? new Date(params.expiresAt) : undefined,
    agentId,
  });

  logger.info(`Memory created for user ${user.id}`, {
    memoryId: memory.id,
    source: memory.source,
    agentId: agentId || 'none',
    sessionId: sessionId || 'none',
  });

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
              summary: memory.summary || null,
              topicKey: memory.topicKey || null,
              source: memory.source,
              salience: memory.salience,
              topics: memory.topics,
              agentId: memory.agentId,
              sessionId: sessionId || null,
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
    agentId: params.agentId,
    includeShared: params.includeShared,
  });

  logger.info(`Recalled ${memories.length} memories for user ${user.id}`, {
    agentId: params.agentId,
  });

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
              summary: m.summary || null,
              topicKey: m.topicKey || null,
              source: m.source,
              salience: m.salience,
              topics: m.topics,
              agentId: m.agentId,
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
  const studioId = resolveStudioId(params);
  const agentId = getEffectiveAgentId(params.agentId);

  // Session matching priority:
  // 1. threadKey match — find active session with same agent+threadKey
  // 2. studioId match — find active session scoped by agent+studio (existing behavior)
  let existingSession = null;

  if (params.threadKey && agentId) {
    existingSession = await dataComposer.repositories.memory.getActiveSessionByThreadKey(
      user.id,
      agentId,
      params.threadKey,
      studioId
    );
  }

  if (!existingSession) {
    existingSession = await dataComposer.repositories.memory.getActiveSession(
      user.id,
      agentId,
      studioId
    );
  }

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
                studioId: existingSession.studioId,
                workspaceId: existingSession.workspaceId,
                threadKey: existingSession.threadKey || null,
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
    agentId,
    studioId,
    workspaceId: params.workspaceId,
    threadKey: params.threadKey,
    backend: params.backend,
    model: params.model,
    metadata: params.metadata,
  });

  logger.info(`Session started for user ${user.id}`, {
    sessionId: session.id,
    agentId: session.agentId,
    studioId: session.studioId,
    workspaceId: session.workspaceId,
    threadKey: session.threadKey,
  });

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
              studioId: session.studioId,
              workspaceId: session.workspaceId,
              threadKey: session.threadKey || null,
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
  const studioId = resolveStudioId(params);
  const agentId = getEffectiveAgentId(params.agentId);

  // Get session ID (use provided or find active, scoped by agent+studio)
  let sessionId = params.sessionId;
  if (!sessionId) {
    const activeSession = await dataComposer.repositories.memory.getActiveSession(
      user.id,
      agentId,
      studioId
    );
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
            deprecation:
              'log_session is deprecated. Use update_session_phase for work status, and remember for important decisions/events. Session logs will be removed in a future version.',
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
  const studioId = resolveStudioId(params);
  const agentId = getEffectiveAgentId(params.agentId);

  // Get session ID (use provided or find active, scoped by agent+studio)
  let sessionId = params.sessionId;
  if (!sessionId) {
    const activeSession = await dataComposer.repositories.memory.getActiveSession(
      user.id,
      agentId,
      studioId
    );
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
              studioId: session.studioId,
              workspaceId: session.workspaceId,
              currentPhase: session.currentPhase || null,
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
  const studioId = resolveStudioId(params);

  let session;
  if (params.sessionId) {
    session = await dataComposer.repositories.memory.getSession(params.sessionId);
  } else {
    session = await dataComposer.repositories.memory.getActiveSession(
      user.id,
      params.agentId,
      studioId
    );
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
              studioId: session.studioId,
              workspaceId: session.workspaceId,
              currentPhase: session.currentPhase || null,
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
  const studioId = resolveStudioId(params);

  const sessions = await dataComposer.repositories.memory.listSessions(user.id, {
    agentId: params.agentId,
    studioId,
    workspaceId: params.workspaceId,
    limit: params.limit,
  });

  const studioIds = Array.from(
    new Set(sessions.map((s) => s.studioId).filter((id): id is string => !!id))
  );

  const studios = await dataComposer.repositories.studios.listByIds(user.id, studioIds);
  const workspaceById = new Map(studios.map((w) => [w.id, w]));

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
              studioId: s.studioId,
              workspaceId: s.workspaceId,
              studio: s.studioId
                ? (() => {
                    const workspace = workspaceById.get(s.studioId);
                    if (!workspace) return null;
                    return {
                      id: workspace.id,
                      worktreePath: workspace.worktreePath,
                      worktreeFolder: path.basename(workspace.worktreePath),
                      branch: workspace.branch,
                    };
                  })()
                : null,
              currentPhase: s.currentPhase || null,
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
// SESSION PHASE HANDLER
// =====================================================

/**
 * Determines whether a phase transition should auto-create a memory.
 * Blocked and waiting phases create memories; active work phases don't.
 */
function isSignificantPhaseTransition(phase: string): boolean {
  return phase.startsWith('blocked:') || phase.startsWith('waiting:') || phase === 'complete';
}

export async function handleUpdateSessionPhase(args: unknown, dataComposer: DataComposer) {
  const params = updateSessionPhaseSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);
  const studioId = resolveStudioId(params);

  // Require at least one field to update
  if (
    !params.phase &&
    !params.backendSessionId &&
    !params.status &&
    !params.context &&
    !params.workingDir
  ) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error:
                'At least one field must be provided (phase, backendSessionId, status, context, workingDir).',
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // Resolve session: sessionId > studioId-scoped lookup > most recent active
  let sessionId = params.sessionId;
  if (!sessionId) {
    const session = await dataComposer.repositories.memory.getActiveSession(
      user.id,
      params.agentId,
      studioId // undefined = no studio/workspace filter (backward compat)
    );
    if (!session) {
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
    sessionId = session.id;
  }

  // Build update object
  const updates: {
    currentPhase?: string | null;
    status?: string;
    backendSessionId?: string;
    context?: string;
    workingDir?: string;
  } = {};

  if (params.phase !== undefined) {
    updates.currentPhase = params.phase;
  }
  if (params.status !== undefined) {
    updates.status = params.status;
  }
  if (params.backendSessionId !== undefined) {
    updates.backendSessionId = params.backendSessionId;
  }
  if (params.context !== undefined) {
    updates.context = params.context;
  }
  if (params.workingDir !== undefined) {
    updates.workingDir = params.workingDir;
  }

  const updated = await dataComposer.repositories.memory.updateSession(sessionId, updates);

  if (!updated) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: false, error: 'Session not found.' }, null, 2),
        },
      ],
    };
  }

  const messageParts: string[] = [];
  if (params.phase) messageParts.push(`phase → ${params.phase}`);
  if (params.status) messageParts.push(`status → ${params.status}`);
  if (params.backendSessionId) messageParts.push('backendSessionId set');
  if (params.context) messageParts.push('context updated');
  if (params.workingDir) messageParts.push('workingDir updated');

  const result: Record<string, unknown> = {
    success: true,
    message: `Session updated: ${messageParts.join(', ')}`,
    user: { id: user.id, resolvedBy },
    session: {
      id: updated.id,
      agentId: updated.agentId,
      studioId: updated.studioId,
      workspaceId: updated.workspaceId,
      currentPhase: updated.currentPhase || null,
    },
  };

  // Auto-create memory for significant phase transitions
  if (params.phase && isSignificantPhaseTransition(params.phase)) {
    const memoryContent = params.note
      ? `[${params.phase}] ${params.note}`
      : `Session entered phase: ${params.phase}`;

    const memory = await dataComposer.repositories.memory.remember({
      userId: user.id,
      content: memoryContent,
      source: 'session',
      salience: 'high',
      topics: ['session-phase', params.phase.split(':')[0]],
      metadata: { sessionId, phase: params.phase },
      agentId: params.agentId || updated.agentId,
    });

    result.memoryCreated = {
      id: memory.id,
      content: memoryContent,
    };

    logger.info(`Phase transition auto-created memory`, {
      sessionId,
      phase: params.phase,
      memoryId: memory.id,
    });
  }

  // Optionally create a task for blockers
  if (
    params.createTask &&
    params.phase &&
    (params.phase.startsWith('blocked:') || params.phase.startsWith('waiting:'))
  ) {
    try {
      const projects = await dataComposer.repositories.projects.findAllByUser(user.id, 'active');
      if (projects.length > 0) {
        const task = await dataComposer.repositories.projectTasks.create({
          project_id: projects[0].id,
          user_id: user.id,
          title: `[${params.phase}] ${params.note || 'Agent needs attention'}`,
          description: params.note || `Session ${sessionId} entered ${params.phase}`,
          priority: 'high',
          tags: [
            'agent-orchestration',
            'session-phase',
            params.agentId || updated.agentId || 'unknown',
          ],
          created_by: params.agentId || updated.agentId || 'system',
        });

        result.taskCreated = {
          id: task.id,
          title: task.title,
        };

        logger.info(`Phase transition auto-created task`, {
          sessionId,
          phase: params.phase,
          taskId: task.id,
        });
      }
    } catch (taskError) {
      logger.warn('Failed to auto-create task for phase transition:', taskError);
      result.taskError = 'Failed to create task (non-fatal)';
    }
  }

  logger.info(`Session updated`, { sessionId, phase: params.phase, status: params.status });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
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
 * - Identity Files: VALUES.md, USER.md, and agent-specific IDENTITY.md
 * - Identity Core: user, assistant, relationship context from DB
 * - Active Context: current projects, focus, recent high-salience memories
 * - Active Session: current session info if any
 */
export async function handleBootstrap(args: unknown, dataComposer: DataComposer) {
  const params = bootstrapSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  // Pin the agent identity for this session (immutable once set).
  // If request context already has an agentId from a token, validate it matches.
  if (params.agentId) {
    const reqCtx = getRequestContext();
    if (reqCtx?.agentId && reqCtx.agentId !== params.agentId) {
      throw new Error(
        `Token is bound to agent "${reqCtx.agentId}" but bootstrap was called with "${params.agentId}". ` +
          `Use a token issued for this agent, or remove the agent_id from the token.`
      );
    }
    pinSessionAgent(params.agentId);
  }

  // Set session context so subsequent MCP tool calls can use this user
  setSessionContext({
    userId: user.id,
    email: user.email || undefined,
    agentId: params.agentId,
  });

  const includeMemories = params.includeRecentMemories !== false;
  const agentId = params.agentId;
  const basePath = params.identityBasePath || path.join(os.homedir(), '.pcp');

  // Load identity files if agentId is provided
  let identityFiles: {
    agentId: string;
    values: string | null;
    user: string | null;
    process: string | null;
    self: string | null;
    heartbeat: string | null;
    soul: string | null;
  } | null = null;

  if (agentId) {
    // Load identity files from local filesystem
    // Path: ~/.pcp/individuals/{agentId}/IDENTITY.md for agent-specific
    // Path: ~/.pcp/shared/VALUES.md, USER.md, PROCESS.md for shared files
    const [valuesContent, userContent, processContent, selfContent, heartbeatContent, soulContent] =
      await Promise.all([
        safeReadFile(path.join(basePath, 'shared', 'VALUES.md')),
        safeReadFile(path.join(basePath, 'shared', 'USER.md')),
        safeReadFile(path.join(basePath, 'shared', 'PROCESS.md')),
        safeReadFile(path.join(basePath, 'individuals', agentId, 'IDENTITY.md')),
        safeReadFile(path.join(basePath, 'individuals', agentId, 'HEARTBEAT.md')),
        safeReadFile(path.join(basePath, 'individuals', agentId, 'SOUL.md')),
      ]);

    identityFiles = {
      agentId,
      values: valuesContent,
      user: userContent,
      process: processContent,
      self: selfContent,
      heartbeat: heartbeatContent,
      soul: soulContent,
    };
  }

  // Fetch all context in parallel (including timezone and skills)
  const cloudSkillsService = getCloudSkillsService(dataComposer.getClient());

  const [
    contexts,
    projects,
    focus,
    activeSessions,
    knowledgeMemories,
    dbIdentity,
    dbUserIdentity,
    userTimezone,
    userSkills,
  ] = await Promise.all([
    // Identity Core: all context summaries
    dataComposer.repositories.context.findAllByUser(user.id),
    // Active projects
    dataComposer.repositories.projects.findAllByUser(user.id, 'active'),
    // Current focus
    dataComposer.repositories.sessionFocus.findLatestByUser(user.id),
    // All active sessions (filter by agentId if provided) — client picks the right one
    dataComposer.repositories.memory.getActiveSessions(user.id, agentId),
    // Knowledge memories: all critical + recent high (for knowledge summary)
    includeMemories
      ? dataComposer.repositories.memory.getKnowledgeMemories(user.id, agentId)
      : Promise.resolve([]),
    // Database identity (for cloud agents, includes metadata, heartbeat, soul)
    agentId
      ? dataComposer
          .getClient()
          .from('agent_identities')
          .select('*')
          .eq('user_id', user.id)
          .eq('agent_id', agentId)
          .single()
          .then(({ data }) => data)
      : Promise.resolve(null),
    // Shared user identity (PROCESS.md from DB for cloud sync)
    dataComposer
      .getClient()
      .from('user_identity')
      .select('process_md')
      .eq('user_id', user.id)
      .single()
      .then(({ data }) => data || null),
    // User timezone for timestamp conversion
    dataComposer
      .getClient()
      .from('users')
      .select('timezone')
      .eq('id', user.id)
      .single()
      .then(({ data }) => data?.timezone || 'UTC'),
    // User's installed skills (local + cloud merged)
    cloudSkillsService.loadUserSkills(user.id).catch((err) => {
      logger.warn('Failed to load user skills:', err);
      return [];
    }),
  ]);

  // Organize contexts by type
  const identityCore = {
    user: contexts.find((c) => c.context_type === 'user' && !c.context_key),
    assistant: contexts.find((c) => c.context_type === 'assistant' && !c.context_key),
    relationship: contexts.find((c) => c.context_type === 'relationship' && !c.context_key),
  };

  const projectContexts = contexts.filter((c) => c.context_type === 'project');

  // Compute reflection status from identity metadata
  const identityMetadata = dbIdentity?.metadata as Record<string, unknown> | null;
  const lastReflectedAt = identityMetadata?.lastReflectedAt as string | null;
  let reflectionStatus: {
    lastReflectedAt: string | null;
    daysSince: number | null;
    suggestion: string | null;
  } | null = null;

  if (agentId) {
    let daysSince: number | null = null;
    let suggestion: string | null = null;

    if (lastReflectedAt) {
      const lastDate = new Date(lastReflectedAt);
      const now = new Date();
      daysSince = Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));

      if (daysSince >= 14) {
        suggestion = `It's been ${daysSince} days since your last reflection. Consider reviewing recent memories and updating your SOUL.md.`;
      } else if (daysSince >= 7) {
        suggestion = `It's been ${daysSince} days since your last reflection. You might want to review what's happened since then.`;
      }
    } else {
      suggestion =
        'No reflections recorded yet. When you have a quiet moment, consider reviewing your memories and capturing what matters in your SOUL.md.';
    }

    reflectionStatus = { lastReflectedAt, daysSince, suggestion };
  }

  // Merge identity: prioritize Supabase over local files
  // dbIdentity has: name, role, description, heartbeat, soul (per-agent)
  // dbUserIdentity has: process_md (shared across all SBs)
  // identityFiles has: values, user, process, self, heartbeat, soul (from filesystem)
  const mergedIdentity = identityFiles
    ? {
        ...identityFiles,
        // Override local files with Supabase content if available
        process: (dbUserIdentity?.process_md as string | null) || identityFiles.process,
        self: (dbIdentity?.description as string | null) || identityFiles.self,
        heartbeat: (dbIdentity?.heartbeat as string | null) || identityFiles.heartbeat,
        soul: (dbIdentity?.soul as string | null) || identityFiles.soul,
      }
    : null;

  // Build agent info from dbIdentity
  const agentInfo = dbIdentity
    ? {
        name: dbIdentity.name as string,
        role: dbIdentity.role as string,
        capabilities: dbIdentity.capabilities as Record<string, unknown> | null,
      }
    : null;

  // Build knowledge summary (or use cache for the text)
  let knowledgeSummaryResult: ReturnType<typeof buildKnowledgeSummary> | null = null;
  let cachedSummary: string | null = null;

  if (includeMemories && knowledgeMemories.length > 0) {
    // Always build the full result (needed for topicIndex regardless of cache)
    knowledgeSummaryResult = buildKnowledgeSummary(knowledgeMemories);

    // Try cache for the summary text (avoid regenerating the formatted string)
    try {
      const cached = await dataComposer.repositories.memory.getCachedSummary(user.id, agentId);
      if (cached) {
        cachedSummary = cached.summaryText;
      }
    } catch {
      // Cache miss or error — use freshly computed
    }

    if (!cachedSummary) {
      // Cache the computed summary in background (don't block response)
      dataComposer.repositories.memory
        .setCachedSummary(
          user.id,
          agentId,
          knowledgeSummaryResult.knowledgeSummary,
          knowledgeMemories.length
        )
        .catch(() => {}); // Fire and forget
    }
  }

  const knowledgeSummary = cachedSummary || knowledgeSummaryResult?.knowledgeSummary || '';
  const topicIndex = knowledgeSummaryResult?.topicIndex || [];

  logger.info(`Bootstrap loaded for user ${user.id}`, {
    agentId: agentId || 'none',
    contextCount: contexts.length,
    projectCount: projects.length,
    memoryCount: knowledgeMemories.length,
    knowledgeSummaryChars: knowledgeSummary.length,
    topicCount: topicIndex.length,
    usedCache: !!cachedSummary,
    skillCount: userSkills.length,
    activeSessionCount: activeSessions.length,
    hasIdentityFiles: !!identityFiles,
    hasDbIdentity: !!dbIdentity,
    identitySource: dbIdentity?.description ? 'supabase' : identityFiles?.self ? 'local' : 'none',
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: {
              id: user.id,
              resolvedBy,
              // User's timezone - ALWAYS convert UTC timestamps to this timezone when displaying to user
              timezone: userTimezone,
              // Platform contact info for sending messages
              contacts: {
                email: user.email || null,
                telegramId: user.telegram_id ? String(user.telegram_id) : null,
                whatsappId: user.whatsapp_id || null,
                phoneNumber: user.phone_number || null,
              },
            },

            // Agent info from Supabase (name, role, capabilities)
            agentInfo: agentInfo,

            // Identity files (merged: Supabase priority, local fallback)
            identityFiles: mergedIdentity,

            // Tier 1: Identity Core from DB
            identityCore: {
              user: identityCore.user
                ? { summary: identityCore.user.summary, metadata: identityCore.user.metadata }
                : null,
              assistant: identityCore.assistant
                ? {
                    summary: identityCore.assistant.summary,
                    metadata: identityCore.assistant.metadata,
                  }
                : null,
              relationship: identityCore.relationship
                ? {
                    summary: identityCore.relationship.summary,
                    metadata: identityCore.relationship.metadata,
                  }
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

            // All active sessions — use studioId to pick the right one
            // Match against .pcp/identity.json studioId/workspaceId in your local environment
            activeSessions: activeSessions.map((s) => ({
              id: s.id,
              agentId: s.agentId,
              studioId: s.studioId || null,
              workspaceId: s.workspaceId || null,
              threadKey: s.threadKey || null,
              currentPhase: s.currentPhase || null,
              startedAt: s.startedAt.toISOString(),
            })),

            // Knowledge summary: budget-constrained, grouped by topic (critical + high salience)
            // This is the MEMORY.md equivalent — read this first for what you know
            knowledgeSummary: knowledgeSummary || null,

            // Topic index: all topics with counts + recency (navigate with recall(topics: [...]))
            topicIndex: topicIndex.length > 0 ? topicIndex : null,

            // Database identity (structural fields only — heartbeat/soul already in identityFiles)
            dbIdentity: dbIdentity
              ? {
                  agentId: dbIdentity.agent_id,
                  name: dbIdentity.name,
                  role: dbIdentity.role,
                  description: dbIdentity.description,
                  values: dbIdentity.values,
                  capabilities: dbIdentity.capabilities,
                  relationships: dbIdentity.relationships,
                  metadata: dbIdentity.metadata,
                  version: dbIdentity.version,
                }
              : null,

            // Reflection status - prompt for periodic self-reflection
            reflectionStatus,

            // User's installed skills (local + cloud merged)
            // Use these to understand what capabilities are available
            skills: userSkills.map((skill) => ({
              name: skill.manifest.name,
              displayName: skill.manifest.displayName || skill.manifest.name,
              type: skill.manifest.type,
              description: skill.manifest.description,
              triggers: skill.manifest.triggers?.keywords || [],
              eligible: skill.eligibility.eligible,
              eligibilityMessage: skill.eligibility.message,
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
  const studioId = resolveStudioId(params);

  const minSalience = params.minSalience || 'medium';
  const preserveLogs = params.preserveLogs ?? false;

  // Get session ID
  let sessionId = params.sessionId;
  let session;

  if (sessionId) {
    session = await dataComposer.repositories.memory.getSession(sessionId);
  } else {
    session = await dataComposer.repositories.memory.getActiveSession(
      user.id,
      params.agentId,
      studioId
    );
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
  const logs = await dataComposer.repositories.memory.getSessionLogsBySalience(
    sessionId,
    minSalience
  );

  if (logs.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              message: 'No logs to compact at specified salience level',
              user: { id: user.id, resolvedBy },
              sessionId,
              logsProcessed: 0,
              memoriesCreated: 0,
            },
            null,
            2
          ),
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
    memoriesCreated.push({
      id: memory.id,
      salience: 'critical',
      content: log.content.substring(0, 100),
    });

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
    memoriesCreated.push({
      id: memory.id,
      salience: 'high',
      content: log.content.substring(0, 100),
    });

    // Soft-delete: mark log as compacted with link to memory
    if (!preserveLogs) {
      await dataComposer.repositories.memory.markSpecificLogsCompacted([log.id], memory.id);
      logsCompacted++;
    }
  }

  // Process medium logs - combine into a single summary memory if multiple
  if (bySalience.medium.length > 0) {
    const combinedContent =
      bySalience.medium.length === 1
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
    memoriesCreated.push({
      id: memory.id,
      salience: 'medium',
      content: combinedContent.substring(0, 100),
    });

    // Soft-delete: mark all medium logs as compacted with link to combined memory
    if (!preserveLogs) {
      const mediumLogIds = bySalience.medium.map((l) => l.id);
      logsCompacted += await dataComposer.repositories.memory.markSpecificLogsCompacted(
        mediumLogIds,
        memory.id
      );
    }
  }

  // Mark any remaining low-salience logs as compacted (discarded, no memory link)
  if (!preserveLogs && bySalience.low.length > 0) {
    const lowLogIds = bySalience.low.map((l) => l.id);
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
