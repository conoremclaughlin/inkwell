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

    // Baseline already established at 1000/100 for thread-a.
    fakeRow.metadata = {
      totalInputTokens: 1000,
      totalOutputTokens: 100,
      usageCheckpoint: { backendSessionId: 'thread-a', inputTokens: 1000, outputTokens: 100 },
    };

    // Cumulative grew to 2500/250, so this turn used 1500/150. Adding the
    // report instead of diffing it would store 3850.
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

  // Rollout: sessions that predate checkpointing already carry token history.
  // The first cumulative report covers the WHOLE thread, including everything
  // already counted — adding it would duplicate the entire history.
  it('establishes a baseline without accumulating when no checkpoint exists', async () => {
    const { supabase, lastUpdate, fakeRow } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    fakeRow.metadata = { totalInputTokens: 4000, totalOutputTokens: 400 };

    await repo.updateTokenUsage(
      'sess-1',
      { inputTokens: 9000, outputTokens: 900, cumulative: true },
      { backendSessionId: 'thread-a' }
    );

    // Totals unchanged; only the baseline is laid down.
    expect(lastUpdate.data?.token_count).toBe(4400);
    expect((lastUpdate.data?.metadata as Record<string, unknown>).usageCheckpoint).toEqual({
      backendSessionId: 'thread-a',
      inputTokens: 9000,
      outputTokens: 900,
    });
  });

  // The motivating 3.4B session: an EXISTING session whose running total
  // already exceeds the ceiling. If the baseline were laid down after the
  // guard, it could never be written and accounting would stay disabled for
  // that session forever. Prior history is seeded deliberately — with a
  // zero-history row this would exercise the new-session path instead.
  it('baselines an existing session whose running total already exceeds the ceiling', async () => {
    const { supabase, lastUpdate, fakeRow } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    fakeRow.token_count = 1_500_000;
    fakeRow.metadata = { totalInputTokens: 1_400_000, totalOutputTokens: 100_000 };

    await repo.updateTokenUsage(
      'sess-1',
      { inputTokens: 3_437_373_064, outputTokens: 3_645_922, cumulative: true },
      { backendSessionId: 'thread-a' }
    );

    // Totals untouched, baseline written despite exceeding the ceiling.
    expect(lastUpdate.data?.token_count).toBe(1_500_000);
    expect((lastUpdate.data?.metadata as Record<string, unknown>).usageCheckpoint).toEqual({
      backendSessionId: 'thread-a',
      inputTokens: 3_437_373_064,
      outputTokens: 3_645_922,
    });
  });

  // A brand-new session has no checkpoint AND no history. Its first report is
  // genuinely the first turn's usage — baselining it would silently discard
  // that turn from every new Codex session, permanently.
  it('accumulates the first report on a brand-new session', async () => {
    const { supabase, lastUpdate } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    await repo.updateTokenUsage(
      'sess-1',
      { inputTokens: 1000, outputTokens: 100, cumulative: true },
      { backendSessionId: 'thread-a' }
    );

    expect(lastUpdate.data?.token_count).toBe(1100);
    expect((lastUpdate.data?.metadata as Record<string, unknown>).usageCheckpoint).toEqual({
      backendSessionId: 'thread-a',
      inputTokens: 1000,
      outputTokens: 100,
    });
  });

  // A stale baseline would make the next delta larger still, tripping the
  // guard again and wedging accounting off permanently.
  it('advances the checkpoint even when refusing an implausible delta', async () => {
    const { supabase, lastUpdate, fakeRow } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    fakeRow.metadata = {
      totalInputTokens: 1000,
      totalOutputTokens: 100,
      usageCheckpoint: { backendSessionId: 'thread-a', inputTokens: 1000, outputTokens: 100 },
    };

    await repo.updateTokenUsage(
      'sess-1',
      { inputTokens: 500_000_000, outputTokens: 100, cumulative: true },
      { backendSessionId: 'thread-a' }
    );

    // Tokens not accumulated, but the baseline moved forward.
    expect(lastUpdate.data?.token_count).toBeUndefined();
    expect((lastUpdate.data?.metadata as Record<string, unknown>).usageCheckpoint).toEqual({
      backendSessionId: 'thread-a',
      inputTokens: 500_000_000,
      outputTokens: 100,
    });
  });

  // Codex reports no per-turn context measure. Writing the cumulative input
  // total in its place produced a false 1.3B "context" reading.
  it('leaves the stored context figure alone when none is reported', async () => {
    const { supabase, lastUpdate, fakeRow } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    fakeRow.metadata = {
      contextTokens: 4242,
      totalInputTokens: 1000,
      totalOutputTokens: 100,
      usageCheckpoint: { backendSessionId: 'thread-a', inputTokens: 1000, outputTokens: 100 },
    };

    await repo.updateTokenUsage(
      'sess-1',
      { inputTokens: 1500, outputTokens: 150, cumulative: true },
      { backendSessionId: 'thread-a' }
    );

    const metadata = lastUpdate.data?.metadata as Record<string, unknown>;
    expect(metadata.contextTokens).toBe(4242);
    expect(lastUpdate.data?.token_count).toBe(1650);
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

// Cached input bills at a different rate from fresh input (reads 0.1x, writes
// 1.25x), so the split has to survive into storage or cost attribution is
// guesswork. It is a BREAKDOWN of inputTokens, never an addition to it.
describe('SessionRepository.updateTokenUsage — cache breakdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accumulates cache read/write totals alongside input without double-counting', async () => {
    const { supabase, lastUpdate } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    // A typical cached Claude turn: 180k of the 182k input came from cache.
    await repo.updateTokenUsage('sess-1', {
      contextTokens: 182_000,
      inputTokens: 182_000,
      outputTokens: 900,
      cacheReadTokens: 180_000,
      cacheWriteTokens: 1_500,
    });

    const metadata = lastUpdate.data?.metadata as Record<string, number>;
    expect(metadata.totalInputTokens).toBe(182_000);
    expect(metadata.totalCacheReadTokens).toBe(180_000);
    expect(metadata.totalCacheWriteTokens).toBe(1_500);
    // token_count stays input + output — cache tokens are already inside input.
    expect(lastUpdate.data?.token_count).toBe(182_900);
  });

  it('adds to existing cache totals across turns', async () => {
    const { supabase, lastUpdate, fakeRow } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    fakeRow.metadata = {
      totalInputTokens: 100_000,
      totalOutputTokens: 5_000,
      totalCacheReadTokens: 90_000,
      totalCacheWriteTokens: 2_000,
    };

    await repo.updateTokenUsage('sess-1', {
      contextTokens: 50_000,
      inputTokens: 50_000,
      outputTokens: 400,
      cacheReadTokens: 48_000,
      cacheWriteTokens: 500,
    });

    const metadata = lastUpdate.data?.metadata as Record<string, number>;
    expect(metadata.totalCacheReadTokens).toBe(138_000);
    expect(metadata.totalCacheWriteTokens).toBe(2_500);
  });

  // Codex sends running thread totals and carries no cache fields; a stray
  // value on that path would be added undiffed every turn.
  it('ignores cache fields on cumulative reports', async () => {
    const { supabase, lastUpdate, fakeRow } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    fakeRow.metadata = {
      totalInputTokens: 1_000,
      totalOutputTokens: 100,
      totalCacheReadTokens: 0,
      usageCheckpoint: { backendSessionId: 'thread-a', inputTokens: 1_000, outputTokens: 100 },
    };

    await repo.updateTokenUsage(
      'sess-1',
      {
        inputTokens: 2_500,
        outputTokens: 250,
        cacheReadTokens: 999_999,
        cumulative: true,
      },
      { backendSessionId: 'thread-a' }
    );

    const metadata = lastUpdate.data?.metadata as Record<string, number>;
    expect(metadata.totalCacheReadTokens ?? 0).toBe(0);
  });
});

describe('SessionRepository.updateTokenUsage — plausibility guard scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // One Claude query re-reads its cached prompt on every model step, so ~20
  // steps against a ~500k context legitimately bills ~10M input. The guard
  // exists for undiffed running totals, which only the cumulative path can
  // produce — applying it here discarded real usage.
  it('accumulates a cache-heavy multi-step turn above the ceiling', async () => {
    const { supabase, lastUpdate } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    await repo.updateTokenUsage('sess-1', {
      contextTokens: 500_000,
      inputTokens: 12_000_000,
      outputTokens: 80_000,
      cacheReadTokens: 11_900_000,
      cacheWriteTokens: 40_000,
    });

    expect(lastUpdate.data?.token_count).toBe(12_080_000);
    const metadata = lastUpdate.data?.metadata as Record<string, number>;
    expect(metadata.totalCacheReadTokens).toBe(11_900_000);
  });

  // The original pathology: a running total reaching the repository undiffed.
  it('still refuses an implausible cumulative delta', async () => {
    const { supabase, lastUpdate } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    await repo.updateTokenUsage(
      'sess-1',
      { inputTokens: 3_437_373_064, outputTokens: 3_645_922, cumulative: true },
      { backendSessionId: 'thread-a' }
    );

    expect(lastUpdate.data?.token_count).toBeUndefined();
  });
});

describe('SessionRepository.updateTokenUsage — per-model totals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accumulates each reported model key against itself, cost included', async () => {
    const { supabase, lastUpdate, fakeRow } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    fakeRow.metadata = {
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 1_000,
          outputTokens: 100,
          cacheReadTokens: 500,
          cacheWriteTokens: 50,
          costUSD: 0.01,
          canonicalModel: 'claude-opus-5',
        },
      },
    };

    await repo.updateTokenUsage('sess-1', {
      inputTokens: 2_000,
      outputTokens: 200,
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 1_500,
          outputTokens: 150,
          cacheReadTokens: 700,
          cacheWriteTokens: 20,
          costUSD: 0.02,
          canonicalModel: 'claude-opus-5',
        },
        'claude-haiku-4-5': {
          inputTokens: 500,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUSD: 0.001,
          canonicalModel: 'claude-haiku-4-5',
        },
      },
    });

    const metadata = lastUpdate.data?.metadata as Record<string, Record<string, ModelTotals>>;
    expect(metadata.modelUsage['claude-opus-5'].inputTokens).toBe(2_500);
    expect(metadata.modelUsage['claude-opus-5'].costUSD).toBeCloseTo(0.03);
    // A model seen for the first time starts from zero, not from another key.
    expect(metadata.modelUsage['claude-haiku-4-5'].outputTokens).toBe(50);
  });
});

describe('SessionRepository.updateTokenUsage — unreported cost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Summing an unreported cost as 0 would make a session's total look
  // measured when part of it was never reported (Lumen, PR #500 round 2).
  it('keeps cost absent when no turn reported one', async () => {
    const { supabase, lastUpdate } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    await repo.updateTokenUsage('sess-1', {
      inputTokens: 100,
      outputTokens: 10,
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    });

    const metadata = lastUpdate.data?.metadata as Record<string, Record<string, ModelTotals>>;
    expect(metadata.modelUsage['claude-opus-5'].outputTokens).toBe(10);
    expect(metadata.modelUsage['claude-opus-5'].costUSD).toBeUndefined();
  });

  it('accumulates once a turn does report cost', async () => {
    const { supabase, lastUpdate, fakeRow } = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SessionRepository(supabase as any);

    fakeRow.metadata = {
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    };

    await repo.updateTokenUsage('sess-1', {
      inputTokens: 50,
      outputTokens: 5,
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 50,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUSD: 0.02,
        },
      },
    });

    const metadata = lastUpdate.data?.metadata as Record<string, Record<string, ModelTotals>>;
    expect(metadata.modelUsage['claude-opus-5'].costUSD).toBeCloseTo(0.02);
  });
});

interface ModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUSD?: number;
  canonicalModel?: string;
}

/**
 * Alias resolution is studio-scoped (migration 20260814080050).
 *
 * The behaviour under test is the refusal: the previous implementation ordered
 * matches by started_at and returned the newest, so an alias could silently
 * resolve into a different worktree than the caller meant. These tests pin the
 * three outcomes — pinned lookup, unique match, ambiguous refusal.
 */
describe('SessionRepository.findByAlias — studio scoping', () => {
  /** Mock whose select chain resolves to `rows`, recording the .eq filters. */
  function aliasSupabase(rows: Array<Record<string, unknown>>) {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {};

    Object.assign(chain, {
      select: vi.fn(() => chain),
      eq: vi.fn((col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      }),
      is: vi.fn(() => chain),
      neq: vi.fn(() => chain),
      // findByAlias awaits the order() call directly — resolve to the row set.
      order: vi.fn(() => Promise.resolve({ data: rows, error: null })),
    });

    return {
      supabase: { from: vi.fn(() => chain) } as never,
      filters,
    };
  }

  function row(id: string, studioId: string | null) {
    return {
      id,
      user_id: 'user-1',
      agent_id: 'wren',
      studio_id: studioId,
      alias: 'review',
      lifecycle: 'idle',
      status: 'active',
      type: 'primary',
      backend: 'claude-code',
      started_at: '2026-08-14T08:00:00.000Z',
      updated_at: '2026-08-14T08:00:00.000Z',
      ended_at: null,
      message_count: 0,
      token_count: 0,
      metadata: {},
    };
  }

  it('returns the single match when the alias is unique', async () => {
    const { supabase } = aliasSupabase([row('sess-a', 'studio-1')]);
    const repo = new SessionRepository(supabase);

    const found = await repo.findByAlias('user-1', 'wren', 'review');

    expect(found?.id).toBe('sess-a');
  });

  it('returns null when nothing matches', async () => {
    const { supabase } = aliasSupabase([]);
    const repo = new SessionRepository(supabase);

    expect(await repo.findByAlias('user-1', 'wren', 'review')).toBeNull();
  });

  it('refuses a bare alias that matches sessions in two studios', async () => {
    const { supabase } = aliasSupabase([row('sess-a', 'studio-1'), row('sess-b', 'studio-2')]);
    const repo = new SessionRepository(supabase);

    // The pre-migration implementation returned sess-a here (newest first),
    // routing the caller into whichever worktree started last.
    await expect(repo.findByAlias('user-1', 'wren', 'review')).rejects.toThrow(/ambiguous/i);
  });

  it('names the candidate studios in the refusal so the caller can qualify', async () => {
    const { supabase } = aliasSupabase([row('sess-a', 'studio-1'), row('sess-b', null)]);
    const repo = new SessionRepository(supabase);

    await expect(repo.findByAlias('user-1', 'wren', 'review')).rejects.toThrow(
      /studio-1.*\(no studio\)/
    );
  });

  it('pins the query to the studio when one is named, and does not refuse', async () => {
    const { supabase, filters } = aliasSupabase([row('sess-a', 'studio-1')]);
    const repo = new SessionRepository(supabase);

    const found = await repo.findByAlias('user-1', 'wren', 'review', 'studio-1');

    expect(found?.id).toBe('sess-a');
    expect(filters.studio_id).toBe('studio-1');
  });

  it('does not filter by studio when no studio is named', async () => {
    const { supabase, filters } = aliasSupabase([row('sess-a', 'studio-1')]);
    const repo = new SessionRepository(supabase);

    await repo.findByAlias('user-1', 'wren', 'review');

    expect(filters).not.toHaveProperty('studio_id');
  });

  it('treats an explicit null studio as a real scope, not "unscoped"', async () => {
    // A session with no studio is still addressable — the caller passing the
    // nil-studio scope must not be conflated with passing nothing.
    const { supabase, filters } = aliasSupabase([row('sess-b', null)]);
    const repo = new SessionRepository(supabase);

    const found = await repo.findByAlias('user-1', 'wren', 'review', '');

    expect(found?.id).toBe('sess-b');
    expect(filters).toHaveProperty('studio_id');
  });
});
