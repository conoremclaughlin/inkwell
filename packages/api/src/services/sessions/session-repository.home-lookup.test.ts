import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRepository } from './session-repository.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * findByUserAndAgent is the general-active routing rung's lookup. Its
 * `neq('lifecycle', 'failed')` is what turned one crashed heartbeat turn into
 * a second Myra (2026-09-10 06:52Z): the crashed home session was unended but
 * excluded, so the next Telegram message created a twin. Routing now asks for
 * failed rows explicitly; every other caller keeps the exclusion.
 *
 * The chain is recorded call by call so the assertion is about the QUERY the
 * repository builds, not about a fake row it hands back.
 */
function createRecordingSupabase(rows: Array<Record<string, unknown>>) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'neq', 'or', 'order', 'limit']) {
    builder[m] = vi.fn((...args: unknown[]) => {
      calls.push([m, args]);
      return builder;
    });
  }
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve);
  const supabase = { from: vi.fn().mockReturnValue(builder) };
  return { supabase, calls };
}

const failedHome = {
  id: 'home-1',
  user_id: 'user-1',
  sb_id: 'sb-myra',
  agent_id: 'myra',
  studio_id: null,
  thread_key: null,
  contact_id: null,
  lifecycle: 'failed',
  status: 'active',
  backend: 'ink',
  started_at: '2026-08-04T00:30:52.000Z',
  ended_at: null,
  metadata: { type: 'primary' },
};

describe('SessionRepository.findByUserAndAgent — the failed-lifecycle exclusion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('excludes failed sessions by default', async () => {
    const { supabase, calls } = createRecordingSupabase([]);
    const repo = new SessionRepository(supabase as never);

    await repo.findByUserAndAgent('user-1', 'myra', { type: 'primary', sbId: 'sb-myra' });

    expect(calls).toContainEqual(['neq', ['lifecycle', 'failed']]);
    expect(calls).toContainEqual(['is', ['ended_at', null]]);
  });

  it('includes a failed session when routing asks for it, and returns it', async () => {
    const { supabase, calls } = createRecordingSupabase([failedHome]);
    const repo = new SessionRepository(supabase as never);

    const found = await repo.findByUserAndAgent('user-1', 'myra', {
      type: 'primary',
      sbId: 'sb-myra',
      includeFailed: true,
    });

    expect(calls.map(([m]) => m)).not.toContain('neq');
    // Everything else about the lookup is unchanged: unended, newest first,
    // one row, scoped to the canonical identity.
    expect(calls).toContainEqual(['is', ['ended_at', null]]);
    expect(calls).toContainEqual(['eq', ['sb_id', 'sb-myra']]);
    expect(calls).toContainEqual(['order', ['started_at', { ascending: false }]]);
    expect(calls).toContainEqual(['limit', [1]]);
    expect(found?.id).toBe('home-1');
    expect(found?.lifecycle).toBe('failed');
  });

  it('includeFailed: false is the same as omitting it', async () => {
    const { supabase, calls } = createRecordingSupabase([]);
    const repo = new SessionRepository(supabase as never);

    await repo.findByUserAndAgent('user-1', 'myra', { includeFailed: false });

    expect(calls).toContainEqual(['neq', ['lifecycle', 'failed']]);
  });

  it('the primary predicate is in the query, before the limit, and keeps untyped rows', async () => {
    const { supabase, calls } = createRecordingSupabase([]);
    const repo = new SessionRepository(supabase as never);

    await repo.findByUserAndAgent('user-1', 'myra', { type: 'primary', includeFailed: true });

    // A newer failed task session must be excluded by the DATABASE, not by
    // a check on the single row LIMIT 1 already chose (Lumen, PR #680).
    expect(calls).toContainEqual(['or', ['metadata->>type.eq.primary,metadata->>type.is.null']]);
    expect(calls.map(([m]) => m)).toContain('limit');
  });

  it('a non-primary type is filtered in the query too', async () => {
    const { supabase, calls } = createRecordingSupabase([]);
    const repo = new SessionRepository(supabase as never);

    await repo.findByUserAndAgent('user-1', 'myra', { type: 'task' });

    expect(calls).toContainEqual(['eq', ['metadata->>type', 'task']]);
    expect(calls.map(([m]) => m)).not.toContain('or');
  });
});
