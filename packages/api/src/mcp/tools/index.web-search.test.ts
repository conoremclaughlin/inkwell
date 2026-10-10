import { McpServer, InMemoryTransport, type ServerContext } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { recordSearchBatch } from '../../services/web-search/batch-audit';
import { SearchCoordinator } from '../../services/web-search/coordinator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { DataComposer } from '../../data/composer';

const handler = vi.hoisted(() => vi.fn());
const mocks = vi.hoisted(() => ({ allowed: vi.fn(), audit: vi.fn(), search: vi.fn() }));
vi.mock('../../services/audit', () => ({ getAuditService: () => ({ log: mocks.audit }) }));
vi.mock('../../services/permissions', () => ({
  getPermissionsService: () => ({ isEnabled: mocks.allowed }),
}));
vi.mock('./web-search', async (original) => ({
  ...(await original<typeof import('./web-search')>()),
  handleWebSearch: handler,
}));
import { registerAllTools } from './index';
import { runWithRequestContext } from '../../utils/request-context';

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }> };
type Handler = (
  args: unknown,
  extra: { mcpReq: Pick<ServerContext['mcpReq'], 'signal'> }
) => Promise<Result>;
class FakeServer {
  entries = new Map<
    string,
    { config: { inputSchema: z.ZodRawShape | z.ZodObject<z.ZodRawShape> }; callback: Handler }
  >();
  registerTool(
    name: string,
    config: { inputSchema: z.ZodRawShape | z.ZodObject<z.ZodRawShape> },
    callback: Handler
  ) {
    this.entries.set(name, { config, callback });
  }
}
beforeEach(() => {
  vi.stubEnv('INK_WEB_SEARCH_ENABLED', 'true');
  vi.stubEnv('INK_WEB_SEARCH_ACCOUNT_IDS', '00000000-0000-4000-8000-000000000001');
  handler.mockReset();
  mocks.allowed.mockReset();
  mocks.audit.mockReset();
  mocks.search.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
describe('registered web_search path', () => {
  function setup() {
    const server = new FakeServer();
    const composer = {
      getClient: () => ({}),
      repositories: { users: { findById: async (id: string) => ({ id }) } },
    } as unknown as DataComposer;
    registerAllTools(server as unknown as McpServer, composer);
    const entry = server.entries.get('web_search');
    expect(entry).toBeDefined();
    return { ...entry!, composer };
  }

  it('forwards input, composer and the MCP cancellation signal to the shared handler', async () => {
    const { callback, composer, config } = setup();
    const schema =
      config.inputSchema instanceof z.ZodObject ? config.inputSchema : z.object(config.inputSchema);
    expect(schema.parse({ query: 'question' })).toMatchObject({ query: 'question', maxResults: 5 });
    expect(schema.parse({ queries: ['one', 'two'] })).toMatchObject({
      queries: ['one', 'two'],
      maxResults: 5,
    });
    expect(schema.safeParse({ query: 'one', queries: ['two'] }).success).toBe(false);
    const signal = new AbortController().signal;
    const result = { content: [{ type: 'text', text: 'test-result' }] };
    handler.mockResolvedValue(result);
    expect(await callback({ query: 'question' }, { mcpReq: { signal } })).toEqual(result);
    expect(handler).toHaveBeenCalledWith({ query: 'question' }, composer, { signal });
  });

  it('never exposes or transient-retries an uncaught search error', async () => {
    const { callback } = setup();
    handler.mockRejectedValue(new Error('connection reset private provider credential'));
    const result = await callback(
      { query: 'question' },
      { mcpReq: { signal: new AbortController().signal } }
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text!)).toEqual({
      success: false,
      reason: 'invalid-or-unauthorized-request',
    });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not treat a supplied account as authentication on an anonymous host', async () => {
    const real = await vi.importActual<typeof import('./web-search')>('./web-search');
    handler.mockImplementation((args, composer, deps) =>
      real.handleWebSearch(args, composer, { ...deps, coordinator: { submit: mocks.search } })
    );
    const { callback } = setup();
    const result = await callback(
      { userId: '00000000-0000-4000-8000-000000000001', query: 'inert query' },
      { mcpReq: { signal: new AbortController().signal } }
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text!)).toMatchObject({
      success: false,
      reason: 'auth-required',
      searchMayHaveRun: false,
    });
    expect(mocks.allowed).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('runs principal checks and required audit through the registered handler before the inert provider', async () => {
    const real = await vi.importActual<typeof import('./web-search')>('./web-search');
    handler.mockImplementation((args, composer, deps) =>
      real.handleWebSearch(args, composer, { ...deps, coordinator: { submit: mocks.search } })
    );
    mocks.allowed.mockResolvedValue(true);
    mocks.audit.mockResolvedValue(undefined);
    mocks.search.mockResolvedValue({
      provider: 'claude',
      model: 'test-model',
      batchId: 'synthetic-batch',
      items: [{ query: 'test', success: true, results: [] }],
      batchUsage: { modelToolCallCount: 1 },
    });
    const { callback } = setup();
    const userId = '00000000-0000-4000-8000-000000000001';
    const signal = new AbortController().signal;
    const call = (args: unknown) =>
      runWithRequestContext({ userId }, () => callback(args, { mcpReq: { signal } }));
    const success = await call({ query: 'test' });
    expect(JSON.parse(success.content[0].text!).success).toBe(true);
    expect(mocks.search).toHaveBeenCalledWith({
      accountId: userId,
      contentRecording: true,
      queries: ['test'],
      maxResults: 5,
      signal,
    });
    expect(mocks.audit).toHaveBeenCalledTimes(2);

    mocks.search.mockClear();
    mocks.audit.mockClear();
    const foreign = await call({ query: 'test', userId: '00000000-0000-4000-8000-000000000002' });
    expect(foreign.isError).toBe(true);
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();

    mocks.audit.mockRejectedValue(new Error('sensitive write failure'));
    const missingAudit = await call({ query: 'test' });
    expect(JSON.parse(missingAudit.content[0].text!).reason).toBe('audit-unavailable');
    expect(mocks.search).not.toHaveBeenCalled();
  });
});

describe('actual MCP SDK request dispatch (synthetic principal and inert provider)', () => {
  it('validates XOR inputs and batches registered tool calls behind per-caller required audits', async () => {
    const server = new McpServer({ name: 'search-boundary-test', version: '0.0.0' });
    const client = new Client({ name: 'search-test-client', version: '0.0.0' });
    const composer = {
      getClient: () => ({}),
      repositories: { users: { findById: async (id: string) => ({ id }) } },
    } as unknown as DataComposer;
    const real = await vi.importActual<typeof import('./web-search')>('./web-search');
    mocks.allowed.mockResolvedValue(true);
    mocks.audit.mockResolvedValue(undefined);
    mocks.search.mockImplementation(async ({ queries }) => ({
      provider: 'claude',
      model: 'test',
      items: queries.map((query: string) => ({ query, success: true, results: [] })),
      searchQueries: queries,
      modelToolCallCount: queries.length,
    }));
    const coordinator = new SearchCoordinator(mocks.search, recordSearchBatch);
    const userId = '00000000-0000-4000-8000-000000000001';
    // In-memory transport supplies no HTTP auth: bind an explicit synthetic
    // principal on the SERVER, not in tool arguments. This is not an auth E2E.
    handler.mockImplementation((args, composer, deps) =>
      runWithRequestContext({ userId }, () =>
        real.handleWebSearch(args, composer, { ...deps, coordinator })
      )
    );
    registerAllTools(server, composer);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const listed = await client.listTools();
      const tool = listed.tools.find((entry) => entry.name === 'web_search');
      expect(tool?.inputSchema.properties).toHaveProperty('queries');
      const invalid = await client.callTool({
        name: 'web_search',
        arguments: { query: 'one', queries: ['two'] },
      });
      expect(invalid.isError).toBe(true);
      expect(handler).not.toHaveBeenCalled();
      const results = await Promise.all([
        client.callTool({ name: 'web_search', arguments: { query: 'one' } }),
        client.callTool({ name: 'web_search', arguments: { queries: ['two', 'two'] } }),
      ]);
      for (const result of results) expect(result.isError).toBe(false);
      expect(mocks.search).toHaveBeenCalledOnce();
      expect(mocks.search.mock.calls[0][0].queries).toEqual(['one', 'two']);
      expect(mocks.audit).toHaveBeenCalledTimes(5);
      expect(
        mocks.audit.mock.calls.filter(([row]) => row.action === 'web_search_batch')
      ).toHaveLength(1);
      for (const [, options] of mocks.audit.mock.calls) expect(options).toEqual({ required: true });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
