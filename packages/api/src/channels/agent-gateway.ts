/**
 * Agent Gateway
 *
 * Enables agent-to-agent communication via HTTP webhooks.
 * This is the "doorbell" - agents can trigger each other instantly
 * while the Agent Inbox serves as the "mailbox" for message persistence.
 *
 * Architecture:
 * 1. Agent A finishes task → sends to Agent B's inbox (persistent)
 * 2. Agent A calls trigger_agent → HTTP POST to this gateway
 * 3. Gateway wakes Agent B → injects inbox message → processes
 * 4. Agent B responds → can reply back to Agent A's inbox
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

export interface AgentTriggerPayload {
  /** Agent sending the trigger (e.g., "wren", "claude-code") */
  fromAgentId: string;
  /** Target agent to wake up (e.g., "myra") */
  toAgentId: string;
  /** Optional inbox message ID that prompted this trigger */
  inboxMessageId?: string;
  /** Trigger type for routing */
  triggerType: 'task_complete' | 'approval_needed' | 'message' | 'error' | 'custom';
  /** Short summary for logging/display */
  summary?: string;
  /** Priority level */
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  /** Thread key for session routing (e.g., "pr:32") */
  threadKey?: string;
  /** Explicit studio/worktree scope for the target agent */
  studioId?: string;
  /** Convenience studio routing hint (e.g., 'main' or a studio name) */
  studioHint?: string;
  /** Recipient session to inherit studio scope from */
  recipientSessionId?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface AgentTriggerResponse {
  success: boolean;
  triggerId: string;
  processed: boolean;
  accepted?: boolean;
  error?: string;
}

export type TriggerCallback = (payload: AgentTriggerPayload) => Promise<void>;

/**
 * Agent Gateway - handles agent-to-agent triggers
 *
 * Similar to TelegramListener/WhatsAppListener but for inter-agent communication.
 * Registered handlers process triggers by agent ID.
 *
 * Supports:
 * - Specific handlers: registerHandler(agentId, callback) for per-agent handling
 * - Default handler: setDefaultHandler(callback) for dynamic/stateless routing
 */
export class AgentGateway extends EventEmitter {
  private handlers: Map<string, TriggerCallback> = new Map();
  private defaultHandler: TriggerCallback | null = null;
  private triggerCounter = 0;

  constructor() {
    super();
    logger.info('[AgentGateway] Initialized');
  }

  /**
   * Register a handler for a specific agent
   * When a trigger comes in for this agent, the handler is called
   */
  registerHandler(agentId: string, callback: TriggerCallback): void {
    this.handlers.set(agentId, callback);
    logger.info(`[AgentGateway] Handler registered for agent: ${agentId}`);
  }

  /**
   * Unregister a handler
   */
  unregisterHandler(agentId: string): void {
    this.handlers.delete(agentId);
    logger.info(`[AgentGateway] Handler unregistered for agent: ${agentId}`);
  }

  /**
   * Set a default handler for agents without specific handlers.
   * Enables stateless, database-driven agent routing.
   */
  setDefaultHandler(callback: TriggerCallback): void {
    this.defaultHandler = callback;
    logger.info('[AgentGateway] Default handler registered');
  }

  /**
   * Clear the default handler
   */
  clearDefaultHandler(): void {
    this.defaultHandler = null;
    logger.info('[AgentGateway] Default handler cleared');
  }

  /**
   * Resolve handler for target agent (specific handler first, then default)
   */
  private resolveHandler(payload: AgentTriggerPayload): {
    handler: TriggerCallback | null;
    isDefaultHandler: boolean;
  } {
    const handler = this.handlers.get(payload.toAgentId) || this.defaultHandler;
    const isDefaultHandler = !this.handlers.has(payload.toAgentId);
    return { handler, isDefaultHandler };
  }

  /**
   * Execute a trigger handler lifecycle (shared by sync/async entrypoints)
   */
  private async executeTrigger(
    triggerId: string,
    payload: AgentTriggerPayload,
    handler: TriggerCallback,
    isDefaultHandler: boolean
  ): Promise<void> {
    if (isDefaultHandler) {
      logger.info(`[AgentGateway] Using default handler for agent: ${payload.toAgentId}`);
    }

    await handler(payload);
    this.emit('trigger:processed', { triggerId, payload });
    logger.info(`[AgentGateway] Trigger ${triggerId} processed successfully`);
  }

  /**
   * Dispatch an incoming trigger asynchronously (fast-ack pattern).
   * Returns as soon as trigger is accepted, without waiting for full processing.
   */
  dispatchTrigger(payload: AgentTriggerPayload): AgentTriggerResponse {
    const triggerId = `trigger_${++this.triggerCounter}_${Date.now()}`;
    logger.info(`[AgentGateway] Dispatching trigger ${triggerId} (async)`, {
      from: payload.fromAgentId,
      to: payload.toAgentId,
      type: payload.triggerType,
      priority: payload.priority,
    });

    const { handler, isDefaultHandler } = this.resolveHandler(payload);
    if (!handler) {
      logger.warn(`[AgentGateway] No handler for agent: ${payload.toAgentId}`);
      this.emit('trigger:unhandled', { triggerId, payload });

      return {
        success: false,
        triggerId,
        processed: false,
        error: `No handler registered for agent: ${payload.toAgentId}`,
      };
    }

    this.emit('trigger:accepted', { triggerId, payload });

    // Fire-and-forget execution
    void (async () => {
      try {
        await this.executeTrigger(triggerId, payload, handler, isDefaultHandler);
      } catch (error) {
        logger.error(`[AgentGateway] Trigger ${triggerId} failed:`, error);
        this.emit('trigger:error', { triggerId, payload, error });
      }
    })();

    return {
      success: true,
      triggerId,
      processed: false,
      accepted: true,
    };
  }

  /**
   * Process an incoming trigger synchronously (waits for handler completion).
   * Called where strong delivery/processing semantics are required.
   */
  async processTrigger(payload: AgentTriggerPayload): Promise<AgentTriggerResponse> {
    const triggerId = `trigger_${++this.triggerCounter}_${Date.now()}`;
    logger.info(`[AgentGateway] Processing trigger ${triggerId}`, {
      from: payload.fromAgentId,
      to: payload.toAgentId,
      type: payload.triggerType,
      priority: payload.priority,
    });

    const { handler, isDefaultHandler } = this.resolveHandler(payload);
    if (!handler) {
      logger.warn(`[AgentGateway] No handler for agent: ${payload.toAgentId}`);
      this.emit('trigger:unhandled', { triggerId, payload });
      return {
        success: false,
        triggerId,
        processed: false,
        error: `No handler registered for agent: ${payload.toAgentId}`,
      };
    }

    try {
      await this.executeTrigger(triggerId, payload, handler, isDefaultHandler);
      return { success: true, triggerId, processed: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[AgentGateway] Trigger ${triggerId} failed:`, error);
      this.emit('trigger:error', { triggerId, payload, error });
      return {
        success: false,
        triggerId,
        processed: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Get list of registered agent handlers
   */
  getRegisteredAgents(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Check if an agent has a registered handler
   */
  hasHandler(agentId: string): boolean {
    return this.handlers.has(agentId);
  }
}

// Singleton instance
let globalAgentGateway: AgentGateway | null = null;

/**
 * Get or create the global agent gateway instance
 */
export function getAgentGateway(): AgentGateway {
  if (!globalAgentGateway) {
    globalAgentGateway = new AgentGateway();
  }
  return globalAgentGateway;
}

/**
 * Create HTTP routes for the agent gateway
 * Call this from server.ts to add the /api/agent/trigger endpoint
 */
export function createAgentGatewayRoutes(app: {
  post: (path: string, handler: (req: unknown, res: unknown) => Promise<void>) => void;
}): void {
  const gateway = getAgentGateway();

  // POST /api/agent/trigger - receive triggers from other agents
  app.post('/api/agent/trigger', async (req: unknown, res: unknown) => {
    const request = req as { body: AgentTriggerPayload };
    const response = res as {
      json: (data: unknown) => void;
      status: (code: number) => { json: (data: unknown) => void };
    };

    try {
      const payload = request.body;

      // Validate required fields
      if (!payload.fromAgentId || !payload.toAgentId || !payload.triggerType) {
        response.status(400).json({
          success: false,
          error: 'Missing required fields: fromAgentId, toAgentId, triggerType',
        });
        return;
      }

      const result = gateway.dispatchTrigger(payload);

      if (result.success) {
        response.json(result);
      } else {
        response.status(result.error?.includes('No handler') ? 404 : 500).json(result);
      }
    } catch (error) {
      logger.error('[AgentGateway] HTTP endpoint error:', error);
      response.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  });

  logger.info('[AgentGateway] HTTP routes registered: POST /api/agent/trigger');
}
