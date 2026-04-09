/**
 * MCP Tool Handlers for Work Strategies
 *
 * Tools for managing autonomous task execution strategies.
 * Phase 1: persistence strategy (sequential task execution in same session).
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import type {
  StrategyPreset,
  VerificationMode,
} from '../../data/repositories/task-groups.repository';
import { StrategyService } from '../../services/strategy.service';
import { resolveUser, type UserIdentifier } from '../../services/user-resolver';
import { getEffectiveAgentId } from '../../auth/enforce-identity';

const userIdentifierSchema = z.object({
  userId: z
    .string()
    .uuid()
    .optional()
    .describe('User UUID — usually unnecessary, auto-resolved from OAuth token'),
  email: z
    .string()
    .email()
    .optional()
    .describe('User email — usually unnecessary, auto-resolved from OAuth token'),
  platform: z
    .enum(['telegram', 'whatsapp', 'discord'])
    .optional()
    .describe('Platform name — only needed for platform-based user lookup'),
  platformId: z
    .string()
    .optional()
    .describe('Platform-specific user ID — only needed for platform-based user lookup'),
});

type McpResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function mcpResponse(data: object, isError = false): McpResponse {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    isError,
  };
}

// ============================================================================
// START STRATEGY
// ============================================================================

export const startStrategySchema = z.object({
  ...userIdentifierSchema.shape,
  groupId: z.string().uuid().describe('Task group ID to activate strategy on'),
  strategy: z
    .enum(['persistence', 'review', 'architect', 'parallel', 'swarm'])
    .describe('Strategy preset to use'),
  ownerAgentId: z
    .string()
    .optional()
    .describe('Agent ID that will execute the strategy. Defaults to calling agent.'),
  planUri: z
    .string()
    .optional()
    .describe('Artifact URI for the plan (e.g., ink://specs/oauth-pkce)'),
  verificationMode: z
    .enum(['self', 'peer', 'architect'])
    .optional()
    .default('self')
    .describe('How task completion is validated'),
  checkInInterval: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Post progress check-in every N tasks'),
  checkInNotify: z.string().optional().describe('Agent ID to notify on check-ins (e.g., "myra")'),
  approvalNotify: z.string().optional().describe('Agent ID to notify when approval is needed'),
  maxIterationsWithoutApproval: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Pause after N tasks without human approval'),
  contextSummaryInterval: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Compact context every N tasks'),
  verificationGates: z
    .array(z.string())
    .optional()
    .describe('What must pass before advancing (e.g., ["tests", "build"])'),
});

export async function handleStartStrategy(
  args: z.infer<typeof startStrategySchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    const agentId = getEffectiveAgentId(args.ownerAgentId);

    const service = new StrategyService(dataComposer);
    const result = await service.startStrategy({
      groupId: args.groupId,
      userId: resolved.user.id,
      strategy: args.strategy as StrategyPreset,
      ownerAgentId: agentId || args.ownerAgentId || 'unknown',
      verificationMode: args.verificationMode as VerificationMode,
      planUri: args.planUri,
      config: {
        planUri: args.planUri,
        checkInInterval: args.checkInInterval,
        checkInNotify: args.checkInNotify,
        approvalNotify: args.approvalNotify,
        maxIterationsWithoutApproval: args.maxIterationsWithoutApproval,
        contextSummaryInterval: args.contextSummaryInterval,
        verificationGates: args.verificationGates,
      },
    });

    return mcpResponse({
      success: true,
      ...result,
      nextTask: result.nextTask
        ? {
            id: result.nextTask.id,
            title: result.nextTask.title,
            description: result.nextTask.description,
            taskOrder: result.nextTask.task_order,
            status: result.nextTask.status,
          }
        : null,
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start strategy',
      },
      true
    );
  }
}

// ============================================================================
// PAUSE STRATEGY
// ============================================================================

export const pauseStrategySchema = z.object({
  ...userIdentifierSchema.shape,
  groupId: z.string().uuid().describe('Task group ID to pause'),
});

export async function handlePauseStrategy(
  args: z.infer<typeof pauseStrategySchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    const service = new StrategyService(dataComposer);
    const group = await service.pauseStrategy(args.groupId, resolved.user.id);

    return mcpResponse({
      success: true,
      groupId: group.id,
      title: group.title,
      status: group.status,
      strategy: group.strategy,
      pausedAt: group.strategy_paused_at,
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to pause strategy',
      },
      true
    );
  }
}

// ============================================================================
// RESUME STRATEGY (also serves as approve_continuation)
// ============================================================================

export const resumeStrategySchema = z.object({
  ...userIdentifierSchema.shape,
  groupId: z.string().uuid().describe('Task group ID to resume'),
});

export async function handleResumeStrategy(
  args: z.infer<typeof resumeStrategySchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    const service = new StrategyService(dataComposer);
    const result = await service.resumeStrategy(args.groupId, resolved.user.id);

    return mcpResponse({
      success: true,
      ...result,
      nextTask: result.nextTask
        ? {
            id: result.nextTask.id,
            title: result.nextTask.title,
            description: result.nextTask.description,
            taskOrder: result.nextTask.task_order,
            status: result.nextTask.status,
          }
        : null,
    });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to resume strategy',
      },
      true
    );
  }
}

// ============================================================================
// GET STRATEGY STATUS
// ============================================================================

export const getStrategyStatusSchema = z.object({
  ...userIdentifierSchema.shape,
  groupId: z.string().uuid().describe('Task group ID to get status for'),
});

export async function handleGetStrategyStatus(
  args: z.infer<typeof getStrategyStatusSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const resolved = await resolveUser(args as UserIdentifier, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    const service = new StrategyService(dataComposer);
    const status = await service.getStrategyStatus(args.groupId, resolved.user.id);

    return mcpResponse({ success: true, ...status });
  } catch (error) {
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get strategy status',
      },
      true
    );
  }
}
