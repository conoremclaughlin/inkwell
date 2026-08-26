/**
 * Handler-level wiring for the unregistered-project-prefix warning.
 *
 * The detector's own tests prove the rule; they say nothing about whether
 * send_to_inbox actually consults it, only warns on thread creation, or stays
 * out of the way when the registry cannot be read. Those are the three
 * properties that decide whether this feature exists in production at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/user-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/user-resolver')>();
  return {
    ...actual,
    resolveUserOrThrow: vi.fn().mockResolvedValue({
      user: { id: '11111111-1111-1111-1111-111111111111' },
      resolvedBy: 'userId',
    }),
  };
});

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/request-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/request-context')>();
  return {
    ...actual,
    getRequestContext: vi.fn().mockReturnValue({ sessionId: 'session-mock-123' }),
    getSessionContext: vi.fn().mockReturnValue(undefined),
    getPinnedAgentId: vi.fn().mockReturnValue(undefined),
  };
});

vi.mock('../../auth/resolve-identity', () => ({
  resolveIdentityId: vi.fn().mockResolvedValue('identity-123'),
  resolveAgentSlug: vi.fn().mockImplementation(async (_s: unknown, _u: unknown, id: string) => id),
}));

// findThread decides new-vs-existing, which is exactly the branch under test.
const findThread = vi.fn();
vi.mock('./thread-handlers.js', () => ({
  findThread: (...args: unknown[]) => findThread(...args),
  getParticipants: vi.fn().mockResolvedValue([]),
  resolveTriggeredAgents: vi.fn().mockReturnValue([]),
  handleGetThreadMessages: vi.fn(),
}));

// The registry lives behind ThreadKeyService; controlling it here keeps these
// tests about the handler rather than about Supabase chaining.
const projectSlugLookup = vi.fn();
const knownTypeNames = vi.fn();
vi.mock('../../services/thread-key/thread-key.service', () => ({
  ThreadKeyService: class {
    projectSlugLookup = projectSlugLookup;
    knownTypeNames = knownTypeNames;
  },
}));

vi.mock('../../services/sessions/index.js', () => ({
  resolveStudioHint: vi.fn().mockResolvedValue(null),
}));

vi.mock('./read-state.js', () => ({
  advanceThreadReadPointer: vi.fn().mockResolvedValue(undefined),
  advanceAgentInboxReadPointer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./sender-context.js', () => ({
  senderRoutingContext: vi.fn().mockReturnValue({}),
  isBridgeIdentity: vi.fn().mockReturnValue(false),
  senderSbId: vi.fn().mockReturnValue(undefined),
}));

import { handleSendToInbox } from './inbox-handlers';

function mockSupabase() {
  const thread = { id: 'thread-1', thread_key: 'x' };
  const message = { id: 'msg-1', created_at: '2026-08-26T00:00:00Z' };

  const chain = () => {
    const c: Record<string, unknown> = {};
    c.select = vi.fn().mockReturnValue(c);
    c.eq = vi.fn().mockReturnValue(c);
    c.in = vi.fn().mockReturnValue(c);
    c.order = vi.fn().mockReturnValue(c);
    c.limit = vi.fn().mockReturnValue(c);
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    c.single = vi.fn().mockResolvedValue({ data: thread, error: null });
    c.insert = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: thread, error: null }),
      }),
      then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r),
    });
    c.update = vi.fn().mockReturnValue(c);
    c.upsert = vi.fn().mockResolvedValue({ data: null, error: null });
    return c;
  };

  const messageChain = chain();
  messageChain.insert = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({ data: message, error: null }),
    }),
  });

  return {
    from: vi
      .fn()
      .mockImplementation((table: string) =>
        table === 'inbox_thread_messages' ? messageChain : chain()
      ),
  };
}

function composer() {
  const sb = mockSupabase();
  return { getClient: vi.fn().mockReturnValue(sb), repositories: {} };
}

async function send(threadKey: string) {
  const result = await handleSendToInbox(
    {
      userId: '11111111-1111-1111-1111-111111111111',
      recipientAgentId: 'lumen',
      senderAgentId: 'wren',
      threadKey,
      content: 'hello',
      trigger: false,
    },
    composer() as never
  );
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe('send_to_inbox — unregistered project prefix warning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectSlugLookup.mockResolvedValue(new Map([['inkwell', 'inkwell']]));
    knownTypeNames.mockResolvedValue(new Set(['pr', 'issue', 'spec', 'thread']));
    findThread.mockResolvedValue(null); // new thread by default
  });

  it('warns when a new thread pins an unregistered prefix as its type', async () => {
    const parsed = await send('cnr:issue:7');

    expect(parsed.threadKeyWarning).toBeTruthy();
    expect(parsed.threadKeyWarning).toContain('cnr');
    expect(parsed.threadKeyWarning).toContain('is pinned as');
  });

  it('stays silent for a registered project', async () => {
    const parsed = await send('inkwell:pr:530');
    expect(parsed.threadKeyWarning).toBeUndefined();
  });

  it('stays silent for an ordinary typed key', async () => {
    const parsed = await send('pr:530');
    expect(parsed.threadKeyWarning).toBeUndefined();
  });

  it('says nothing on an existing thread, whose identity is already settled', async () => {
    // Re-warning on every reply would be noise, and there is nothing the
    // recipient could do about a pin made when the thread was created.
    findThread.mockResolvedValue({ id: 'thread-1', status: 'open' });

    const parsed = await send('cnr:issue:7');

    expect(parsed.threadKeyWarning).toBeUndefined();
    expect(projectSlugLookup).not.toHaveBeenCalled();
  });

  it('fails open when the registry cannot be read', async () => {
    // A lookup failure must not cost someone their message. The send proceeds;
    // only the advisory is lost.
    projectSlugLookup.mockRejectedValue(new Error('registry unavailable'));

    const parsed = await send('cnr:issue:7');

    // The send completed and the message was stored — only the advisory is
    // lost. (`success` here also reflects trigger routing, which this mock
    // does not provide, so the message id is the honest signal.)
    expect(parsed.messageId).toBe('msg-1');
    expect(parsed.threadKeyWarning).toBeUndefined();
  });
});
