/**
 * Agent Trigger Routes
 *
 * HTTP endpoints for agent-to-agent communication triggers.
 * This provides the "doorbell" mechanism - instant wake-up for agents.
 */

import { Router } from 'express';
import { getAgentGateway, type AgentTriggerPayload } from '../channels/agent-gateway';
import { logger } from '../utils/logger';

const router: Router = Router();

/**
 * POST /api/agent/trigger
 *
 * Trigger an agent to wake up and process messages.
 * Use alongside send_to_inbox for reliable async communication.
 */
router.post('/trigger', async (req, res) => {
  try {
    const payload = req.body as AgentTriggerPayload;

    // Validate required fields
    if (!payload.fromAgentId || !payload.toAgentId || !payload.triggerType) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: fromAgentId, toAgentId, triggerType',
      });
      return;
    }

    logger.info('[AgentTrigger] HTTP trigger received', {
      from: payload.fromAgentId,
      to: payload.toAgentId,
      type: payload.triggerType,
    });

    const gateway = getAgentGateway();
    const result = gateway.dispatchTrigger(payload);

    if (result.success) {
      res.json(result);
    } else {
      const statusCode = result.error?.includes('No handler') ? 404 : 500;
      res.status(statusCode).json(result);
    }
  } catch (error) {
    logger.error('[AgentTrigger] HTTP endpoint error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * GET /api/agent/handlers
 *
 * List registered agent handlers (for debugging/monitoring).
 */
router.get('/handlers', (_req, res) => {
  const gateway = getAgentGateway();
  const agents = gateway.getRegisteredAgents();

  res.json({
    success: true,
    registeredAgents: agents,
    count: agents.length,
  });
});

/**
 * GET /api/agent/health
 *
 * Health check for agent gateway.
 */
router.get('/health', (_req, res) => {
  const gateway = getAgentGateway();

  res.json({
    status: 'ok',
    registeredAgents: gateway.getRegisteredAgents(),
  });
});

export default router;

// Re-export gateway for handler registration
export { getAgentGateway } from '../channels/agent-gateway';
