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
    identity_id: null,
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
    single: vi.fn().mockResolvedValue({ data: { ...fakeRow }, error: null }),
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
});
