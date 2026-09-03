/**
 * Reminder Handler Tests
 *
 * Regression tests for:
 * - User-scoped identity resolution (cross-tenant safety)
 * - Unknown agentId handling in list_reminders
 * - Direct sbId validation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock: logger ───
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Mock: env ───
vi.mock('../../config/env.js', () => ({
  env: {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-secret-key',
  },
}));

// ─── Mock: user-resolver ───
// NOTE: vi.mock is hoisted, so we must use literal values here
vi.mock('../../services/user-resolver.js', () => ({
  resolveUser: vi.fn().mockResolvedValue({
    user: {
      id: '00000000-0000-0000-0000-000000000001',
      telegram_id: 123456789,
      whatsapp_id: null,
      email: 'test@example.com',
    },
    resolvedBy: 'userId',
  }),
}));

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_USER_ID = '00000000-0000-0000-0000-000000000099';

// ─── Mock: Supabase ───
// Track queries per table with result queue
const queryResultQueues = new Map<string, Array<{ data: unknown; error: unknown }>>();

function setQueryResult(table: string, data: unknown, error: unknown = null) {
  if (!queryResultQueues.has(table)) queryResultQueues.set(table, []);
  queryResultQueues.get(table)!.push({ data, error });
}

function getNextResult(table: string): { data: unknown; error: unknown } {
  const queue = queryResultQueues.get(table);
  if (!queue || queue.length === 0) return { data: null, error: null };
  return queue.length === 1 ? queue[0] : queue.shift()!;
}

// Track eq() calls to verify user scoping
const eqCalls: Array<{ table: string; column: string; value: unknown }> = [];

function createChainableQueryBuilder(table: string) {
  const builder: Record<string, unknown> = {};

  const chainable = [
    'select',
    'insert',
    'update',
    'delete',
    'upsert',
    'neq',
    'lte',
    'gte',
    'lt',
    'gt',
    'in',
    'is',
    'or',
    'order',
    'limit',
    'range',
    'ilike',
    'like',
  ];

  for (const method of chainable) {
    builder[method] = vi.fn().mockReturnValue(builder);
  }

  // Track eq() calls for assertion
  builder.eq = vi.fn().mockImplementation((column: string, value: unknown) => {
    eqCalls.push({ table, column, value });
    return builder;
  });

  builder.single = vi.fn().mockImplementation(() => Promise.resolve(getNextResult(table)));

  // The quiet-hours advisory reads heartbeat_state with maybeSingle. Without it
  // the call throws and lands in the advisory's catch, so the response was never
  // exercised — the warning could have been silently absent and every test would
  // still have passed (Lumen, PR #568).
  builder.maybeSingle = vi.fn().mockImplementation(() => Promise.resolve(getNextResult(table)));

  builder.then = (resolve: (value: unknown) => void, reject?: (reason: unknown) => void) => {
    const result = getNextResult(table);
    if (result.error && reject) {
      reject(result);
    } else {
      resolve(result);
    }
    return Promise.resolve(result);
  };

  return builder;
}

const tableBuilders = new Map<string, ReturnType<typeof createChainableQueryBuilder>>();

function getBuilder(table: string) {
  if (!tableBuilders.has(table)) {
    tableBuilders.set(table, createChainableQueryBuilder(table));
  }
  return tableBuilders.get(table)!;
}

const mockSupabase = {
  from: vi.fn((table: string) => getBuilder(table)),
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => mockSupabase),
}));

// ─── Import module under test AFTER mocks ───
import {
  handleCreateReminder,
  handleListReminders,
  handleUpdateReminder,
} from './reminder-handlers.js';

// Mock DataComposer (not used by handlers, they create their own supabase client)
const mockDataComposer = {} as Parameters<typeof handleCreateReminder>[1];

// ─── Helpers ───
const MYRA_IDENTITY_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_IDENTITY_ID = '22222222-2222-2222-2222-222222222222';

function parseResponse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

// ─── Tests ───
describe('Reminder Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResultQueues.clear();
    tableBuilders.clear();
    eqCalls.length = 0;
  });

  // ═══════════════════════════════════════════════════════════════
  // User-scoped identity resolution
  // ═══════════════════════════════════════════════════════════════
  describe('User-scoped identity resolution', () => {
    it('create_reminder: scopes agentId lookup by user_id', async () => {
      // Identity lookup returns result for this user
      setQueryResult('agent_identities', { id: MYRA_IDENTITY_ID });
      // Insert succeeds
      setQueryResult('scheduled_reminders', {
        id: 'rem-001',
        title: 'Test',
        description: null,
        sb_id: MYRA_IDENTITY_ID,
        delivery_channel: 'telegram',
        delivery_target: '123456789',
        cron_expression: null,
        next_run_at: new Date().toISOString(),
        status: 'active',
      });

      await handleCreateReminder(
        {
          userId: TEST_USER_ID,
          title: 'Test reminder',
          agentId: 'myra',
        },
        mockDataComposer
      );

      // Verify the agent_identities lookup included user_id scope
      const identityEqs = eqCalls.filter((c) => c.table === 'agent_identities');
      expect(identityEqs).toContainEqual({
        table: 'agent_identities',
        column: 'user_id',
        value: TEST_USER_ID,
      });
      expect(identityEqs).toContainEqual({
        table: 'agent_identities',
        column: 'agent_id',
        value: 'myra',
      });
    });

    it('create_reminder: rejects agentId not owned by this user', async () => {
      // Identity lookup returns null (not found for this user)
      setQueryResult('agent_identities', null);

      const result = await handleCreateReminder(
        {
          userId: TEST_USER_ID,
          title: 'Test reminder',
          agentId: 'myra',
        },
        mockDataComposer
      );

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Unknown agent');
      expect(parsed.error).toContain('for this user');
    });

    it('create_reminder: validates direct sbId belongs to user', async () => {
      // sbId ownership check returns null (not owned)
      setQueryResult('agent_identities', null);

      const result = await handleCreateReminder(
        {
          userId: TEST_USER_ID,
          title: 'Test reminder',
          sbId: OTHER_IDENTITY_ID,
        },
        mockDataComposer
      );

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('does not belong to this user');

      // Verify lookup was scoped to user
      const identityEqs = eqCalls.filter((c) => c.table === 'agent_identities');
      expect(identityEqs).toContainEqual({
        table: 'agent_identities',
        column: 'id',
        value: OTHER_IDENTITY_ID,
      });
      expect(identityEqs).toContainEqual({
        table: 'agent_identities',
        column: 'user_id',
        value: TEST_USER_ID,
      });
    });

    it('create_reminder: accepts valid direct sbId owned by user', async () => {
      // sbId ownership check passes
      setQueryResult('agent_identities', { id: MYRA_IDENTITY_ID });
      // Insert succeeds
      setQueryResult('scheduled_reminders', {
        id: 'rem-001',
        title: 'Test',
        description: null,
        sb_id: MYRA_IDENTITY_ID,
        delivery_channel: 'telegram',
        delivery_target: '123456789',
        cron_expression: null,
        next_run_at: new Date().toISOString(),
        status: 'active',
      });

      const result = await handleCreateReminder(
        {
          userId: TEST_USER_ID,
          title: 'Test reminder',
          sbId: MYRA_IDENTITY_ID,
        },
        mockDataComposer
      );

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
    });

    it('list_reminders: scopes agentId lookup by user_id', async () => {
      // Identity lookup returns result for this user
      setQueryResult('agent_identities', { id: MYRA_IDENTITY_ID });
      // Query returns reminders
      setQueryResult('scheduled_reminders', []);

      await handleListReminders(
        {
          userId: TEST_USER_ID,
          agentId: 'myra',
        },
        mockDataComposer
      );

      // Verify the agent_identities lookup included user_id scope
      const identityEqs = eqCalls.filter((c) => c.table === 'agent_identities');
      expect(identityEqs).toContainEqual({
        table: 'agent_identities',
        column: 'user_id',
        value: TEST_USER_ID,
      });
    });

    it('update_reminder: scopes agentId lookup by user_id', async () => {
      // Existing reminder check
      setQueryResult('scheduled_reminders', {
        id: 'rem-001',
        title: 'Existing',
        user_id: TEST_USER_ID,
        status: 'active',
      });
      // Identity lookup (scoped)
      setQueryResult('agent_identities', { id: MYRA_IDENTITY_ID });
      // Update succeeds
      setQueryResult('scheduled_reminders', {
        id: 'rem-001',
        title: 'Existing',
        sb_id: MYRA_IDENTITY_ID,
        cron_expression: null,
        next_run_at: new Date().toISOString(),
        status: 'active',
      });

      await handleUpdateReminder(
        {
          userId: TEST_USER_ID,
          reminderId: 'rem-001',
          agentId: 'lumen',
        },
        mockDataComposer
      );

      // Verify the agent_identities lookup included user_id scope
      const identityEqs = eqCalls.filter((c) => c.table === 'agent_identities');
      expect(identityEqs).toContainEqual({
        table: 'agent_identities',
        column: 'user_id',
        value: TEST_USER_ID,
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Unknown agentId handling
  // ═══════════════════════════════════════════════════════════════
  describe('Unknown agentId handling', () => {
    it('list_reminders: returns empty set with hint for unknown agentId', async () => {
      // Identity lookup returns null (unknown agent)
      setQueryResult('agent_identities', null);

      const result = await handleListReminders(
        {
          userId: TEST_USER_ID,
          agentId: 'nonexistent-agent',
        },
        mockDataComposer
      );

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.reminders).toEqual([]);
      expect(parsed.hint).toContain('nonexistent-agent');
      expect(parsed.hint).toContain('No agent');
    });

    it('list_reminders: does NOT silently return all reminders for unknown agent', async () => {
      // Identity lookup returns null
      setQueryResult('agent_identities', null);
      // Reminders query should NOT be reached
      setQueryResult('scheduled_reminders', [
        { id: 'rem-001', title: 'Should not appear', status: 'active' },
      ]);

      const result = await handleListReminders(
        {
          userId: TEST_USER_ID,
          agentId: 'nonexistent-agent',
        },
        mockDataComposer
      );

      const parsed = parseResponse(result);
      // Should return empty, NOT the reminders from scheduled_reminders
      expect(parsed.reminders).toEqual([]);
    });

    it('create_reminder: returns error for unknown agentId', async () => {
      setQueryResult('agent_identities', null);

      const result = await handleCreateReminder(
        {
          userId: TEST_USER_ID,
          title: 'Test',
          agentId: 'nonexistent-agent',
        },
        mockDataComposer
      );

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Unknown agent');
    });

    it('update_reminder: returns error for unknown agentId', async () => {
      // Existing reminder found
      setQueryResult('scheduled_reminders', {
        id: 'rem-001',
        title: 'Existing',
        user_id: TEST_USER_ID,
        status: 'active',
      });
      // Identity lookup returns null
      setQueryResult('agent_identities', null);

      const result = await handleUpdateReminder(
        {
          userId: TEST_USER_ID,
          reminderId: 'rem-001',
          agentId: 'nonexistent-agent',
        },
        mockDataComposer
      );

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Unknown agent');
    });
  });
});

/**
 * The quiet-hours advisory, through the actual handler response (Lumen, P2).
 *
 * The predicate has its own suite. What was NOT covered is that create_reminder
 * puts it on the wire, and that the runAt guard holds — and it could not be,
 * because the fixture lacked maybeSingle so every call fell into the advisory's
 * catch. The warning could have been silently absent and every test still green.
 */
describe('create_reminder quiet-hours advisory', () => {
  // Its own reset. This suite sits outside the parent describe, so the parent's
  // beforeEach never applied and shared queues, builders and call history leaked
  // in and between these tests (Lumen, PR #568 round 3).
  beforeEach(() => {
    vi.clearAllMocks();
    queryResultQueues.clear();
    tableBuilders.clear();
    eqCalls.length = 0;
  });

  const REMINDER_ROW = {
    id: 'r1',
    title: 'Spravato prep',
    description: null,
    sb_id: null,
    delivery_channel: 'telegram',
    delivery_target: '726555973',
    cron_expression: null,
    next_run_at: '2026-09-02T14:30:00+00:00',
    studio_hint: null,
    status: 'active',
  };

  function primeQuietHours() {
    // The DB shape: Postgres `time` columns, HH:MM:SS.
    setQueryResult('heartbeat_state', {
      quiet_start: '22:00:00',
      quiet_end: '08:00:00',
      timezone: 'America/Los_Angeles',
    });
  }

  it('returns a quietHours warning for a one-shot inside the window', async () => {
    primeQuietHours();
    setQueryResult('scheduled_reminders', REMINDER_ROW);

    const result = await handleCreateReminder(
      {
        userId: TEST_USER_ID,
        title: 'Spravato prep',
        runAt: '2026-09-02T14:30:00Z', // 07:30 PDT — held
      } as never,
      mockDataComposer as never
    );

    const parsed = parseResponse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.quietHours).toBeDefined();
    expect(parsed.quietHours.deferredTo).toBe('2026-09-02T15:00:00.000Z');
    expect(parsed.quietHours.message).toContain('Scheduling it earlier does not help');
  });

  it('says nothing for a one-shot outside the window', async () => {
    primeQuietHours();
    setQueryResult('scheduled_reminders', REMINDER_ROW);

    const result = await handleCreateReminder(
      {
        userId: TEST_USER_ID,
        title: 'Afternoon nudge',
        runAt: '2026-09-02T20:00:00Z', // 13:00 PDT — fine
      } as never,
      mockDataComposer as never
    );

    expect(parseResponse(result).quietHours).toBeUndefined();
  });

  /**
   * The guard I claimed in review before enforcing — now asserted on the guard
   * itself rather than on a downstream symptom.
   *
   * The first version checked only that no warning came back, which passes in
   * CI for the wrong reason: `0 0 * * *` resolves through a server-LOCAL
   * calculator, so under TZ=UTC the next run is 00:00Z = 17:00 PDT, outside the
   * LA window. Lumen mutated the guard to `if (true)`, ran under TZ=UTC, and it
   * still passed. My own red-check had only ever run in my own timezone —
   * "verified red" is not a property of a test on its own.
   *
   * Asserting that heartbeat_state is never consulted is environment-free: it
   * is true of the guard regardless of what time the calculator lands on.
   */
  it('never even looks up quiet hours for a cron reminder', async () => {
    primeQuietHours();
    setQueryResult('scheduled_reminders', { ...REMINDER_ROW, cron_expression: '0 0 * * *' });

    const result = await handleCreateReminder(
      { userId: TEST_USER_ID, title: 'Nightly', cronExpression: '0 0 * * *' } as never,
      mockDataComposer as never
    );

    expect(parseResponse(result).success).toBe(true);
    expect(mockSupabase.from).not.toHaveBeenCalledWith('heartbeat_state');
    expect(eqCalls.some((c) => c.table === 'heartbeat_state')).toBe(false);
  });

  it('never looks up quiet hours for the default no-schedule path either', async () => {
    primeQuietHours();
    setQueryResult('scheduled_reminders', REMINDER_ROW);

    await handleCreateReminder(
      { userId: TEST_USER_ID, title: 'Whenever' } as never,
      mockDataComposer as never
    );

    expect(mockSupabase.from).not.toHaveBeenCalledWith('heartbeat_state');
  });

  it('DOES look it up for a one-shot — the control for the two above', async () => {
    primeQuietHours();
    setQueryResult('scheduled_reminders', REMINDER_ROW);

    await handleCreateReminder(
      { userId: TEST_USER_ID, title: 'Prep', runAt: '2026-09-02T14:30:00Z' } as never,
      mockDataComposer as never
    );

    expect(mockSupabase.from).toHaveBeenCalledWith('heartbeat_state');
  });
});
