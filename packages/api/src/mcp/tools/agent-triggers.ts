/**
 * MCP Tools for Agent-to-Agent Communication
 *
 * These tools enable agents (like Wren/Claude Code) to trigger other agents
 * (like Myra) without waiting for polling intervals.
 *
 * Pattern:
 * 1. Use send_to_inbox to persist the message (the "mailbox")
 * 2. Use trigger_agent to wake the target immediately (the "doorbell")
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { getAgentGateway, type AgentTriggerPayload } from '../../channels/agent-gateway';
import { logger } from '../../utils/logger';

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
// TRIGGER AGENT
// ============================================================================

export const triggerAgentSchema = z.object({
  toAgentId: z.string().describe('Target agent ID to trigger (e.g., "myra", "wren")'),
  fromAgentId: z.string().describe('Your agent ID (e.g., "claude-code", "wren")'),
  triggerType: z
    .enum(['task_complete', 'approval_needed', 'message', 'error', 'custom'])
    .describe('Type of trigger - helps recipient know how to handle'),
  summary: z.string().optional().describe('Brief summary of what happened / why triggering'),
  inboxMessageId: z
    .string()
    .optional()
    .describe('ID of the inbox message to process (from send_to_inbox)'),
  priority: z
    .enum(['low', 'normal', 'high', 'urgent'])
    .optional()
    .default('normal')
    .describe('Priority level for the trigger'),
  threadKey: z
    .string()
    .optional()
    .describe('Thread key for session routing on the recipient side (e.g., "pr:32")'),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe('Additional context to pass to the target agent'),
});

export async function handleTriggerAgent(
  args: z.infer<typeof triggerAgentSchema>,
  _dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    logger.info(`trigger_agent called: ${args.fromAgentId} → ${args.toAgentId}`, {
      type: args.triggerType,
      priority: args.priority,
    });

    const gateway = getAgentGateway();

    // Check if target has a handler
    if (!gateway.hasHandler(args.toAgentId)) {
      // Still attempt - handler might be registered by the time we process
      logger.warn(`No handler currently registered for ${args.toAgentId}, attempting anyway`);
    }

    const payload: AgentTriggerPayload = {
      fromAgentId: args.fromAgentId,
      toAgentId: args.toAgentId,
      triggerType: args.triggerType,
      summary: args.summary,
      inboxMessageId: args.inboxMessageId,
      priority: args.priority,
      threadKey: args.threadKey,
      metadata: args.metadata,
    };

    const result = await gateway.processTrigger(payload);

    if (result.success) {
      return mcpResponse({
        success: true,
        triggerId: result.triggerId,
        message: `Agent ${args.toAgentId} triggered successfully`,
      });
    } else {
      return mcpResponse(
        {
          success: false,
          triggerId: result.triggerId,
          error: result.error,
          hint: result.error?.includes('No handler')
            ? `Agent "${args.toAgentId}" may not be running or doesn't have a trigger handler registered`
            : undefined,
        },
        true
      );
    }
  } catch (error) {
    logger.error('Error in trigger_agent:', error);
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to trigger agent',
      },
      true
    );
  }
}

// ============================================================================
// LIST REGISTERED AGENTS
// ============================================================================

export const listRegisteredAgentsSchema = z.object({});

export async function handleListRegisteredAgents(
  _args: z.infer<typeof listRegisteredAgentsSchema>,
  _dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    const gateway = getAgentGateway();
    const agents = gateway.getRegisteredAgents();

    return mcpResponse({
      success: true,
      registeredAgents: agents,
      count: agents.length,
    });
  } catch (error) {
    logger.error('Error in list_registered_agents:', error);
    return mcpResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list agents',
      },
      true
    );
  }
}
