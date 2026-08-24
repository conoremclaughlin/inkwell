import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerAllTools } from './index';

class FakeMcpServer {
  public registeredTools: string[] = [];
  public schemas = new Map<string, z.ZodRawShape>();

  registerTool(name: string, config?: { inputSchema?: z.ZodRawShape }): void {
    this.registeredTools.push(name);
    if (config?.inputSchema) this.schemas.set(name, config.inputSchema);
  }
}

describe('registerAllTools lifecycle visibility', () => {
  it('omits internal lifecycle tools when includeInternalLifecycleTools=false', () => {
    const server = new FakeMcpServer();
    const dataComposer = { getClient: () => ({}) };
    registerAllTools(server as unknown as any, dataComposer as any, {
      includeInternalLifecycleTools: false,
    });

    expect(server.registeredTools).not.toContain('start_session');
    expect(server.registeredTools).not.toContain('end_session');
    expect(server.registeredTools).toContain('update_session_state');
  });

  it('includes lifecycle tools when includeInternalLifecycleTools=true', () => {
    const server = new FakeMcpServer();
    const dataComposer = { getClient: () => ({}) };
    registerAllTools(server as unknown as any, dataComposer as any, {
      includeInternalLifecycleTools: true,
    });

    expect(server.registeredTools).toContain('start_session');
    expect(server.registeredTools).toContain('end_session');
    expect(server.registeredTools).not.toContain('log_session');
    expect(server.registeredTools).toContain('update_session_state');
    expect(server.registeredTools).toContain('get_agent_summaries');
  });
});

// The registered inputSchema is a second copy of the handler's Zod schema, and
// z.object() strips unknown keys silently. That is how dueDate went missing:
// callers passed it, validation dropped it, and the tool still reported success.
describe('task tool schemas accept dueDate', () => {
  function schemaFor(tool: string): z.ZodObject<z.ZodRawShape> {
    const server = new FakeMcpServer();
    registerAllTools(server as unknown as any, { getClient: () => ({}) } as any, {
      includeInternalLifecycleTools: true,
    });
    const registered = server.schemas.get(tool);
    expect(registered, `${tool} registered no inputSchema`).toBeDefined();
    // The registration interceptor (strict-input-schema) may have already
    // converted the raw shape into a ZodObject — use what is actually
    // enforced; wrap only a raw shape.
    if (typeof (registered as { safeParse?: unknown }).safeParse === 'function') {
      return registered as unknown as z.ZodObject<z.ZodRawShape>;
    }
    return z.object(registered!);
  }

  it('create_task keeps dueDate through validation', () => {
    const parsed = schemaFor('create_task').parse({
      title: 'Renew inkah.com',
      dueDate: '2026-09-14',
    });
    expect(parsed.dueDate).toBe('2026-09-14');
  });

  it('update_task keeps dueDate through validation', () => {
    const parsed = schemaFor('update_task').parse({
      taskId: '00000000-0000-4000-a000-000000000000',
      dueDate: '2026-09-14',
    });
    expect(parsed.dueDate).toBe('2026-09-14');
  });

  it('update_task distinguishes clearing a due date from omitting it', () => {
    const schema = schemaFor('update_task');
    const taskId = '00000000-0000-4000-a000-000000000000';

    expect(schema.parse({ taskId, dueDate: null }).dueDate).toBeNull();
    expect('dueDate' in schema.parse({ taskId })).toBe(false);
  });
});
