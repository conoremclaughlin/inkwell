/**
 * Approval Interceptor Tests
 *
 * Security-critical: `checkApprovalResponse` is the only path that writes
 * permission grants. It must correctly parse approval replies, match them
 * to pending requests, respect the optimistic lock, and fall through to
 * normal routing when no match applies.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-secret',
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
  },
}));

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

interface MockRequestRow {
  id: string;
  tool: string;
  args: string | null;
  expires_at: string;
  metadata: Record<string, unknown> | null;
}

interface SupabaseMockState {
  pendingSelectResult: { data: MockRequestRow[] | null; error: unknown };
  updateResult: { data: unknown; error: unknown };
  updateEqChain: Array<{ column: string; value: unknown }>;
  updateCalledWith: Record<string, unknown> | null;
  trustedUsersResult: { data: Array<{ platform: string; platform_user_id: string }> | null };
  selectCalls: number;
}

function createSupabaseMock(state: SupabaseMockState) {
  const fromFn = vi.fn().mockImplementation((table: string) => {
    if (table === 'approval_requests') {
      return {
        select: vi.fn().mockImplementation(() => {
          state.selectCalls += 1;
          return {
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                gt: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue(state.pendingSelectResult),
                  }),
                }),
              }),
            }),
          };
        }),
        update: vi.fn().mockImplementation((updates: Record<string, unknown>) => {
          state.updateCalledWith = updates;
          return {
            eq: vi.fn().mockImplementation((col: string, val: unknown) => {
              state.updateEqChain.push({ column: col, value: val });
              return {
                eq: vi.fn().mockImplementation((col2: string, val2: unknown) => {
                  state.updateEqChain.push({ column: col2, value: val2 });
                  return Promise.resolve(state.updateResult);
                }),
              };
            }),
          };
        }),
      };
    }
    if (table === 'trusted_users') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue(state.trustedUsersResult),
          }),
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  return { from: fromFn };
}

function makeState(overrides: Partial<SupabaseMockState> = {}): SupabaseMockState {
  return {
    pendingSelectResult: { data: [], error: null },
    updateResult: { data: null, error: null },
    updateEqChain: [],
    updateCalledWith: null,
    trustedUsersResult: { data: [] },
    selectCalls: 0,
    ...overrides,
  };
}

// Create a single supabase mock that the test can mutate via `state`.
// `createClient` is called once per invocation inside the handler, so we
// return the same mock each call and inspect the shared state.
let currentState: SupabaseMockState;

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => createSupabaseMock(currentState)),
}));

// Import after mocks are set up
import { checkApprovalResponse, notifyPlatformOfApprovalRequest } from './approval-interceptor';

const USER_ID = 'user-123';
const PLATFORM_ID = 'telegram:chat-999';

function futureIso(minutes = 5): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

beforeEach(() => {
  currentState = makeState();
  vi.clearAllMocks();
});

// ============================================================================
// Pattern parsing — every supported approval phrase must map to the right action
// ============================================================================

describe('checkApprovalResponse: pattern parsing', () => {
  const pending: MockRequestRow = {
    id: 'req-1',
    tool: 'Bash',
    args: 'docker push registry/app',
    expires_at: futureIso(),
    metadata: null,
  };

  beforeEach(() => {
    currentState = makeState({ pendingSelectResult: { data: [pending], error: null } });
  });

  it.each([
    ['approve', 'grant'],
    ['Approve', 'grant'],
    ['APPROVE', 'grant'],
    ['yes', 'grant'],
    ['y', 'grant'],
    ['approve session', 'grant-session'],
    ['approve for session', 'grant-session'],
    ['approve always', 'allow'],
  ])('resolves "%s" as %s', async (text, expectedAction) => {
    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, text);
    expect(result.intercepted).toBe(true);
    expect(result.action).toBe(expectedAction);
    expect(result.requestId).toBe('req-1');
    expect(currentState.updateCalledWith).toMatchObject({
      action: expectedAction,
      status: 'granted',
    });
  });

  it.each([['deny'], ['Deny'], ['no'], ['N']])('resolves "%s" as deny', async (text) => {
    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, text);
    expect(result.intercepted).toBe(true);
    expect(result.action).toBe('deny');
    expect(currentState.updateCalledWith).toMatchObject({
      action: 'deny',
      status: 'denied',
      granted_tools: null,
    });
  });

  it('trims whitespace before pattern matching', async () => {
    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, '  approve  ');
    expect(result.intercepted).toBe(true);
  });

  it('does not match free-form replies that contain approval words', async () => {
    // "yes, please do that" — contains "yes" but shouldn't match
    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, 'yes, please do that');
    expect(result.intercepted).toBe(false);
    // Should not have even queried for pending requests — quick return
    expect(currentState.selectCalls).toBe(0);
  });

  it('does not match unrelated text', async () => {
    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, 'hey lumen, status?');
    expect(result.intercepted).toBe(false);
    expect(currentState.selectCalls).toBe(0);
  });
});

// ============================================================================
// Matching — reply-to threading wins; falls back to most-recent
// ============================================================================

describe('checkApprovalResponse: request matching', () => {
  it('returns intercepted=false when no pending requests exist', async () => {
    currentState = makeState({ pendingSelectResult: { data: [], error: null } });
    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve');
    expect(result.intercepted).toBe(false);
    expect(currentState.updateCalledWith).toBeNull();
  });

  it('returns intercepted=false when the pending select errors', async () => {
    currentState = makeState({
      pendingSelectResult: { data: null, error: { message: 'db down' } },
    });
    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve');
    expect(result.intercepted).toBe(false);
  });

  it('matches by metadata.telegramMessageId when replyToMessageId is provided', async () => {
    const older: MockRequestRow = {
      id: 'req-older',
      tool: 'Bash',
      args: 'rm -rf /',
      expires_at: futureIso(),
      metadata: { telegramMessageId: 100 },
    };
    const newer: MockRequestRow = {
      id: 'req-newer',
      tool: 'Bash',
      args: 'docker push',
      expires_at: futureIso(),
      metadata: { telegramMessageId: 200 },
    };
    // pendingRequests are returned in descending created_at order (newer first)
    currentState = makeState({ pendingSelectResult: { data: [newer, older], error: null } });

    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve', '100');
    expect(result.intercepted).toBe(true);
    // Should target the older request (the one the reply actually threads to)
    expect(result.requestId).toBe('req-older');
    expect(currentState.updateEqChain.find((c) => c.column === 'id')?.value).toBe('req-older');
  });

  it('falls back to most-recent when replyToMessageId does not match any pending metadata', async () => {
    const first: MockRequestRow = {
      id: 'req-first',
      tool: 'Bash',
      args: 'one',
      expires_at: futureIso(),
      metadata: { telegramMessageId: 111 },
    };
    const second: MockRequestRow = {
      id: 'req-second',
      tool: 'Bash',
      args: 'two',
      expires_at: futureIso(),
      metadata: { telegramMessageId: 222 },
    };
    // Most-recent first (matches the order by created_at DESC in prod)
    currentState = makeState({ pendingSelectResult: { data: [second, first], error: null } });

    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve', '999');
    expect(result.intercepted).toBe(true);
    expect(result.requestId).toBe('req-second');
  });

  it('uses most-recent pending when no replyToMessageId is given', async () => {
    const pending: MockRequestRow[] = [
      { id: 'newest', tool: 'Bash', args: null, expires_at: futureIso(), metadata: null },
      { id: 'older', tool: 'Bash', args: null, expires_at: futureIso(), metadata: null },
    ];
    currentState = makeState({ pendingSelectResult: { data: pending, error: null } });

    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve');
    expect(result.requestId).toBe('newest');
  });
});

// ============================================================================
// Resolution — the fields we write on grant/deny, and the optimistic lock
// ============================================================================

describe('checkApprovalResponse: resolution', () => {
  const pending: MockRequestRow = {
    id: 'req-42',
    tool: 'Bash',
    args: 'docker push',
    expires_at: futureIso(),
    metadata: null,
  };

  beforeEach(() => {
    currentState = makeState({ pendingSelectResult: { data: [pending], error: null } });
  });

  it('writes granted_tools as `tool(args)` on grant', async () => {
    await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve');
    expect(currentState.updateCalledWith?.granted_tools).toEqual(['Bash(docker push)']);
  });

  it('writes granted_tools as `tool` alone when request has no args', async () => {
    currentState = makeState({
      pendingSelectResult: {
        data: [{ ...pending, args: null }],
        error: null,
      },
    });
    await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve');
    expect(currentState.updateCalledWith?.granted_tools).toEqual(['Bash']);
  });

  it('writes null granted_tools on deny', async () => {
    await checkApprovalResponse(USER_ID, PLATFORM_ID, 'deny');
    expect(currentState.updateCalledWith?.granted_tools).toBeNull();
    expect(currentState.updateCalledWith?.status).toBe('denied');
  });

  it('sets granted_by to platform:<platformId>', async () => {
    await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve');
    expect(currentState.updateCalledWith?.granted_by).toBe(`platform:${PLATFORM_ID}`);
  });

  it('sets resolved_at to a recent ISO timestamp', async () => {
    const before = Date.now();
    await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve');
    const resolvedAt = currentState.updateCalledWith?.resolved_at as string;
    expect(typeof resolvedAt).toBe('string');
    const ts = new Date(resolvedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it('applies optimistic lock: .eq(id, …).eq(status, pending)', async () => {
    await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve');
    // Two .eq() calls in the update chain: id then status
    expect(currentState.updateEqChain).toEqual([
      { column: 'id', value: 'req-42' },
      { column: 'status', value: 'pending' },
    ]);
  });

  it('returns intercepted=false when the update fails (race/lock lost)', async () => {
    currentState = makeState({
      pendingSelectResult: { data: [pending], error: null },
      updateResult: { data: null, error: { message: 'row already resolved' } },
    });
    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve');
    expect(result.intercepted).toBe(false);
    expect(result.requestId).toBeUndefined();
  });
});

// ============================================================================
// notifyPlatformOfApprovalRequest — Telegram send + metadata write-back
// ============================================================================

describe('notifyPlatformOfApprovalRequest', () => {
  const baseRequest = {
    id: 'req-notify',
    userId: USER_ID,
    tool: 'Bash',
    args: 'docker push',
    reason: 'deploying to prod',
    requestingAgentId: 'wren',
    studioId: 'studio-1',
    sessionId: 'session-1',
    expiresAt: futureIso(),
  };

  it('returns early and logs warning when user has no connected platforms', async () => {
    currentState = makeState({ trustedUsersResult: { data: [] } });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await notifyPlatformOfApprovalRequest(baseRequest);

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('sends Telegram message and stores telegramMessageId in metadata on success', async () => {
    currentState = makeState({
      trustedUsersResult: {
        data: [{ platform: 'telegram', platform_user_id: 'chat-999' }],
      },
    });
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { message_id: 5555 } }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await notifyPlatformOfApprovalRequest(baseRequest);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bottest-bot-token/sendMessage');
    const body = JSON.parse((options as { body: string }).body);
    expect(body.chat_id).toBe('chat-999');
    expect(body.parse_mode).toBe('Markdown');
    expect(body.text).toContain('Permission request');
    expect(body.text).toContain('Bash(docker push)');
    expect(body.text).toContain('deploying to prod');
    expect(body.text).toContain('studio-1');

    // metadata write-back happened
    expect(currentState.updateCalledWith?.metadata).toMatchObject({
      telegramMessageId: 5555,
      platform: 'telegram',
      chatId: 'chat-999',
    });

    vi.unstubAllGlobals();
  });

  it('does not write metadata when Telegram send fails (non-OK response)', async () => {
    currentState = makeState({
      trustedUsersResult: {
        data: [{ platform: 'telegram', platform_user_id: 'chat-999' }],
      },
    });
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await notifyPlatformOfApprovalRequest(baseRequest);
    expect(currentState.updateCalledWith).toBeNull();

    vi.unstubAllGlobals();
  });

  it('does not write metadata when Telegram response omits message_id', async () => {
    currentState = makeState({
      trustedUsersResult: {
        data: [{ platform: 'telegram', platform_user_id: 'chat-999' }],
      },
    });
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: {} }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await notifyPlatformOfApprovalRequest(baseRequest);
    expect(currentState.updateCalledWith).toBeNull();

    vi.unstubAllGlobals();
  });

  it('swallows thrown errors from fetch and does not propagate', async () => {
    currentState = makeState({
      trustedUsersResult: {
        data: [{ platform: 'telegram', platform_user_id: 'chat-999' }],
      },
    });
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(notifyPlatformOfApprovalRequest(baseRequest)).resolves.toBeUndefined();

    vi.unstubAllGlobals();
  });
});
