import { describe, expect, it, afterEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { strictifyInputSchema, strictToolArgsEnabled } from './strict-input-schema';
import { registerAllTools } from './index';

describe('strictifyInputSchema', () => {
  it('makes a ZodObject reject unknown keys', () => {
    const schema = strictifyInputSchema(z.object({ runAt: z.string() })) as z.ZodTypeAny;

    expect(schema.safeParse({ runAt: 'now' }).success).toBe(true);
    const result = schema.safeParse({ remindAt: 'now' });
    expect(result.success).toBe(false);
    // The rejected key must be named — a model can only self-correct if the
    // error says which parameter was wrong.
    expect(JSON.stringify(result.error?.issues)).toContain('remindAt');
  });

  it('promotes a raw zod shape to a strict object', () => {
    // save_link and friends pass an inline shape rather than a z.object().
    const schema = strictifyInputSchema({ url: z.string() }) as z.ZodTypeAny;

    expect(schema).toBeInstanceOf(z.ZodObject);
    expect(schema.safeParse({ url: 'https://x.test' }).success).toBe(true);
    expect(schema.safeParse({ url: 'https://x.test', bogus: 1 }).success).toBe(false);
  });

  it('tightens an empty shape too — no declared params means accept none', () => {
    // debug_request registers `inputSchema: {}`. This used to be left
    // permissive, which made classification 162/163 (Lumen, #511 review).
    const schema = strictifyInputSchema({}) as z.ZodTypeAny;

    expect(schema).toBeInstanceOf(z.ZodObject);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ bogus: true }).success).toBe(false);
  });

  it('leaves non-object and non-shape schemas alone', () => {
    const union = z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]);
    expect(strictifyInputSchema(union)).toBe(union);
    expect(strictifyInputSchema(undefined)).toBeUndefined();
    // A record whose values are not schemas is not a raw shape.
    const notAShape = { a: 1, b: 'two' };
    expect(strictifyInputSchema(notAShape)).toBe(notAShape);
  });

  it('covers every registered tool, with no permissive stragglers', async () => {
    // Lumen's 162/163 finding: one tool slipping through is exactly the kind
    // of gap that a spot check misses, so assert the whole registry.
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { registerAllTools } = await import('./index');

    const captured: Array<{ name: string; inputSchema: unknown }> = [];
    const server: any = {
      registerTool: (name: string, config: any) =>
        captured.push({ name, inputSchema: config?.inputSchema }),
    };
    const stub: any = new Proxy(function () {} as any, {
      get: () => stub,
      apply: () => stub,
      construct: () => stub,
    });
    registerAllTools(server, stub);
    void McpServer;

    const permissive = captured.filter(({ inputSchema }) => {
      if (!(inputSchema instanceof z.ZodObject)) return true;
      return inputSchema.safeParse({ __definitely_not_a_real_param__: 1 }).success;
    });

    expect(permissive.map((t) => t.name)).toEqual([]);
    expect(captured.length).toBeGreaterThan(150);
  });

  it('is idempotent on already-strict schemas', () => {
    const once = strictifyInputSchema(z.object({ a: z.string() }).strict()) as z.ZodTypeAny;
    expect(once.safeParse({ a: 'x', extra: 1 }).success).toBe(false);
    expect(once.safeParse({ a: 'x' }).success).toBe(true);
  });
});

describe('INK_STRICT_TOOL_ARGS kill switch', () => {
  afterEach(() => {
    delete process.env.INK_STRICT_TOOL_ARGS;
  });

  it('is enabled by default and disabled only by an explicit 0', () => {
    expect(strictToolArgsEnabled()).toBe(true);
    process.env.INK_STRICT_TOOL_ARGS = '0';
    expect(strictToolArgsEnabled()).toBe(false);
    process.env.INK_STRICT_TOOL_ARGS = '1';
    expect(strictToolArgsEnabled()).toBe(true);
  });
});

/**
 * The regression that motivated all of this, exercised through a real McpServer
 * so the SDK's own validateToolInput runs. A stub composer is enough: strict
 * validation rejects before the handler is reached, which is the property under
 * test — the reminder must never be created at all.
 */
describe('create_reminder rejects the parameter Myra actually guessed', () => {
  async function connectedClient() {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const stub: any = new Proxy(function () {} as any, {
      get: () => stub,
      apply: () => stub,
      construct: () => stub,
    });
    registerAllTools(server as any, stub);

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, server };
  }

  it('names remindAt as unrecognized instead of silently scheduling for now+1min', async () => {
    const { client } = await connectedClient();

    // The SDK surfaces a validation failure as an isError tool result rather
    // than a transport rejection, which is what makes this usable: the message
    // lands in the model's context where it can act on it.
    const result: any = await client.callTool({
      name: 'create_reminder',
      arguments: { title: 'Call mom', remindAt: '2026-08-19T09:00:00Z' },
    });

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('remindAt');
    expect(text).toMatch(/[Uu]nrecognized key/);
  });

  it('still accepts the documented runAt parameter', async () => {
    const { client } = await connectedClient();

    // Reaches the handler (which then fails on the stubbed data layer). The
    // point is that validation let it through — contrast with remindAt above,
    // which never gets that far.
    const result: any = await client
      .callTool({
        name: 'create_reminder',
        arguments: { title: 'Call mom', runAt: '2026-08-19T09:00:00Z' },
      })
      .catch((error: Error) => ({ threw: error.message }));

    expect(JSON.stringify(result)).not.toContain('runAt');
    expect(JSON.stringify(result)).not.toMatch(/[Uu]nrecognized/);
  });
});
