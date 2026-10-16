/**
 * The space-turn allowlist at the one dispatch seam every tool passes through
 * (ink://specs/inkling-multi-person-groups, "Enforcement is in code").
 *
 * The sweep walks the real registry that registerAllTools builds, so a tool
 * added later is covered without editing this file. "Reached" is observed at
 * runInToolCall, which wraps every handler: a refused call never gets there,
 * whatever the tool's body would have done. The stand-in never runs a body,
 * so no handler touches a store here.
 *
 * The thread lookup is stubbed here so this file judges the wrapper alone;
 * the real lookup, through the handlers' own functions, is exercised in
 * space-turn-thread-binding.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const reached = vi.hoisted(() => [] as string[]);
vi.mock('../../utils/tool-call-context', () => ({
  runInToolCall: (toolName: string) => {
    reached.push(toolName);
    return { content: [{ type: 'text', text: '{"success":true}' }] };
  },
  currentToolName: () => undefined,
}));
// The token's own thread, found where the handler would find it.
const resolveThread = vi.hoisted(() =>
  vi.fn(async () => ({
    id: '00000000-0000-4000-8000-0000000000e1',
    workspaceId: '00000000-0000-4000-8000-0000000000d1',
  }))
);
vi.mock('./space-turn-thread-resolver', () => ({
  createSpaceTurnThreadResolver: () => resolveThread,
}));

import { registerAllTools } from './index';
import { runWithRequestContext, type RequestContextData } from '../../utils/request-context';

type Handler = (...args: unknown[]) => Promise<unknown>;

class FakeMcpServer {
  public handlers = new Map<string, Handler>();
  registerTool(name: string, ...rest: unknown[]): void {
    const handler = rest[rest.length - 1];
    if (typeof handler === 'function') this.handlers.set(name, handler as Handler);
  }
}

const KEY = 'inkling:thread:fixture-group';
const OTHER_KEY = 'inkling:thread:someone-else';
// Listed here rather than imported, so the sweep fails on its assertions, not
// on a missing export, against a tree without the allowlist.
const ALLOWED = ['get_thread_messages', 'send_response'];

const spaceTurnContext: Omit<RequestContextData, 'timestamp'> = {
  userId: '00000000-0000-4000-8000-0000000000a1',
  sbId: '00000000-0000-4000-8000-0000000000b1',
  tokenSbId: '00000000-0000-4000-8000-0000000000b1',
  tokenSessionId: '00000000-0000-4000-8000-0000000000c1',
  agentTokenBound: true,
  tokenScope: 'mcp:space-turn',
  tokenWorkspaceId: '00000000-0000-4000-8000-0000000000d1',
  tokenThreadId: '00000000-0000-4000-8000-0000000000e1',
  tokenThreadKey: KEY,
};

const broadContext: Omit<RequestContextData, 'timestamp'> = {
  userId: '00000000-0000-4000-8000-0000000000a1',
  sbId: '00000000-0000-4000-8000-0000000000b1',
  tokenSbId: '00000000-0000-4000-8000-0000000000b1',
  agentTokenBound: true,
  tokenScope: 'mcp:tools',
};

function registry(includeInternalLifecycleTools: boolean): FakeMcpServer {
  const server = new FakeMcpServer();
  registerAllTools(server as never, { getClient: () => ({}) } as never, {
    includeInternalLifecycleTools,
  });
  return server;
}

async function call(
  server: FakeMcpServer,
  tool: string,
  args: unknown,
  context: Omit<RequestContextData, 'timestamp'>
): Promise<unknown> {
  const handler = server.handlers.get(tool);
  if (!handler) throw new Error(`${tool} is not registered`);
  return runWithRequestContext(context, () => handler(args, {}));
}

function refusalCode(result: unknown): string | undefined {
  const r = result as { isError?: boolean; content?: Array<{ text?: string }> };
  if (!r?.isError || !r.content?.[0]?.text) return undefined;
  return (JSON.parse(r.content[0].text) as { code?: string }).code;
}

beforeEach(() => {
  reached.length = 0;
});

describe.each([false, true])(
  'a space-turn token at the dispatch seam (internal lifecycle tools: %s)',
  (includeInternalLifecycleTools) => {
    it('refuses every registered tool except the two, before its handler', async () => {
      const server = registry(includeInternalLifecycleTools);
      const names = [...server.handlers.keys()];
      // The sweep is over the real registry, not a stub of three tools.
      expect(names.length).toBeGreaterThan(100);
      for (const tool of ALLOWED) expect(names).toContain(tool);

      const leaked: string[] = [];
      for (const tool of names.filter((name) => !ALLOWED.includes(name))) {
        const result = await call(server, tool, { threadKey: KEY }, spaceTurnContext);
        if (refusalCode(result) !== 'space_turn_tool_not_allowed') leaked.push(tool);
      }
      expect(leaked).toEqual([]);
      expect(reached).toEqual([]);
    });
  }
);

describe('a space-turn token reaches its own thread and nothing else', () => {
  it('lets get_thread_messages and send_response address the token’s thread', async () => {
    const server = registry(true);
    await call(server, 'get_thread_messages', { threadKey: KEY }, spaceTurnContext);
    await call(
      server,
      'send_response',
      { channel: 'inkling', conversationId: KEY, content: 'hello' },
      spaceTurnContext
    );
    expect(reached).toEqual(['get_thread_messages', 'send_response']);
  });

  it('refuses either tool for another thread, no thread, or another channel', async () => {
    const server = registry(true);
    const cases: Array<[string, unknown]> = [
      ['get_thread_messages', { threadKey: OTHER_KEY }],
      ['get_thread_messages', {}],
      ['send_response', { channel: 'inkling', conversationId: OTHER_KEY, content: 'hello' }],
      ['send_response', { channel: 'inkling', content: 'hello' }],
      ['send_response', { channel: 'telegram', conversationId: KEY, content: 'hello' }],
    ];
    for (const [tool, args] of cases) {
      const result = await call(server, tool, args, spaceTurnContext);
      expect(refusalCode(result), `${tool} ${JSON.stringify(args)}`).toBe(
        'space_turn_thread_mismatch'
      );
    }
    expect(reached).toEqual([]);
  });

  it('refuses a tool registered after registerAllTools, under a name the policy never saw', async () => {
    // Mini-app tools register on the same server afterwards, through the same
    // interceptor (createMcpServerInstance). A late name is refused like any other.
    const server = registry(true);
    (server as unknown as { registerTool: (...a: unknown[]) => void }).registerTool(
      'fixture_late_tool',
      { description: 'late', inputSchema: z.object({}) },
      async () => ({ content: [] })
    );
    const result = await call(server, 'fixture_late_tool', {}, spaceTurnContext);
    expect(refusalCode(result)).toBe('space_turn_tool_not_allowed');
    expect(reached).toEqual([]);
  });

  it('ignores a scope or thread named in the call’s arguments', async () => {
    const server = registry(true);
    const result = await call(
      server,
      'recall',
      { query: 'x', tokenScope: 'mcp:tools', scope: 'mcp:tools', tokenThreadKey: OTHER_KEY },
      spaceTurnContext
    );
    expect(refusalCode(result)).toBe('space_turn_tool_not_allowed');
    expect(reached).toEqual([]);
  });
});

describe('ordinary tokens are unchanged', () => {
  it('lets an mcp:tools token reach a sample of tools, any thread', async () => {
    const server = registry(true);
    const sample: Array<[string, unknown]> = [
      ['recall', { query: 'fixture' }],
      ['send_to_inbox', { recipientSlug: 'fixture-sb', content: 'hello' }],
      ['bootstrap', {}],
      ['get_thread_messages', { threadKey: OTHER_KEY }],
      ['send_response', { channel: 'telegram', conversationId: '100200300', content: 'hello' }],
    ];
    for (const [tool, args] of sample) {
      const result = await call(server, tool, args, broadContext);
      expect(refusalCode(result), tool).toBeUndefined();
    }
    expect(reached).toEqual(sample.map(([tool]) => tool));
  });

  it('lets a request with no token reach a tool', async () => {
    const server = registry(true);
    await call(server, 'recall', { query: 'fixture' }, {});
    expect(reached).toEqual(['recall']);
  });

  it('gives a broad token claiming the narrow scope in its arguments nothing new to refuse', async () => {
    const server = registry(true);
    const result = await call(
      server,
      'recall',
      { query: 'x', tokenScope: 'mcp:space-turn', scope: 'mcp:space-turn' },
      broadContext
    );
    expect(refusalCode(result)).toBeUndefined();
    expect(reached).toEqual(['recall']);
  });
});
