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
import { resolveUser } from '../../services/user-resolver';
import { senderRoutingContext, isBridgeIdentity, senderSbId } from './sender-context.js';
import { getPinnedAgentId } from '../../utils/request-context';
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
  studioId: z
    .string()
    .uuid()
    .optional()
    .describe('Optional explicit studio ID for the target agent session'),
  studioHint: z
    .string()
    .optional()
    .describe(
      'Convenience studio routing hint (e.g., "main" for shared main studio, or a studio name)'
    ),
  recipientSessionId: z
    .string()
    .uuid()
    .optional()
    .describe('Optional recipient session ID to inherit studio scope from'),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe('Additional context to pass to the target agent'),
});

export async function handleTriggerAgent(
  args: z.infer<typeof triggerAgentSchema>,
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    logger.info(`trigger_agent called: ${args.fromAgentId} → ${args.toAgentId}`, {
      type: args.triggerType,
      priority: args.priority,
    });

    // Stamp the AUTHENTICATED user onto the payload (server-side, post-auth —
    // trustworthy provenance, unlike caller-supplied fields on public trigger
    // routes). Without it, a bare trigger_agent(threadKey) failure cannot be
    // routed anywhere: the failure listener has no source row to resolve the
    // user from, so the notice was silently dropped (PR #487, Lumen).
    const resolved = await resolveUser({}, dataComposer).catch(() => null);

    const gateway = getAgentGateway();

    // Check if target has a handler
    if (!gateway.hasHandler(args.toAgentId)) {
      // Still attempt - handler might be registered by the time we process
      logger.warn(`No handler currently registered for ${args.toAgentId}, attempting anyway`);
    }

    // Resolved before the payload literal and defensively: a composer without
    // a client (or a lookup failure) must not take down the dispatch — it only
    // means no bridge exclusion, and routing already fails closed from there.
    let senderIsBridge = false;
    try {
      const client =
        typeof dataComposer?.getClient === 'function' ? dataComposer.getClient() : null;
      if (client && resolved?.user?.id) {
        // Classify the AUTHENTICATED sender, never args.fromAgentId — that is
        // caller-supplied, so a relay could simply claim a non-bridge name and
        // re-enable the inference this exclusion exists to prevent
        // (Lumen, PR #514 round 2). Falls back to the declared slug only when
        // there is no pinned identity, which is the unauthenticated path.
        const pinned = getPinnedAgentId();
        senderIsBridge = await isBridgeIdentity(
          client,
          resolved.user.id,
          pinned || args.fromAgentId,
          senderSbId()
        );
      }
    } catch {
      senderIsBridge = false;
    }

    const payload: AgentTriggerPayload = {
      fromAgentId: args.fromAgentId,
      toAgentId: args.toAgentId,
      triggerType: args.triggerType,
      summary: args.summary,
      inboxMessageId: args.inboxMessageId,
      priority: args.priority,
      threadKey: args.threadKey,
      studioId: args.studioId,
      studioHint: args.studioHint,
      recipientSessionId: args.recipientSessionId,
      // Caller-repo inference degrades silently to refuse-and-hold on any
      // dispatch path that forgets this (Lumen, PR #514 round 1).
      ...senderRoutingContext(senderIsBridge),
      ...(resolved?.user?.id ? { recipientUserId: resolved.user.id } : {}),
      metadata: args.metadata,
    };

    const result = gateway.dispatchTrigger(payload);

    if (result.success) {
      return mcpResponse({
        success: true,
        triggerId: result.triggerId,
        accepted: result.accepted === true,
        processed: result.processed,
        message:
          result.accepted === true
            ? `Agent ${args.toAgentId} trigger accepted`
            : `Agent ${args.toAgentId} triggered successfully`,
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
  dataComposer: DataComposer
): Promise<McpResponse> {
  try {
    // Resolve current user from request context (OAuth token)
    const resolved = await resolveUser({}, dataComposer);
    if (!resolved) {
      return mcpResponse({ success: false, error: 'User not found' }, true);
    }

    // Query agent_identities scoped to the current user.
    // The in-memory trigger handler registry only tracks agents with active
    // runtime listeners — it's empty after restarts or when agents use
    // polling instead of persistent connections.
    const { data: identities, error } = await dataComposer
      .getClient()
      .from('agent_identities')
      .select('agent_id, name, backend')
      .eq('user_id', resolved.user.id)
      .order('agent_id');

    if (error) {
      throw new Error(`Failed to query agent identities: ${error.message}`);
    }

    // Dedupe by agent_id (an agent can have multiple identity records across workspaces)
    const seen = new Set<string>();
    const agents = (identities || [])
      .filter((row) => {
        if (seen.has(row.agent_id)) return false;
        seen.add(row.agent_id);
        return true;
      })
      .map((row) => ({
        agentId: row.agent_id,
        name: row.name,
        backend: row.backend,
      }));

    // Also note which agents have active runtime trigger handlers
    const gateway = getAgentGateway();
    const runtimeHandlers = new Set(gateway.getRegisteredAgents());

    return mcpResponse({
      success: true,
      registeredAgents: agents.map((a) => ({
        ...a,
        hasRuntimeHandler: runtimeHandlers.has(a.agentId),
      })),
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
