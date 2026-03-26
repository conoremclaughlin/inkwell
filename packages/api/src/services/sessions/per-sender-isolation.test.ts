/**
 * Per-Sender Session Isolation Tests
 *
 * Tests that contact_id properly scopes sessions and memories
 * so external senders get isolated conversation context.
 */

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
 * Builds a mock Supabase client that tracks query filters
 * so we can verify contact_id is passed through.
 */
function createMockSupabase(rows: Record<string, unknown>[] = []) {
  const filters: Array<{ method: string; args: unknown[] }> = [];

  const fakeRow = {
    id: 'sess-1',
    user_id: 'user-1',
    identity_id: null,
    agent_id: 'myra',
    studio_id: null,
    contact_id: null,
    workspace_id: null,
    thread_key: null,
    lifecycle: 'idle',
    status: 'active',
    current_phase: null,
    backend: 'claude-code',
    model: null,
    backend_session_id: null,
    claude_session_id: null,
    working_dir: null,
    context: null,
    started_at: '2026-03-25T08:00:00.000Z',
    ended_at: null,
    summary: null,
    updated_at: '2026-03-25T08:00:00.000Z',
    message_count: 0,
    token_count: 0,
    metadata: {},
    compacting_since: null,
  };

  const builder: Record<string, unknown> = {};

  for (const method of [
    'select',
    'insert',
    'update',
    'eq',
    'neq',
    'is',
    'or',
    'order',
    'limit',
    'gte',
  ]) {
    builder[method] = vi.fn().mockImplementation((...args: unknown[]) => {
      filters.push({ method, args });
      return builder;
    });
  }

  // Single returns the first row or the configured rows
  builder.single = vi.fn().mockImplementation(() => {
    if (rows.length > 0) {
      return Promise.resolve({ data: rows[0], error: null });
    }
    return Promise.resolve({ data: { ...fakeRow }, error: null });
  });

  // Direct await returns array
  builder.then = (resolve: (value: unknown) => void) => {
    const result = { data: rows.length > 0 ? rows : [fakeRow], error: null };
    resolve(result);
    return Promise.resolve(result);
  };

  const supabase = {
    from: vi.fn().mockReturnValue(builder),
  };

  return { supabase, builder, filters, fakeRow };
}

describe('Per-Sender Session Isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SessionRepository.findByUserAndAgent with contactId', () => {
    it('should filter by contact_id when provided', async () => {
      const contactRow = {
        id: 'sess-contact-1',
        user_id: 'user-1',
        agent_id: 'myra',
        contact_id: 'contact-alice',
        identity_id: null,
        studio_id: null,
        workspace_id: null,
        thread_key: null,
        lifecycle: 'idle',
        status: 'active',
        current_phase: null,
        backend: 'claude-code',
        model: null,
        backend_session_id: null,
        claude_session_id: null,
        working_dir: null,
        context: null,
        started_at: '2026-03-25T08:00:00.000Z',
        ended_at: null,
        summary: null,
        updated_at: '2026-03-25T08:00:00.000Z',
        message_count: 5,
        token_count: 1000,
        metadata: {},
        compacting_since: null,
      };

      const { supabase, filters } = createMockSupabase([contactRow]);
      const repo = new SessionRepository(supabase as never);

      const session = await repo.findByUserAndAgent('user-1', 'myra', {
        contactId: 'contact-alice',
      });

      expect(session).not.toBeNull();
      expect(session!.contactId).toBe('contact-alice');

      // Verify contact_id filter was applied
      const eqCalls = filters.filter((f) => f.method === 'eq');
      const contactFilter = eqCalls.find(
        (f) => f.args[0] === 'contact_id' && f.args[1] === 'contact-alice'
      );
      expect(contactFilter).toBeDefined();
    });

    it('should return null when no session matches the contact_id', async () => {
      const { supabase } = createMockSupabase([]);
      // Override single to return not found
      const builder = supabase.from();
      builder.then = (resolve: (value: unknown) => void) => {
        resolve({ data: [], error: null });
        return Promise.resolve({ data: [], error: null });
      };

      const repo = new SessionRepository(supabase as never);
      const session = await repo.findByUserAndAgent('user-1', 'myra', {
        contactId: 'contact-unknown',
      });

      expect(session).toBeNull();
    });

    it('should not filter by contact_id when options not provided (backward compat)', async () => {
      const { supabase, filters } = createMockSupabase();
      const repo = new SessionRepository(supabase as never);

      // No options at all — backward compatible, no contact filtering
      await repo.findByUserAndAgent('user-1', 'myra');

      const contactEqFilters = filters.filter(
        (f) => f.method === 'eq' && f.args[0] === 'contact_id'
      );
      const contactIsFilters = filters.filter(
        (f) => f.method === 'is' && f.args[0] === 'contact_id'
      );
      expect(contactEqFilters).toHaveLength(0);
      expect(contactIsFilters).toHaveLength(0);
    });

    it('should filter for contact_id IS NULL when contactId explicitly undefined (owner session)', async () => {
      const { supabase, filters } = createMockSupabase();
      const repo = new SessionRepository(supabase as never);

      // Owner session: contactId key is present but undefined → filter IS NULL
      // This is how session-service calls it for owner requests
      await repo.findByUserAndAgent('user-1', 'myra', { contactId: undefined });

      const contactIsNull = filters.find(
        (f) => f.method === 'is' && f.args[0] === 'contact_id' && f.args[1] === null
      );
      expect(contactIsNull).toBeDefined();
    });
  });

  describe('SessionRepository.findByThreadKey with contactId', () => {
    it('should include contact_id filter in thread key lookup', async () => {
      const { supabase, filters } = createMockSupabase();
      const repo = new SessionRepository(supabase as never);

      await repo.findByThreadKey('user-1', 'myra', 'thread:billsplit', undefined, 'contact-alice');

      const contactFilter = filters.find(
        (f) => f.method === 'eq' && f.args[0] === 'contact_id' && f.args[1] === 'contact-alice'
      );
      expect(contactFilter).toBeDefined();
    });
  });

  describe('Session contactId mapping', () => {
    it('should map contact_id from DB row to Session.contactId', async () => {
      const rowWithContact = {
        id: 'sess-1',
        user_id: 'user-1',
        agent_id: 'myra',
        contact_id: 'contact-bob',
        identity_id: null,
        studio_id: null,
        workspace_id: null,
        thread_key: null,
        lifecycle: 'idle',
        status: 'active',
        current_phase: null,
        backend: 'claude-code',
        model: null,
        backend_session_id: null,
        claude_session_id: null,
        working_dir: null,
        context: null,
        started_at: '2026-03-25T08:00:00.000Z',
        ended_at: null,
        summary: null,
        updated_at: '2026-03-25T08:00:00.000Z',
        message_count: 0,
        token_count: 0,
        metadata: {},
        compacting_since: null,
      };

      const { supabase } = createMockSupabase([rowWithContact]);
      const repo = new SessionRepository(supabase as never);

      const session = await repo.findById('sess-1');
      expect(session).not.toBeNull();
      expect(session!.contactId).toBe('contact-bob');
    });

    it('should map null contact_id to undefined (owner session)', async () => {
      const rowWithoutContact = {
        id: 'sess-1',
        user_id: 'user-1',
        agent_id: 'wren',
        contact_id: null,
        identity_id: null,
        studio_id: null,
        workspace_id: null,
        thread_key: null,
        lifecycle: 'running',
        status: 'active',
        current_phase: null,
        backend: 'claude-code',
        model: null,
        backend_session_id: 'abc123',
        claude_session_id: null,
        working_dir: null,
        context: null,
        started_at: '2026-03-25T08:00:00.000Z',
        ended_at: null,
        summary: null,
        updated_at: '2026-03-25T08:00:00.000Z',
        message_count: 10,
        token_count: 5000,
        metadata: {},
        compacting_since: null,
      };

      const { supabase } = createMockSupabase([rowWithoutContact]);
      const repo = new SessionRepository(supabase as never);

      const session = await repo.findById('sess-1');
      expect(session).not.toBeNull();
      expect(session!.contactId).toBeUndefined();
    });
  });

  describe('Session creation with contactId', () => {
    it('should include contact_id in insert payload', async () => {
      const { supabase, filters } = createMockSupabase();
      const repo = new SessionRepository(supabase as never);

      await repo.create({
        userId: 'user-1',
        agentId: 'myra',
        contactId: 'contact-alice',
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
      });

      // Verify insert was called with contact_id
      const insertCalls = filters.filter((f) => f.method === 'insert');
      expect(insertCalls.length).toBeGreaterThan(0);
      const insertPayload = insertCalls[0].args[0] as Record<string, unknown>;
      expect(insertPayload.contact_id).toBe('contact-alice');
    });

    it('should set contact_id to null for owner sessions', async () => {
      const { supabase, filters } = createMockSupabase();
      const repo = new SessionRepository(supabase as never);

      await repo.create({
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
      });

      const insertCalls = filters.filter((f) => f.method === 'insert');
      const insertPayload = insertCalls[0].args[0] as Record<string, unknown>;
      expect(insertPayload.contact_id).toBeNull();
    });
  });
});
