import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
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

  it('runs principal checks and required audit through the registered handler before the inert provider', async () => {
    const real = await vi.importActual<typeof import('./web-search')>('./web-search');
    handler.mockImplementation((args, composer, deps) =>
      real.handleWebSearch(args, composer, { ...deps, search: mocks.search })
    );
    mocks.allowed.mockResolvedValue(true);
    mocks.audit.mockResolvedValue(undefined);
    mocks.search.mockResolvedValue({
      provider: 'claude',
      model: 'test-model',
      results: [],
      searchQueries: ['test'],
    });
    const { callback } = setup();
    const userId = '00000000-0000-4000-8000-000000000001';
    const signal = new AbortController().signal;
    const call = (args: unknown) =>
      runWithRequestContext({ userId }, () => callback(args, { mcpReq: { signal } }));
    const success = await call({ query: 'test' });
    expect(JSON.parse(success.content[0].text!).success).toBe(true);
    expect(mocks.search).toHaveBeenCalledWith({ query: 'test', maxResults: 5, signal });
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
