/**
 * The space-turn thread binding through the real lookups
 * (ink://specs/inkling-multi-person-groups, Phase 2 gate 3).
 *
 * The wrapper, the policy and the resolver are real, and the resolver runs
 * the handlers' own functions (resolveCallerSb, findThread, the inkling
 * conversation lookup) against an in-memory FakePostgrest that evaluates
 * its filters. Only the two handler bodies are spies, so the test can see
 * whether each was reached and with what arguments.
 *
 * The scenario: the token's SB lives in W2, and the same thread key exists
 * in W1 and in W2. A token claiming W1's thread names the right key but
 * would have the handler act on W2's thread, so it is refused. A token
 * claiming W2's thread is admitted, and send_response is handed W2's
 * thread id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakePostgrest } from '../../test/fake-postgrest';
import { INKLING_CONVERSATION_MARK } from '../../services/inklings/inkling-thread-gate';

const ME = '00000000-0000-4000-8000-0000000000a1';
const SB = '00000000-0000-4000-8000-0000000000b1';
const W1 = '00000000-0000-4000-8000-0000000000d1';
const W2 = '00000000-0000-4000-8000-0000000000d2';
const T1 = '00000000-0000-4000-8000-0000000000e1';
const T2 = '00000000-0000-4000-8000-0000000000e2';
const KEY = 'inkling:thread:fixture-group';
const SLUG = 'fixture-inkling';
const OTHER_SB = '00000000-0000-4000-8000-0000000000b2';
const OTHER_SLUG = 'fixture-other';

vi.mock('../../config/env', async () => ({
  env: { ...(await import('../../test/fake-env')).fakeEnv },
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/user-resolver', async (original) => ({
  ...(await original<typeof import('../../services/user-resolver')>()),
  resolveUserOrThrow: vi.fn(async () => ({ user: { id: ME }, resolvedBy: 'userId' })),
}));
const handlers = vi.hoisted(() => ({
  getThreadMessages: vi.fn(async (_args: unknown) => ({ content: [{ type: 'text', text: '{}' }] })),
  sendResponse: vi.fn(async (_args: unknown) => ({ content: [{ type: 'text', text: '{}' }] })),
}));
vi.mock('./thread-handlers', async (original) => ({
  ...(await original<typeof import('./thread-handlers')>()),
  handleGetThreadMessages: handlers.getThreadMessages,
}));
vi.mock('./response-handlers', async (original) => ({
  ...(await original<typeof import('./response-handlers')>()),
  handleSendResponse: handlers.sendResponse,
}));

import { registerAllTools } from './index';
import { threadTool } from './thread-handlers';
import { SPACE_TURN_READ_FIELDS } from './space-turn-policy';
import { userIdentifierFields } from '../../services/user-resolver';
import { env } from '../../config/env';
import { runWithRequestContext, type RequestContextData } from '../../utils/request-context';

type Handler = (...args: unknown[]) => Promise<unknown>;
class FakeMcpServer {
  public handlers = new Map<string, Handler>();
  registerTool(name: string, ...rest: unknown[]): void {
    const handler = rest[rest.length - 1];
    if (typeof handler === 'function') this.handlers.set(name, handler as Handler);
  }
}

let db: FakePostgrest;
let server: FakeMcpServer;

function thread(id: string, workspaceId: string) {
  return {
    id,
    thread_key: KEY,
    workspace_id: workspaceId,
    metadata: { [INKLING_CONVERSATION_MARK]: true },
  };
}

beforeEach(() => {
  handlers.getThreadMessages.mockClear();
  handlers.sendResponse.mockClear();
  db = new FakePostgrest();
  db.seed('workspace_members', { workspace_id: W1, user_id: ME, role: 'owner' });
  db.seed('workspace_members', { workspace_id: W2, user_id: ME, role: 'owner' });
  // The token's SB lives in W2.
  db.seed('agent_identities', { id: SB, agent_id: SLUG, user_id: ME, workspace_id: W2 });
  db.seed('inbox_threads', thread(T1, W1));
  db.seed('inbox_threads', thread(T2, W2));
  server = new FakeMcpServer();
  registerAllTools(server as never, { getClient: () => db, repositories: {} } as never, {
    includeInternalLifecycleTools: true,
  });
});

function spaceTurn(threadId: string, workspaceId: string): Omit<RequestContextData, 'timestamp'> {
  return {
    userId: ME,
    sbId: SB,
    sbSlug: SLUG,
    tokenSlug: SLUG,
    tokenSbId: SB,
    tokenSessionId: '00000000-0000-4000-8000-0000000000c1',
    agentTokenBound: true,
    tokenScope: 'mcp:space-turn',
    tokenThreadKey: KEY,
    tokenThreadId: threadId,
    tokenWorkspaceId: workspaceId,
  };
}

async function call(tool: string, args: unknown, context: Omit<RequestContextData, 'timestamp'>) {
  const handler = server.handlers.get(tool)!;
  return runWithRequestContext(context, () => handler(args, {}));
}

function refusalCode(result: unknown): string | undefined {
  const r = result as { isError?: boolean; content?: Array<{ text?: string }> };
  return r?.isError ? (JSON.parse(r.content![0].text!) as { code?: string }).code : undefined;
}

const read = { threadKey: KEY };
const reply = { channel: 'inkling', conversationId: KEY, content: 'hello' };

describe('a token claiming one workspace for an SB that lives in another', () => {
  it('refuses get_thread_messages for the same key, before the handler', async () => {
    const result = await call('get_thread_messages', read, spaceTurn(T1, W1));
    expect(refusalCode(result)).toBe('space_turn_thread_mismatch');
    expect(handlers.getThreadMessages).not.toHaveBeenCalled();
  });

  it('refuses send_response for the same key, before the handler', async () => {
    const result = await call('send_response', reply, spaceTurn(T1, W1));
    expect(refusalCode(result)).toBe('space_turn_thread_mismatch');
    expect(handlers.sendResponse).not.toHaveBeenCalled();
  });
});

describe('a token whose thread is where its SB lives', () => {
  it('reaches get_thread_messages with the call as given', async () => {
    const result = await call('get_thread_messages', read, spaceTurn(T2, W2));
    expect(refusalCode(result)).toBeUndefined();
    expect(handlers.getThreadMessages).toHaveBeenCalledWith(read, expect.anything());
  });

  it('hands send_response the resolved thread id, not the key', async () => {
    const result = await call('send_response', reply, spaceTurn(T2, W2));
    expect(refusalCode(result)).toBeUndefined();
    expect(handlers.sendResponse).toHaveBeenCalledWith(
      { ...reply, conversationId: T2 },
      expect.anything()
    );
  });
});

describe('a thread that cannot be resolved cleanly', () => {
  it('refuses an ambiguous key in the SB’s workspace', async () => {
    db.seed('inbox_threads', thread('00000000-0000-4000-8000-0000000000e3', W2));
    for (const [tool, args] of [
      ['get_thread_messages', read],
      ['send_response', reply],
    ] as const) {
      expect(refusalCode(await call(tool, args, spaceTurn(T2, W2)))).toBe(
        'space_turn_thread_unresolved'
      );
    }
    expect(handlers.getThreadMessages).not.toHaveBeenCalled();
    expect(handlers.sendResponse).not.toHaveBeenCalled();
  });

  it('refuses a key with no thread in the SB’s workspace', async () => {
    db.tables.inbox_threads = db.tables.inbox_threads.filter((row) => row.workspace_id !== W2);
    expect(refusalCode(await call('get_thread_messages', read, spaceTurn(T2, W2)))).toBe(
      'space_turn_thread_unresolved'
    );
    expect(handlers.getThreadMessages).not.toHaveBeenCalled();
  });
});

// With identity pinning off, the handler's own lookup reads an explicit
// sbSlug as given, so another SB in the same workspace resolves the same
// thread and the id/workspace check passes. The policy refuses the slug
// before any lookup, whatever the flag says.
describe('reading as another SB in the same workspace, with identity pinning off', () => {
  let savedPinning: unknown;

  beforeEach(() => {
    db.seed('agent_identities', {
      id: OTHER_SB,
      agent_id: OTHER_SLUG,
      user_id: ME,
      workspace_id: W2,
    });
    savedPinning = (env as Record<string, unknown>).ENFORCE_IDENTITY_PINNING;
    (env as Record<string, unknown>).ENFORCE_IDENTITY_PINNING = 'false';
  });

  afterEach(() => {
    (env as Record<string, unknown>).ENFORCE_IDENTITY_PINNING = savedPinning;
  });

  it('refuses an explicit foreign sbSlug, before the handler', async () => {
    const result = await call(
      'get_thread_messages',
      { ...read, sbSlug: OTHER_SLUG },
      spaceTurn(T2, W2)
    );
    expect(refusalCode(result)).toBe('space_turn_field_not_allowed');
    expect(handlers.getThreadMessages).not.toHaveBeenCalled();
  });

  it('lets the token’s own sbSlug through (control)', async () => {
    const result = await call('get_thread_messages', { ...read, sbSlug: SLUG }, spaceTurn(T2, W2));
    expect(refusalCode(result)).toBeUndefined();
    expect(handlers.getThreadMessages).toHaveBeenCalledWith(
      { ...read, sbSlug: SLUG },
      expect.anything()
    );
  });
});

describe('the read pin covers the whole get_thread_messages schema', () => {
  it('sorts every schema field into a read option or an identity field', () => {
    const schema = threadTool('get_thread_messages').schema as unknown as {
      shape: Record<string, unknown>;
    };
    const identity = Object.keys(userIdentifierFields);
    expect([...SPACE_TURN_READ_FIELDS, ...identity].sort()).toEqual(
      Object.keys(schema.shape).sort()
    );
    expect(SPACE_TURN_READ_FIELDS.filter((field) => identity.includes(field))).toEqual([]);
  });
});
