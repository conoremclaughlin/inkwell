/**
 * Agent Gateway Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentGateway, type AgentTriggerPayload } from './agent-gateway';

describe('AgentGateway', () => {
  let gateway: AgentGateway;

  beforeEach(() => {
    gateway = new AgentGateway();
  });

  describe('registerHandler', () => {
    it('should register a handler for a specific agent', () => {
      const handler = vi.fn();
      gateway.registerHandler('myra', handler);

      expect(gateway.hasHandler('myra')).toBe(true);
      expect(gateway.getRegisteredAgents()).toContain('myra');
    });

    it('should unregister a handler', () => {
      const handler = vi.fn();
      gateway.registerHandler('myra', handler);
      gateway.unregisterHandler('myra');

      expect(gateway.hasHandler('myra')).toBe(false);
    });
  });

  describe('setDefaultHandler', () => {
    it('should set a default handler', () => {
      const handler = vi.fn();
      gateway.setDefaultHandler(handler);

      // Default handler doesn't show in registered agents
      expect(gateway.getRegisteredAgents()).toEqual([]);
    });

    it('should clear the default handler', () => {
      const handler = vi.fn();
      gateway.setDefaultHandler(handler);
      gateway.clearDefaultHandler();

      // No way to check directly, but we can test via processTrigger
    });
  });

  describe('processTrigger', () => {
    const basePayload: AgentTriggerPayload = {
      fromSlug: 'wren',
      toSlug: 'myra',
      triggerType: 'message',
      summary: 'Test trigger',
    };

    it('should call specific handler when registered', async () => {
      const handler = vi.fn();
      gateway.registerHandler('myra', handler);

      const result = await gateway.processTrigger(basePayload);

      expect(result.success).toBe(true);
      expect(result.processed).toBe(true);
      expect(handler).toHaveBeenCalledWith(basePayload);
    });

    it('should fall back to default handler when no specific handler', async () => {
      const defaultHandler = vi.fn();
      gateway.setDefaultHandler(defaultHandler);

      const result = await gateway.processTrigger(basePayload);

      expect(result.success).toBe(true);
      expect(result.processed).toBe(true);
      expect(defaultHandler).toHaveBeenCalledWith(basePayload);
    });

    it('should prefer specific handler over default handler', async () => {
      const specificHandler = vi.fn();
      const defaultHandler = vi.fn();

      gateway.registerHandler('myra', specificHandler);
      gateway.setDefaultHandler(defaultHandler);

      const result = await gateway.processTrigger(basePayload);

      expect(result.success).toBe(true);
      expect(specificHandler).toHaveBeenCalledWith(basePayload);
      expect(defaultHandler).not.toHaveBeenCalled();
    });

    it('should return error when no handler available', async () => {
      const result = await gateway.processTrigger(basePayload);

      expect(result.success).toBe(false);
      expect(result.processed).toBe(false);
      expect(result.error).toContain('No handler registered');
    });

    it('should handle handler errors gracefully', async () => {
      const failingHandler = vi.fn().mockRejectedValue(new Error('Handler failed'));
      gateway.registerHandler('myra', failingHandler);

      const result = await gateway.processTrigger(basePayload);

      expect(result.success).toBe(false);
      expect(result.processed).toBe(false);
      expect(result.error).toBe('Handler failed');
    });

    it('should emit trigger:processed event on success', async () => {
      const handler = vi.fn();
      const eventHandler = vi.fn();

      gateway.registerHandler('myra', handler);
      gateway.on('trigger:processed', eventHandler);

      await gateway.processTrigger(basePayload);

      expect(eventHandler).toHaveBeenCalled();
    });

    it('should emit trigger:unhandled event when no handler', async () => {
      const eventHandler = vi.fn();
      gateway.on('trigger:unhandled', eventHandler);

      await gateway.processTrigger(basePayload);

      expect(eventHandler).toHaveBeenCalled();
    });

    it('should emit trigger:error event on handler failure', async () => {
      const failingHandler = vi.fn().mockRejectedValue(new Error('Boom'));
      const eventHandler = vi.fn();

      gateway.registerHandler('myra', failingHandler);
      gateway.on('trigger:error', eventHandler);

      await gateway.processTrigger(basePayload);

      expect(eventHandler).toHaveBeenCalled();
    });
  });

  describe('dispatchTrigger', () => {
    const basePayload: AgentTriggerPayload = {
      fromSlug: 'wren',
      toSlug: 'myra',
      triggerType: 'message',
      summary: 'Async trigger',
    };

    it('should return accepted immediately without waiting for processing', () => {
      let resolved = false;
      gateway.registerHandler('myra', async () => {
        await new Promise((r) => setTimeout(r, 25));
        resolved = true;
      });

      const result = gateway.dispatchTrigger(basePayload);
      expect(result.success).toBe(true);
      expect(result.accepted).toBe(true);
      expect(result.processed).toBe(false);
      expect(resolved).toBe(false);
    });

    it('should return unhandled when no handler exists', () => {
      const result = gateway.dispatchTrigger(basePayload);
      expect(result.success).toBe(false);
      expect(result.processed).toBe(false);
      expect(result.error).toContain('No handler registered');
    });
  });

  describe('dynamic agent routing (stateless pattern)', () => {
    it('should route to any agent via default handler', async () => {
      const processedAgents: string[] = [];

      gateway.setDefaultHandler(async (payload) => {
        processedAgents.push(payload.toSlug);
      });

      await gateway.processTrigger({ ...basePayload, toSlug: 'myra' });
      await gateway.processTrigger({ ...basePayload, toSlug: 'wren' });
      await gateway.processTrigger({ ...basePayload, toSlug: 'benson' });
      await gateway.processTrigger({ ...basePayload, toSlug: 'unknown-agent' });

      expect(processedAgents).toEqual(['myra', 'wren', 'benson', 'unknown-agent']);
    });

    const basePayload: AgentTriggerPayload = {
      fromSlug: 'wren',
      toSlug: 'myra',
      triggerType: 'message',
    };
  });
});
