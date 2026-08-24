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
  requesting_agent_id: string;
  studio_id: string | null;
  session_id: string | null;
}

interface SupabaseMockState {
  pendingSelectResult: { data: MockRequestRow[] | null; error: unknown };
  updateResult: { data: unknown; error: unknown };
  updateEqChain: Array<{ column: string; value: unknown }>;
  updateCalledWith: Record<string, unknown> | null;
  /**
   * Every update, paired with the row it targeted.
   *
   * `updateCalledWith` keeps only the last one, so a batch write that put the
   * SAME payload on every row would pass a single-value assertion. Batches are
   * exactly where per-row correctness matters.
   */
  updates: Array<{ id: unknown; updates: Record<string, unknown> }>;
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
              if (col === 'id') state.updates.push({ id: val, updates });
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
    updates: [],
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
import {
  checkApprovalResponse,
  formatBatchNotification,
  formatSingleNotification,
  notifyPlatformOfApprovalRequest,
} from './approval-interceptor';

const USER_ID = 'user-123';
const PLATFORM_ID = 'telegram:chat-999';

function futureIso(minutes = 5): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function mockRow(
  overrides: Partial<MockRequestRow> & { id: string; tool: string }
): MockRequestRow {
  return {
    args: null,
    expires_at: futureIso(),
    metadata: null,
    requesting_agent_id: 'wren',
    studio_id: 'studio-1',
    session_id: 'session-1',
    ...overrides,
  };
}

beforeEach(() => {
  currentState = makeState();
  vi.clearAllMocks();
});

// ============================================================================
// Pattern parsing — every supported approval phrase must map to the right action
// ============================================================================

describe('checkApprovalResponse: pattern parsing', () => {
  const pending = mockRow({ id: 'req-1', tool: 'Bash', args: 'docker push registry/app' });

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
    const older = mockRow({
      id: 'req-older',
      tool: 'Bash',
      args: 'rm -rf /',
      metadata: { telegramMessageId: 100 },
    });
    const newer = mockRow({
      id: 'req-newer',
      tool: 'Bash',
      args: 'docker push',
      metadata: { telegramMessageId: 200 },
    });
    currentState = makeState({ pendingSelectResult: { data: [newer, older], error: null } });

    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve', '100');
    expect(result.intercepted).toBe(true);
    expect(result.requestId).toBe('req-older');
    expect(currentState.updateEqChain.find((c) => c.column === 'id')?.value).toBe('req-older');
  });

  it('falls back to most-recent when replyToMessageId does not match any pending metadata', async () => {
    const first = mockRow({
      id: 'req-first',
      tool: 'Bash',
      args: 'one',
      metadata: { telegramMessageId: 111 },
    });
    const second = mockRow({
      id: 'req-second',
      tool: 'Bash',
      args: 'two',
      metadata: { telegramMessageId: 222 },
    });
    // Ascending order (oldest first) — matches ORDER BY created_at ASC in the query
    currentState = makeState({ pendingSelectResult: { data: [first, second], error: null } });

    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve', '999');
    expect(result.intercepted).toBe(true);
    expect(result.requestId).toBe('req-second');
  });

  it('uses most-recent pending when no replyToMessageId is given', async () => {
    // Ascending order — newest is last in the array
    const pending = [
      mockRow({ id: 'older', tool: 'Bash' }),
      mockRow({ id: 'newest', tool: 'Bash' }),
    ];
    currentState = makeState({ pendingSelectResult: { data: pending, error: null } });

    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve');
    expect(result.requestId).toBe('newest');
  });
});

// ============================================================================
// Scoped resolution — "approve agent/session/studio" must filter by anchor
// ============================================================================

describe('checkApprovalResponse: scoped resolution', () => {
  it('"approve agent" with reply-to only resolves requests from the same agent', async () => {
    const wrenReq = mockRow({
      id: 'wren-req',
      tool: 'Bash',
      requesting_agent_id: 'wren',
      metadata: { telegramMessageId: 100 },
    });
    const lumenReq = mockRow({
      id: 'lumen-req',
      tool: 'Write',
      requesting_agent_id: 'lumen',
      metadata: { telegramMessageId: 200 },
    });
    // Ascending order
    currentState = makeState({
      pendingSelectResult: { data: [wrenReq, lumenReq], error: null },
    });

    // Reply to wren's notification, say "approve agent"
    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve agent', '100');
    expect(result.intercepted).toBe(true);
    // Should resolve ONLY wren's request, not lumen's
    expect(result.resolvedRequests?.length).toBe(1);
    expect(result.resolvedRequests?.[0].id).toBe('wren-req');
  });

  it('"approve session" with reply-to only resolves requests from the same session', async () => {
    const session1Req = mockRow({
      id: 'sess1-req',
      tool: 'Bash',
      session_id: 'session-A',
      metadata: { telegramMessageId: 100 },
    });
    const session2Req = mockRow({
      id: 'sess2-req',
      tool: 'Write',
      session_id: 'session-B',
      metadata: { telegramMessageId: 200 },
    });
    currentState = makeState({
      pendingSelectResult: { data: [session1Req, session2Req], error: null },
    });

    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve session', '100');
    expect(result.intercepted).toBe(true);
    expect(result.resolvedRequests?.length).toBe(1);
    expect(result.resolvedRequests?.[0].id).toBe('sess1-req');
  });

  it('"approve studio" with reply-to only resolves requests from the same studio', async () => {
    const studio1Req = mockRow({
      id: 'studio1-req',
      tool: 'Bash',
      studio_id: 'studio-A',
      metadata: { telegramMessageId: 100 },
    });
    const studio2Req = mockRow({
      id: 'studio2-req',
      tool: 'Write',
      studio_id: 'studio-B',
      metadata: { telegramMessageId: 200 },
    });
    currentState = makeState({
      pendingSelectResult: { data: [studio1Req, studio2Req], error: null },
    });

    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve studio', '100');
    expect(result.intercepted).toBe(true);
    expect(result.resolvedRequests?.length).toBe(1);
    expect(result.resolvedRequests?.[0].id).toBe('studio1-req');
  });

  it('"approve all" resolves ALL pending regardless of agent/session/studio', async () => {
    const wrenReq = mockRow({
      id: 'wren-req',
      tool: 'Bash',
      requesting_agent_id: 'wren',
    });
    const lumenReq = mockRow({
      id: 'lumen-req',
      tool: 'Write',
      requesting_agent_id: 'lumen',
    });
    currentState = makeState({
      pendingSelectResult: { data: [wrenReq, lumenReq], error: null },
    });

    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve all');
    expect(result.intercepted).toBe(true);
    expect(result.resolvedRequests?.length).toBe(2);
  });

  it('"approve agent" without reply-to falls back to most recent only', async () => {
    const wrenReq = mockRow({
      id: 'wren-req',
      tool: 'Bash',
      requesting_agent_id: 'wren',
    });
    const lumenReq = mockRow({
      id: 'lumen-req',
      tool: 'Write',
      requesting_agent_id: 'lumen',
    });
    currentState = makeState({
      pendingSelectResult: { data: [wrenReq, lumenReq], error: null },
    });

    // No reply-to → no anchor → falls back to most recent only
    const result = await checkApprovalResponse(USER_ID, PLATFORM_ID, 'approve agent');
    expect(result.intercepted).toBe(true);
    expect(result.resolvedRequests?.length).toBe(1);
    expect(result.resolvedRequests?.[0].id).toBe('lumen-req');
  });
});

// ============================================================================
// Resolution — the fields we write on grant/deny, and the optimistic lock
// ============================================================================

describe('checkApprovalResponse: resolution', () => {
  const pending = mockRow({ id: 'req-42', tool: 'Bash', args: 'docker push' });

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
    vi.useFakeTimers();
    currentState = makeState({ trustedUsersResult: { data: [] } });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await notifyPlatformOfApprovalRequest(baseRequest);
    await vi.advanceTimersByTimeAsync(2500);

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends Telegram message and stores telegramMessageId in metadata on success', async () => {
    vi.useFakeTimers();
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

    // Advance past the debounce window to flush the notification buffer
    await vi.advanceTimersByTimeAsync(2500);

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

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('preserves the clone origin through the metadata write-back', async () => {
    // The write-back REPLACES the metadata object, so the origin recorded at
    // insert is erased unless it is carried forward — and the audit trail is
    // the one place that has to know which clone asked.
    vi.useFakeTimers();
    currentState = makeState({
      trustedUsersResult: {
        data: [{ platform: 'telegram', platform_user_id: 'chat-999' }],
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: { message_id: 42 } }) })
    );

    await notifyPlatformOfApprovalRequest({
      ...baseRequest,
      origin: { origin: 'clone', cloneId: 'clone-2', cloneLabel: 'audit auth paths' },
    });
    await vi.advanceTimersByTimeAsync(2500);

    expect(currentState.updateCalledWith?.metadata).toMatchObject({
      origin: { origin: 'clone', cloneId: 'clone-2', cloneLabel: 'audit auth paths' },
      telegramMessageId: 42,
      platform: 'telegram',
    });

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('preserves each clone origin across a batched metadata write-back', async () => {
    vi.useFakeTimers();
    currentState = makeState({
      trustedUsersResult: {
        data: [{ platform: 'telegram', platform_user_id: 'chat-999' }],
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: { message_id: 77 } }) })
    );

    // Two requests inside the debounce window batch into one notification, and
    // each row's write-back must keep ITS own origin rather than the last one.
    await notifyPlatformOfApprovalRequest({
      ...baseRequest,
      id: 'req-a',
      origin: { origin: 'clone', cloneId: 'clone-1', cloneLabel: 'auth' },
    });
    await notifyPlatformOfApprovalRequest({
      ...baseRequest,
      id: 'req-b',
      origin: { origin: 'clone', cloneId: 'clone-2', cloneLabel: 'coverage' },
    });
    await vi.advanceTimersByTimeAsync(2500);

    // Assert BOTH rows, paired with their ids. Checking only the last update
    // would pass if the loop wrote clone-2's origin onto every row — which is
    // the shared-object bug a batch write is most likely to have.
    const byId = new Map(currentState.updates.map((u) => [u.id, u.updates]));
    expect(byId.get('req-a')?.metadata).toMatchObject({
      origin: { origin: 'clone', cloneId: 'clone-1', cloneLabel: 'auth' },
      batchMessageId: 77,
      batchIndex: 0,
    });
    expect(byId.get('req-b')?.metadata).toMatchObject({
      origin: { origin: 'clone', cloneId: 'clone-2', cloneLabel: 'coverage' },
      batchMessageId: 77,
      batchIndex: 1,
    });

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('omits origin entirely for a parent request', async () => {
    vi.useFakeTimers();
    currentState = makeState({
      trustedUsersResult: {
        data: [{ platform: 'telegram', platform_user_id: 'chat-999' }],
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: { message_id: 9 } }) })
    );

    await notifyPlatformOfApprovalRequest(baseRequest);
    await vi.advanceTimersByTimeAsync(2500);

    // Absent rather than null: parent rows should read exactly as they did
    // before clones existed.
    expect(currentState.updateCalledWith?.metadata).not.toHaveProperty('origin');

    vi.useRealTimers();
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

describe('approval notifications — shadow clone origin', () => {
  const base = {
    id: 'req-1',
    userId: 'user-1',
    tool: 'save_link',
    args: null,
    reason: 'Tool requires approval.',
    requestingAgentId: 'wren',
    studioId: null,
    sessionId: null,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };

  it('names the parent when no clone is involved', () => {
    expect(formatSingleNotification({ ...base })).toContain('from wren');
  });

  it('names the clone that asked, not just its parent', () => {
    // A clone carries its parent's identity, so requestingAgentId alone reads
    // as the parent asking. Away mode means approving a call whose context the
    // user cannot see — which clone wants it is the whole judgement.
    const msg = formatSingleNotification({
      ...base,
      origin: { origin: 'clone', cloneId: 'clone-2', cloneLabel: 'audit auth paths' },
    });
    expect(msg).toContain('wren');
    expect(msg).toContain('audit auth paths');
  });

  it('falls back to the clone id when it has no label', () => {
    const msg = formatSingleNotification({
      ...base,
      origin: { origin: 'clone', cloneId: 'clone-2' },
    });
    expect(msg).toContain('clone-2');
  });

  it('ignores a parent-origin marker', () => {
    const msg = formatSingleNotification({ ...base, origin: { origin: 'parent' } });
    expect(msg).toContain('from wren');
    expect(msg).not.toContain('🌀');
  });

  it('distinguishes concurrent clones in a batched notification', () => {
    // Three clones batched under one identity would otherwise read as one
    // agent asking three times.
    const msg = formatBatchNotification([
      { ...base, id: 'r1', origin: { origin: 'clone', cloneId: 'clone-1', cloneLabel: 'auth' } },
      {
        ...base,
        id: 'r2',
        origin: { origin: 'clone', cloneId: 'clone-2', cloneLabel: 'coverage' },
      },
    ]);
    expect(msg).toContain('auth');
    expect(msg).toContain('coverage');
    expect(msg).toContain('2 permission requests');
  });
});

describe('approval notifications — batch clone mapping', () => {
  const base = {
    id: 'req-1',
    userId: 'user-1',
    tool: 'save_link',
    args: null,
    reason: null,
    requestingAgentId: 'wren',
    studioId: null,
    sessionId: null,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };

  it('maps each numbered row to the clone that asked', () => {
    // Replies are per-number ("approve 1,3"), so a header listing every clone
    // is not enough — the user has to know which number is which clone.
    const msg = formatBatchNotification([
      {
        ...base,
        id: 'r1',
        tool: 'save_link',
        origin: { origin: 'clone', cloneId: 'clone-1', cloneLabel: 'auth audit' },
      },
      {
        ...base,
        id: 'r2',
        tool: 'create_task',
        origin: { origin: 'clone', cloneId: 'clone-2', cloneLabel: 'coverage map' },
      },
    ]);

    const lines = msg.split('\n');
    const first = lines.find((l) => l.startsWith('1.'));
    const second = lines.find((l) => l.startsWith('2.'));
    expect(first).toContain('save_link');
    expect(first).toContain('auth audit');
    expect(first).not.toContain('coverage map');
    expect(second).toContain('create_task');
    expect(second).toContain('coverage map');
    expect(second).not.toContain('auth audit');
  });

  it('leaves rows unadorned when everything came from the same requester', () => {
    const msg = formatBatchNotification([
      { ...base, id: 'r1', tool: 'save_link' },
      { ...base, id: 'r2', tool: 'create_task' },
    ]);
    const first = msg.split('\n').find((l) => l.startsWith('1.'));
    // No per-row attribution to read past when there is nothing to distinguish.
    expect(first).toBe('1. `save_link`');
  });
});
