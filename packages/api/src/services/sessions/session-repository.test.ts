import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRepository } from './session-repository.js';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

/**
 * Builds a minimal mock Supabase client whose .from().select/update/insert chains
 * can be inspected after each test.
 */
function createMockSupabase() {
  const lastUpdate: { table?: string; id?: string; data?: Record<string, unknown> } = {};
  const fakeRow = {
    id: 'sess-1',
    user_id: 'user-1',
    sb_id: null,
    agent_id: 'lumen',
    studio_id: null,
    workspace_id: null,
    thread_key: null,
    lifecycle: 'idle',
    status: 'active',
    current_phase: null,
    type: 'primary',
    backend: 'codex-cli',
    model: null,
    backend_session_id: null,
    claude_session_id: null,
    working_dir: null,
    context: null,
    started_at: '2026-03-13T08:00:00.000Z',
    ended_at: null,
    summary: null,
    updated_at: '2026-03-13T08:00:00.000Z',
    message_count: 0,
    token_count: 0,
    metadata: {},
  };

  const builder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    // Read fakeRow at call time, not at construction — tests mutate it between
    // calls to simulate successive turns.
    single: vi
      .fn()
      .mockImplementation(() => Promise.resolve({ data: { ...fakeRow }, error: null })),
    update: vi.fn().mockImplementation((data: Record<string, unknown>) => {
      lastUpdate.data = data;
      return {
        eq: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { ...fakeRow, ...data },
          error: null,
        }),
      };
    }),
  };

  const supabase = {
    from: vi.fn().mockReturnValue(builder),
  };

  return { supabase, builder, lastUpdate, fakeRow };
}

describe('SessionRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should write both claude_session_id and backend_session_id when updating backendSessionId', async () => {
    const { supabase, builder } = createMockSupabase();
    const repo = new SessionRepository(supabase as never);

    await repo.update('sess-1', {
      backendSessionId: '019ceb00-codex-uuid',
    });

    // The first call to builder.update should have both columns
    const updateCall = builder.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateCall.claude_session_id).toBe('019ceb00-codex-uuid');
    expect(updateCall.backend_session_id).toBe('019ceb00-codex-uuid');
  });

  it('markCompacted with null should not overwrite backend_session_id', async () => {
    const { supabase, builder, fakeRow } = createMockSupabase();
    // Simulate a session that already has a backend session ID
    builder.single.mockResolvedValueOnce({
      data: {
        ...fakeRow,
        backend_session_id: 'codex-thread-uuid',
        claude_session_id: 'codex-thread-uuid',
      },
      error: null,
    });
    const repo = new SessionRepository(supabase as never);

    await repo.markCompacted('sess-1', null);

    // The update call (second .from() call) should NOT include claude_session_id or backend_session_id
    const updateCall = builder.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateCall).not.toHaveProperty('claude_session_id');
    expect(updateCall).not.toHaveProperty('backend_session_id');
    expect(updateCall.metadata).toBeDefined();
  });

  it('markCompacted with a new session ID should write both columns', async () => {
    const { supabase, builder, fakeRow } = createMockSupabase();
    builder.single.mockResolvedValueOnce({
      data: { ...fakeRow, backend_session_id: 'old-uuid', claude_session_id: 'old-uuid' },
      error: null,
    });
    const repo = new SessionRepository(supabase as never);

    await repo.markCompacted('sess-1', 'new-session-uuid');

    const updateCall = builder.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateCall.claude_session_id).toBe('new-session-uuid');
    expect(updateCall.backend_session_id).toBe('new-session-uuid');
  });

  it('should not set backend_session_id when backendSessionId is not in the update', async () => {
    const { supabase, builder } = createMockSupabase();
    const repo = new SessionRepository(supabase as never);

    await repo.update('sess-1', {
      lifecycle: 'idle',
      messageCount: 5,
    });

    const updateCall = builder.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateCall).not.toHaveProperty('claude_session_id');
    expect(updateCall).not.toHaveProperty('backend_session_id');
    expect(updateCall.lifecycle).toBe('idle');
    expect(updateCall.message_count).toBe(5);
  });

  it('should write alias to DB when updating', async () => {
    const { supabase, builder } = createMockSupabase();
    const repo = new SessionRepository(supabase as never);

    await repo.update('sess-1', { alias: 'primary' });

    const updateCall = builder.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateCall.alias).toBe('primary');
  });

  it('should clear alias by writing null when alias is empty string', async () => {
    const { supabase, builder } = createMockSupabase();
    const repo = new SessionRepository(supabase as never);

    await repo.update('sess-1', { alias: '' });

    const updateCall = builder.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateCall.alias).toBeNull();
  });

  it('should include alias in create when provided', async () => {
    const { supabase, builder, fakeRow } = createMockSupabase();
    // Mock insert chain
    builder.insert = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { ...fakeRow, alias: 'review' }, error: null }),
      }),
    });
    const repo = new SessionRepository(supabase as never);

    const session = await repo.create({
      userId: 'user-1',
      agentId: 'wren',
      backendSessionId: null,
      type: 'primary',
      lifecycle: 'idle',
      status: 'active',
      contextTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      messageCount: 0,
      tokenCount: 0,
      backend: 'claude-code',
      model: null,
      lastCompactionAt: null,
      compactionCount: 0,
      endedAt: null,
      metadata: {},
      alias: 'review',
    });

    const insertCall = builder.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(insertCall.alias).toBe('review');
  });
});

describe('SessionRepository.updateTokenUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accumulates a per-turn delta as-is when not cumulative', async () => {
    const { supabase, lastUpdate } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    await repo.updateTokenUsage('sess-1', {
      contextTokens: 5000,
      inputTokens: 1200,
      outputTokens: 340,
    });

    expect(lastUpdate.data?.token_count).toBe(1540);
  });

  // Codex reports ThreadTokenUsage.total, so consecutive turns carry ever
  // larger running totals. Adding them re-applies the whole history each turn
  // (quadratic); only the difference is this turn's real usage.
  it('diffs consecutive cumulative totals instead of adding them', async () => {
    const { supabase, lastUpdate, fakeRow } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    // Turn 1: no checkpoint yet — the whole reported total is the delta.
    await repo.updateTokenUsage(
      'sess-1',
      { contextTokens: 900, inputTokens: 1000, outputTokens: 100, cumulative: true },
      { backendSessionId: 'thread-a' }
    );
    expect(lastUpdate.data?.token_count).toBe(1100);

    // Turn 2: cumulative grew to 2500/250. Real usage is 1500/150, not 2750.
    fakeRow.metadata = {
      totalInputTokens: 1000,
      totalOutputTokens: 100,
      usageCheckpoint: { backendSessionId: 'thread-a', inputTokens: 1000, outputTokens: 100 },
    };

    await repo.updateTokenUsage(
      'sess-1',
      { contextTokens: 2400, inputTokens: 2500, outputTokens: 250, cumulative: true },
      { backendSessionId: 'thread-a' }
    );

    expect(lastUpdate.data?.token_count).toBe(2750);
    expect((lastUpdate.data?.metadata as Record<string, unknown>).usageCheckpoint).toEqual({
      backendSessionId: 'thread-a',
      inputTokens: 2500,
      outputTokens: 250,
    });
  });

  // Totals restart whenever the backend thread does, so a checkpoint from a
  // different thread must not be diffed against — that would yield a negative
  // or wildly wrong delta.
  it('does not diff against a checkpoint from a different backend thread', async () => {
    const { supabase, lastUpdate, fakeRow } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    fakeRow.metadata = {
      totalInputTokens: 5000,
      totalOutputTokens: 500,
      usageCheckpoint: { backendSessionId: 'thread-a', inputTokens: 5000, outputTokens: 500 },
    };

    await repo.updateTokenUsage(
      'sess-1',
      { contextTokens: 200, inputTokens: 300, outputTokens: 40, cumulative: true },
      { backendSessionId: 'thread-b' }
    );

    // Fresh thread: the report itself is the delta. 5000+300, 500+40.
    expect(lastUpdate.data?.token_count).toBe(5840);
  });

  it('rebases when the counter moves backwards under the same thread id', async () => {
    const { supabase, lastUpdate, fakeRow } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    fakeRow.metadata = {
      totalInputTokens: 9000,
      totalOutputTokens: 900,
      usageCheckpoint: { backendSessionId: 'thread-a', inputTokens: 9000, outputTokens: 900 },
    };

    await repo.updateTokenUsage(
      'sess-1',
      { contextTokens: 100, inputTokens: 120, outputTokens: 10, cumulative: true },
      { backendSessionId: 'thread-a' }
    );

    expect(lastUpdate.data?.token_count).toBe(10030);
  });

  // Last-ditch heuristic only: a cumulative total still reaching us undiffed.
  it('refuses to accumulate an implausible delta', async () => {
    const { supabase, lastUpdate } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    await repo.updateTokenUsage('sess-1', {
      contextTokens: 1_317_195_843,
      inputTokens: 3_437_373_064,
      outputTokens: 3_645_922,
    });

    expect(lastUpdate.data).toBeUndefined();
  });

  it('accepts a large but plausible turn', async () => {
    const { supabase, lastUpdate } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    await repo.updateTokenUsage('sess-1', {
      contextTokens: 2_000_000,
      inputTokens: 1_900_000,
      outputTokens: 60_000,
    });

    expect(lastUpdate.data?.token_count).toBe(1_960_000);
  });
});
