import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CronExpressionParser } from 'cron-parser';

// ─── Mock: logger ───
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Mock: node-cron ───
vi.mock('node-cron', () => ({
  schedule: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

// ─── Mock: env ───
vi.mock('../config/env.js', () => ({
  env: {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-secret-key',
  },
}));

// ─── Mock: Supabase ───
// Queue-based result system: each table gets a FIFO queue of responses.
// When there's only one response for a table, it's reused for all calls.
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

function createChainableQueryBuilder(table: string) {
  const builder: Record<string, unknown> = {};

  const chainable = [
    'select',
    'insert',
    'update',
    'delete',
    'upsert',
    'eq',
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
    'filter',
    'contains',
  ];

  for (const method of chainable) {
    builder[method] = vi.fn().mockReturnValue(builder);
  }

  builder.single = vi.fn().mockImplementation(() => Promise.resolve(getNextResult(table)));

  // Make the builder thenable so `await supabase.from(...).select(...)` works
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

// Cache builders per table so we can inspect mock calls
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
import * as cron from 'node-cron';
import {
  initHeartbeatService,
  stopHeartbeatService,
  processHeartbeat,
  createReminder,
  ensureDefaultReminders,
} from './heartbeat.js';

// ─── Helpers ───
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

/** The escalation context of the first beat to reach a destination in a run. */
/**
 * Matcher for the context handed to a hook that is first to its destination.
 *
 * Partial on purpose: `episodeKey` is a timestamp and `destination` is null for
 * a beat with no owning SB, so pinning either exactly would assert facts about
 * the fixture rather than about the collapse rule under test.
 */
const FIRST_FOR_DESTINATION = expect.objectContaining({ destinationAlreadyAlerted: false });

/** A hook that reports a notice actually reached the human. */
const ALERTED = { alerted: true };

function makeDueReminder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rem-001',
    user_id: TEST_USER_ID,
    title: 'Check emails',
    description: 'Check for important emails and summarize',
    delivery_channel: 'telegram',
    delivery_target: '123456789',
    cron_expression: '0 * * * *',
    next_run_at: new Date(Date.now() - 60_000).toISOString(),
    run_count: 0,
    max_runs: null,
    status: 'active',
    ...overrides,
  };
}

// ─── Tests ───
describe('Heartbeat Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResultQueues.clear();
    tableBuilders.clear();

    // Default: no quiet hours
    setQueryResult('heartbeat_state', null);
    // Default: history inserts succeed (return value not checked)
    setQueryResult('reminder_history', { id: 'hist-001' });
  });

  afterEach(() => {
    stopHeartbeatService();
  });

  // ═══════════════════════════════════════════════════════════════
  // Cron parsing regression tests
  // ═══════════════════════════════════════════════════════════════
  describe('calculateNextRun (cron-parser integration)', () => {
    // All pure cron-parser tests use tz:'UTC' for deterministic behavior.
    // Without explicit tz, cron-parser uses the system's local timezone.

    it('should correctly parse complex cron: 0 16-23,0-7 * * *', () => {
      const cronExpr = '0 16-23,0-7 * * *';

      const midDay = new Date('2026-02-04T12:30:00Z');
      const interval = CronExpressionParser.parse(cronExpr, { currentDate: midDay, tz: 'UTC' });
      const next = interval.next().toDate();

      expect(next.getUTCHours()).toBe(16);
      expect(next.getUTCMinutes()).toBe(0);
    });

    it('should handle overnight wrap: next run from 23:30 should be 00:00', () => {
      const cronExpr = '0 16-23,0-7 * * *';

      const lateNight = new Date('2026-02-04T23:30:00Z');
      const interval = CronExpressionParser.parse(cronExpr, { currentDate: lateNight, tz: 'UTC' });
      const next = interval.next().toDate();

      expect(next.getUTCHours()).toBe(0);
      expect(next.getUTCMinutes()).toBe(0);
      expect(next.getUTCDate()).toBe(5);
    });

    it('should produce correct sequences within the active window', () => {
      const cronExpr = '0 16-23,0-7 * * *';

      const evening = new Date('2026-02-04T18:00:00Z');
      const interval = CronExpressionParser.parse(cronExpr, { currentDate: evening, tz: 'UTC' });

      const next1 = interval.next().toDate();
      const next2 = interval.next().toDate();

      expect(next1.getUTCHours()).toBe(19);
      expect(next2.getUTCHours()).toBe(20);
    });

    it('should skip inactive hours (8-15) correctly', () => {
      const cronExpr = '0 16-23,0-7 * * *';

      const morning = new Date('2026-02-04T07:00:00Z');
      const interval = CronExpressionParser.parse(cronExpr, { currentDate: morning, tz: 'UTC' });
      const next = interval.next().toDate();

      expect(next.getUTCHours()).toBe(16);
      expect(next.getUTCDate()).toBe(4);
    });

    it('should calculate correct next_run_at when creating a reminder', async () => {
      setQueryResult('scheduled_reminders', { id: 'rem-new-001' });

      const beforeCreate = new Date();

      await createReminder({
        userId: TEST_USER_ID,
        title: 'Hourly email check',
        deliveryChannel: 'telegram',
        deliveryTarget: '123456789',
        cronExpression: '0 * * * *',
      });

      const builder = tableBuilders.get('scheduled_reminders')!;
      expect(builder.insert).toHaveBeenCalled();

      const insertArgs = (builder.insert as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      const nextRunAt = new Date(insertArgs.next_run_at as string);

      expect(nextRunAt.getTime()).not.toBeNaN();
      expect(nextRunAt.getTime()).toBeGreaterThan(beforeCreate.getTime());
      expect(nextRunAt.getUTCMinutes()).toBe(0);
    });

    it('should handle simple hourly cron', () => {
      const cronExpr = '0 * * * *';
      const now = new Date('2026-02-04T14:15:00Z');
      const interval = CronExpressionParser.parse(cronExpr, { currentDate: now });
      const next = interval.next().toDate();

      expect(next.getUTCHours()).toBe(15);
      expect(next.getUTCMinutes()).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Callback-based delivery tests
  //
  // The heartbeat service is delivery-agnostic. It queries for due
  // reminders and delegates delivery to a caller-provided callback.
  // This means ALL agent wake-ups flow through the same path
  // (sessionHost.handleMessage), regardless of trigger source.
  // ═══════════════════════════════════════════════════════════════
  describe('processHeartbeat - callback-based delivery', () => {
    it('should call deliver callback for each due reminder', async () => {
      initHeartbeatService({ enableLocalCron: false });

      const reminder = makeDueReminder();
      setQueryResult('scheduled_reminders', [reminder]); // select
      setQueryResult('scheduled_reminders', [{ id: 'rem-001' }]); // claim CAS win

      const mockDeliver = vi.fn().mockResolvedValue(true);
      const stats = await processHeartbeat(mockDeliver);

      expect(stats.delivered).toBe(1);
      expect(stats.failed).toBe(0);
      expect(mockDeliver).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'rem-001',
          title: 'Check emails',
          description: 'Check for important emails and summarize',
          delivery_channel: 'telegram',
        })
      );
    });

    it('should record failure when deliver callback returns false', async () => {
      initHeartbeatService({ enableLocalCron: false });

      const reminder = makeDueReminder();
      setQueryResult('scheduled_reminders', [reminder]);

      const mockDeliver = vi.fn().mockResolvedValue(false);
      const stats = await processHeartbeat(mockDeliver);

      expect(stats.failed).toBe(1);
      expect(stats.delivered).toBe(0);

      const historyBuilder = tableBuilders.get('reminder_history')!;
      expect(historyBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          reminder_id: 'rem-001',
          status: 'failed',
        })
      );
    });

    it('should record failure when deliver callback throws', async () => {
      initHeartbeatService({ enableLocalCron: false });

      const reminder = makeDueReminder();
      setQueryResult('scheduled_reminders', [reminder]);

      const mockDeliver = vi.fn().mockRejectedValue(new Error('Session host unavailable'));
      const stats = await processHeartbeat(mockDeliver);

      expect(stats.failed).toBe(1);
      expect(stats.delivered).toBe(0);

      const historyBuilder = tableBuilders.get('reminder_history')!;
      expect(historyBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          reminder_id: 'rem-001',
          status: 'failed',
          error_message: 'Session host unavailable',
        })
      );
    });

    it('should fail when no deliver callback is provided', async () => {
      initHeartbeatService({ enableLocalCron: false });

      const reminder = makeDueReminder();
      setQueryResult('scheduled_reminders', [reminder]);

      const stats = await processHeartbeat(); // no callback

      expect(stats.failed).toBe(1);
      expect(stats.delivered).toBe(0);
    });

    it('should update recurring reminder with correct next_run_at after delivery', async () => {
      initHeartbeatService({ enableLocalCron: false });

      const reminder = makeDueReminder({
        cron_expression: '0 * * * *',
        run_count: 3,
      });
      setQueryResult('scheduled_reminders', [reminder]); // select
      setQueryResult('scheduled_reminders', [{ id: 'rem-001' }]); // claim CAS win

      const mockDeliver = vi.fn().mockResolvedValue(true);
      const beforeProcess = new Date();
      await processHeartbeat(mockDeliver);

      const builder = tableBuilders.get('scheduled_reminders')!;
      expect(builder.update).toHaveBeenCalled();

      const updateArgs = (builder.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(updateArgs.run_count).toBe(4);

      const nextRunAt = new Date(updateArgs.next_run_at as string);
      expect(nextRunAt.getTime()).not.toBeNaN();
      expect(nextRunAt.getTime()).toBeGreaterThan(beforeProcess.getTime());
      expect(nextRunAt.getUTCMinutes()).toBe(0);
    });

    it('should deliver multiple reminders in sequence', async () => {
      initHeartbeatService({ enableLocalCron: false });

      const reminder1 = makeDueReminder({ id: 'rem-001', title: 'Check emails' });
      const reminder2 = makeDueReminder({ id: 'rem-002', title: 'Daily standup' });
      setQueryResult('scheduled_reminders', [reminder1, reminder2]); // select
      setQueryResult('scheduled_reminders', [{ id: 'claimed' }]); // claim CAS win (reused for both)

      const mockDeliver = vi.fn().mockResolvedValue(true);
      const stats = await processHeartbeat(mockDeliver);

      expect(stats.processed).toBe(2);
      expect(stats.delivered).toBe(2);
      expect(mockDeliver).toHaveBeenCalledTimes(2);
    });

    it('should return empty stats when no reminders are due', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', []);

      const mockDeliver = vi.fn();
      const stats = await processHeartbeat(mockDeliver);

      expect(stats).toEqual({ processed: 0, delivered: 0, failed: 0, skipped: 0 });
      expect(mockDeliver).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ensureDefaultReminders — identity-creation seeding
  // ═══════════════════════════════════════════════════════════════
  describe('ensureDefaultReminders', () => {
    it('should create a daily-checkin reminder for a new identity', async () => {
      // No existing checkin (idempotency check returns empty)
      setQueryResult('scheduled_reminders', []);
      // getUserTimezone returns UTC
      setQueryResult('users', { timezone: null });
      // createReminder insert succeeds
      setQueryResult('scheduled_reminders', { id: 'rem-default-001' });

      await ensureDefaultReminders({
        userId: TEST_USER_ID,
        sbId: 'identity-001',
        agentId: 'wren',
        deliveryChannel: 'telegram',
        deliveryTarget: '123456789',
      });

      const builder = tableBuilders.get('scheduled_reminders')!;
      expect(builder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Daily check-in',
          sb_id: 'identity-001',
          cron_expression: '0 9 * * *',
          delivery_channel: 'telegram',
          delivery_target: '123456789',
          metadata: { autoCreated: true, reminderType: 'daily-checkin' },
        })
      );
    });

    it('should skip if daily-checkin already exists (idempotency)', async () => {
      // Idempotency check finds existing reminder
      setQueryResult('scheduled_reminders', [{ id: 'existing-rem' }]);

      await ensureDefaultReminders({
        userId: TEST_USER_ID,
        sbId: 'identity-001',
        agentId: 'wren',
        deliveryChannel: 'telegram',
        deliveryTarget: '123456789',
      });

      const builder = tableBuilders.get('scheduled_reminders')!;
      expect(builder.insert).not.toHaveBeenCalled();
    });

    it("should skip when the check-in is bound to the agent's OTHER identity row (Sep 10: an unscoped twin handed in as sbId)", async () => {
      // The agent has a scoped real row with a check-in, and an UNSCOPED twin.
      setQueryResult('agent_identities', [
        { id: 'identity-real', workspace_id: 'ws-personal' },
        { id: 'identity-twin', workspace_id: null },
      ]);
      setQueryResult('scheduled_reminders', [{ id: 'existing-rem', sb_id: 'identity-real' }]);

      await ensureDefaultReminders({
        userId: TEST_USER_ID,
        sbId: 'identity-twin',
        agentId: 'myra',
        deliveryChannel: 'telegram',
        deliveryTarget: '123456789',
      });

      const reminders = tableBuilders.get('scheduled_reminders')!;
      expect(reminders.insert).not.toHaveBeenCalled();
      // The guard asked about every identity row of the agent, not just the new one.
      expect(tableBuilders.get('agent_identities')!.eq).toHaveBeenCalledWith('agent_id', 'myra');
      expect(reminders.in).toHaveBeenCalledWith(
        'sb_id',
        expect.arrayContaining(['identity-real', 'identity-twin'])
      );
    });

    it('a scoped sibling in ANOTHER workspace is a distinct SB and gets its own check-in (PR #595, Lumen)', async () => {
      // Same slug in two workspaces; A already has a check-in; B is being seeded.
      setQueryResult('agent_identities', [
        { id: 'identity-a', workspace_id: 'ws-a' },
        { id: 'identity-b', workspace_id: 'ws-b' },
      ]);
      setQueryResult('scheduled_reminders', []); // nothing bound to B (or to an unscoped row)
      setQueryResult('users', { timezone: null });
      setQueryResult('scheduled_reminders', { id: 'rem-b' });

      await ensureDefaultReminders({
        userId: TEST_USER_ID,
        sbId: 'identity-b',
        agentId: 'myra',
        deliveryChannel: 'telegram',
        deliveryTarget: '123456789',
      });

      const reminders = tableBuilders.get('scheduled_reminders')!;
      // The candidate set is B alone — A's check-in must not suppress B's.
      expect(reminders.in).toHaveBeenCalledWith('sb_id', ['identity-b']);
      expect(reminders.insert).toHaveBeenCalledWith(
        expect.objectContaining({ sb_id: 'identity-b' })
      );
    });

    it("a scoped sibling is judged on its own UUID even when an unscoped twin holds a reminder (PR #595, Lumen's sixth check)", async () => {
      // A (scoped) + an unscoped twin with a paused reminder + new scoped B.
      setQueryResult('agent_identities', [
        { id: 'identity-a', workspace_id: 'ws-a' },
        { id: 'identity-twin', workspace_id: null },
        { id: 'identity-b', workspace_id: 'ws-b' },
      ]);
      setQueryResult('scheduled_reminders', []); // nothing bound to B itself
      setQueryResult('users', { timezone: null });
      setQueryResult('scheduled_reminders', { id: 'rem-b' });

      await ensureDefaultReminders({
        userId: TEST_USER_ID,
        sbId: 'identity-b',
        agentId: 'myra',
        deliveryChannel: 'telegram',
        deliveryTarget: '123456789',
      });

      const reminders = tableBuilders.get('scheduled_reminders')!;
      expect(reminders.in).toHaveBeenCalledWith('sb_id', ['identity-b']);
      expect(reminders.insert).toHaveBeenCalledWith(
        expect.objectContaining({ sb_id: 'identity-b' })
      );
    });

    it('an unscoped row among several scoped siblings is ambiguous: skip seeding, do not guess', async () => {
      setQueryResult('agent_identities', [
        { id: 'identity-a', workspace_id: 'ws-a' },
        { id: 'identity-b', workspace_id: 'ws-b' },
        { id: 'identity-twin', workspace_id: null },
      ]);

      await ensureDefaultReminders({
        userId: TEST_USER_ID,
        sbId: 'identity-twin',
        agentId: 'myra',
        deliveryChannel: 'telegram',
        deliveryTarget: '123456789',
      });

      // The guard returned before touching scheduled_reminders at all.
      expect(tableBuilders.get('scheduled_reminders')).toBeUndefined();
    });

    it('should resolve delivery channel from user when not pre-resolved', async () => {
      // User lookup returns telegram_id
      setQueryResult('users', { telegram_id: '987654321', whatsapp_id: null });
      // Idempotency check returns empty
      setQueryResult('scheduled_reminders', []);
      // getUserTimezone
      setQueryResult('users', { timezone: null });
      // createReminder insert succeeds
      setQueryResult('scheduled_reminders', { id: 'rem-default-002' });

      await ensureDefaultReminders({
        userId: TEST_USER_ID,
        sbId: 'identity-002',
        agentId: 'myra',
        // No deliveryChannel/deliveryTarget — should resolve from user
      });

      const builder = tableBuilders.get('scheduled_reminders')!;
      expect(builder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          delivery_channel: 'telegram',
          delivery_target: '987654321',
        })
      );
    });

    it('should skip if no delivery channel available', async () => {
      // User has neither telegram nor whatsapp
      setQueryResult('users', { telegram_id: null, whatsapp_id: null });

      await ensureDefaultReminders({
        userId: TEST_USER_ID,
        sbId: 'identity-003',
        agentId: 'wren',
      });

      // No scheduled_reminders queries should happen at all
      const builder = tableBuilders.get('scheduled_reminders');
      expect(builder).toBeUndefined();
    });

    it('should not throw on database errors', async () => {
      // User lookup fails
      setQueryResult('users', null, { message: 'Connection refused' });

      await expect(
        ensureDefaultReminders({
          userId: TEST_USER_ID,
          sbId: 'identity-004',
          agentId: 'wren',
        })
      ).resolves.toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Concurrency guard — regression test for PR #397
  //
  // node-cron fires ticks regardless of whether the previous callback
  // is still running. Without the heartbeatRunning guard, concurrent
  // ticks find the same reminder due (next_run_at not yet advanced)
  // and queue 67+ duplicate deliveries. This test verifies the guard.
  // ═══════════════════════════════════════════════════════════════
  describe('Cron concurrency guard (heartbeatRunning flag)', () => {
    it('should skip a cron tick when the previous tick is still running', async () => {
      let resolveFirstTick: () => void;
      const firstTickBlocking = new Promise<void>((resolve) => {
        resolveFirstTick = resolve;
      });

      const tickLog: string[] = [];
      const onHeartbeat = vi.fn().mockImplementation(async () => {
        tickLog.push('tick-start');
        await firstTickBlocking;
        tickLog.push('tick-end');
      });

      initHeartbeatService({ enableLocalCron: true, onHeartbeat });

      // Capture the callback registered with cron.schedule
      const cronCallback = vi.mocked(cron.schedule).mock.calls[0][1] as () => Promise<void>;

      // Fire tick 1 — starts and blocks
      const tick1 = cronCallback();

      // Fire tick 2 while tick 1 is still running — should be skipped
      const tick2 = cronCallback();

      // Unblock tick 1
      resolveFirstTick!();
      await tick1;
      await tick2;

      // Only one actual tick should have run
      expect(tickLog).toEqual(['tick-start', 'tick-end']);
      expect(onHeartbeat).toHaveBeenCalledTimes(1);
    });

    it('should allow a new tick after the previous one completes', async () => {
      const tickLog: string[] = [];
      const onHeartbeat = vi.fn().mockImplementation(async () => {
        tickLog.push(`tick-${tickLog.length + 1}`);
      });

      initHeartbeatService({ enableLocalCron: true, onHeartbeat });

      const cronCallback = vi.mocked(cron.schedule).mock.calls[0][1] as () => Promise<void>;

      // Fire tick 1 — completes
      await cronCallback();
      // Fire tick 2 — should run since tick 1 is done
      await cronCallback();

      expect(tickLog).toEqual(['tick-1', 'tick-2']);
      expect(onHeartbeat).toHaveBeenCalledTimes(2);
    });

    it('should reset the running flag even when onHeartbeat throws', async () => {
      const onHeartbeat = vi
        .fn()
        .mockRejectedValueOnce(new Error('DB down'))
        .mockResolvedValueOnce(undefined);

      initHeartbeatService({ enableLocalCron: true, onHeartbeat });

      const cronCallback = vi.mocked(cron.schedule).mock.calls[0][1] as () => Promise<void>;

      // Tick 1: fails — should still reset heartbeatRunning
      await cronCallback();
      // Tick 2: should run (not permanently blocked by failed tick 1)
      await cronCallback();

      expect(onHeartbeat).toHaveBeenCalledTimes(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // At-most-once delivery — regression test for PR #397
  //
  // If next_run_at is advanced only AFTER delivery, a slow delivery
  // (20+ min) lets the next cron tick find the same reminder due
  // and queue a duplicate. By advancing BEFORE deliver(), the
  // reminder becomes invisible to concurrent ticks immediately.
  // ═══════════════════════════════════════════════════════════════
  describe('At-most-once delivery (advance next_run_at before deliver)', () => {
    it('should update next_run_at BEFORE calling deliver callback', async () => {
      initHeartbeatService({ enableLocalCron: false });

      const reminder = makeDueReminder({ cron_expression: '0 * * * *' });
      setQueryResult('scheduled_reminders', [reminder]); // select due reminders
      setQueryResult('scheduled_reminders', [{ id: 'rem-001' }]); // claim CAS win (advance next_run_at)
      setQueryResult('users', { timezone: null }); // getUserTimezone

      let updateCalledBeforeDeliver = false;

      const mockDeliver = vi.fn().mockImplementation(async () => {
        const builder = tableBuilders.get('scheduled_reminders')!;
        const updateCalls = (builder.update as ReturnType<typeof vi.fn>).mock.calls;
        updateCalledBeforeDeliver = updateCalls.length > 0;
        return true;
      });

      await processHeartbeat(mockDeliver);

      expect(mockDeliver).toHaveBeenCalledTimes(1);
      expect(updateCalledBeforeDeliver).toBe(true);
    });

    it('should still advance next_run_at even when deliver fails', async () => {
      initHeartbeatService({ enableLocalCron: false });

      const reminder = makeDueReminder({ cron_expression: '0 * * * *' });
      setQueryResult('scheduled_reminders', [reminder]);
      setQueryResult('scheduled_reminders', [{ id: 'rem-001' }]); // claim CAS win
      setQueryResult('users', { timezone: null });

      const mockDeliver = vi.fn().mockResolvedValue(false);
      await processHeartbeat(mockDeliver);

      const builder = tableBuilders.get('scheduled_reminders')!;
      const updateCalls = (builder.update as ReturnType<typeof vi.fn>).mock.calls;
      expect(updateCalls.length).toBeGreaterThan(0);

      const updateArgs = updateCalls[0][0] as Record<string, unknown>;
      expect(updateArgs.next_run_at).toBeDefined();
      expect(updateArgs.run_count).toBe(1);
    });

    it('should still advance next_run_at even when deliver throws', async () => {
      initHeartbeatService({ enableLocalCron: false });

      const reminder = makeDueReminder({ cron_expression: '0 * * * *' });
      setQueryResult('scheduled_reminders', [reminder]);
      setQueryResult('scheduled_reminders', [{ id: 'rem-001' }]); // claim CAS win
      setQueryResult('users', { timezone: null });

      const mockDeliver = vi.fn().mockRejectedValue(new Error('Session host down'));
      await processHeartbeat(mockDeliver);

      const builder = tableBuilders.get('scheduled_reminders')!;
      const updateCalls = (builder.update as ReturnType<typeof vi.fn>).mock.calls;
      expect(updateCalls.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Cross-process at-most-once — atomic CAS claim
  //
  // The heartbeatRunning flag only guards ONE process. When multiple
  // server incarnations overlap (e.g. a tsx-watch reload that hasn't
  // reaped the old server), each runs processHeartbeat on the same tick
  // and fetches the same due reminder. The claim's compare-and-swap on
  // next_run_at is what makes delivery at-most-once ACROSS processes:
  // only the caller whose UPDATE matches a row (1 row returned) delivers;
  // the losers match 0 rows and skip. Regression for the duplicate
  // heartbeat sessions + 2-3x Telegram sends observed 2026-07-13.
  // ═══════════════════════════════════════════════════════════════
  describe('Cross-process at-most-once (atomic CAS claim)', () => {
    it('should deliver when the CAS claim is won (1 row updated)', async () => {
      initHeartbeatService({ enableLocalCron: false });

      const reminder = makeDueReminder({ cron_expression: '0 * * * *' });
      setQueryResult('scheduled_reminders', [reminder]); // select due
      setQueryResult('scheduled_reminders', [{ id: 'rem-001' }]); // claim: 1 row → win
      setQueryResult('users', { timezone: null });

      const mockDeliver = vi.fn().mockResolvedValue(true);
      const stats = await processHeartbeat(mockDeliver);

      expect(mockDeliver).toHaveBeenCalledTimes(1);
      expect(stats.delivered).toBe(1);
      expect(stats.skipped).toBe(0);
    });

    it('should NOT deliver when the CAS claim is lost (0 rows updated)', async () => {
      initHeartbeatService({ enableLocalCron: false });

      const reminder = makeDueReminder({ cron_expression: '0 * * * *' });
      setQueryResult('scheduled_reminders', [reminder]); // select due
      setQueryResult('scheduled_reminders', []); // claim: 0 rows → another instance won
      setQueryResult('users', { timezone: null });

      const mockDeliver = vi.fn().mockResolvedValue(true);
      const stats = await processHeartbeat(mockDeliver);

      // The whole point: a concurrent incarnation already claimed this beat,
      // so this process must NOT deliver a duplicate.
      expect(mockDeliver).not.toHaveBeenCalled();
      expect(stats.delivered).toBe(0);
      expect(stats.skipped).toBe(1);
    });

    it('should guard the CAS on the fetched next_run_at (optimistic lock)', async () => {
      initHeartbeatService({ enableLocalCron: false });

      const fetchedNextRun = new Date(Date.now() - 60_000).toISOString();
      const reminder = makeDueReminder({
        cron_expression: '0 * * * *',
        next_run_at: fetchedNextRun,
      });
      setQueryResult('scheduled_reminders', [reminder]); // select due
      setQueryResult('scheduled_reminders', [{ id: 'rem-001' }]); // claim win
      setQueryResult('users', { timezone: null });

      const mockDeliver = vi.fn().mockResolvedValue(true);
      await processHeartbeat(mockDeliver);

      // The claim UPDATE must be scoped by BOTH id and the exact next_run_at we
      // read — that equality guard is what fails the update for a stale loser.
      const builder = tableBuilders.get('scheduled_reminders')!;
      const eqCalls = (builder.eq as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(eqCalls).toContain('id');
      expect(eqCalls).toContain('next_run_at');

      const eqNextRunCall = (builder.eq as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === 'next_run_at'
      );
      expect(eqNextRunCall?.[1]).toBe(fetchedNextRun);
    });

    // Regression for Lumen's PR #437 review: a COMPLETING claim (one-time or
    // final max_runs) sets status='completed' but leaves next_run_at unchanged.
    // Without a status guard, a racing loser still matches id + next_run_at and
    // delivers a duplicate. The claim must also guard status='active'.
    it('should guard the CAS on status=active so completing claims are race-safe', async () => {
      initHeartbeatService({ enableLocalCron: false });

      // One-time reminder: no cron_expression → isCompleted → status='completed'.
      const reminder = makeDueReminder({ cron_expression: null });
      setQueryResult('scheduled_reminders', [reminder]); // select due
      setQueryResult('scheduled_reminders', [{ id: 'rem-001' }]); // claim win

      const mockDeliver = vi.fn().mockResolvedValue(true);
      await processHeartbeat(mockDeliver);

      const builder = tableBuilders.get('scheduled_reminders')!;
      const eqCalls = (builder.eq as ReturnType<typeof vi.fn>).mock.calls;
      const statusEq = eqCalls.find((c) => c[0] === 'status');
      expect(statusEq?.[1]).toBe('active');

      // The winning update marks the one-time reminder completed.
      const updateArgs = (builder.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(updateArgs.status).toBe('completed');
      expect(updateArgs.next_run_at).toBeUndefined(); // unchanged — hence the status guard
    });

    it('should NOT deliver a completing reminder when the status-guarded claim loses', async () => {
      initHeartbeatService({ enableLocalCron: false });

      // Final max_runs run → isCompleted. A concurrent winner already flipped
      // status→completed, so this claim matches 0 rows (status no longer active).
      const reminder = makeDueReminder({ cron_expression: '0 * * * *', run_count: 4, max_runs: 5 });
      setQueryResult('scheduled_reminders', [reminder]); // select due
      setQueryResult('scheduled_reminders', []); // claim: 0 rows → lost to a concurrent completer

      const mockDeliver = vi.fn().mockResolvedValue(true);
      const stats = await processHeartbeat(mockDeliver);

      expect(mockDeliver).not.toHaveBeenCalled();
      expect(stats.delivered).toBe(0);
      expect(stats.skipped).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Failure reporting (2026-09-11)
  //
  // Eight of nine of Myra's heartbeats failed over twelve hours and
  // produced exactly as much noise as zero failures. Two reasons, both
  // covered here: the real error could not survive a boolean return, and
  // nothing was notified because heartbeats never enter the agent gateway
  // where the `[TriggerFailure]` escalation lives.
  // ═══════════════════════════════════════════════════════════════
  describe('processHeartbeat - failure is loud', () => {
    const AUTH_ERROR = 'Backend claude is not authenticated (not logged in)';

    it('records the delivery error verbatim instead of a generic reason', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', [makeDueReminder()]);

      const stats = await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'failed', error: AUTH_ERROR })
      );

      expect(stats.failed).toBe(1);
      const historyBuilder = tableBuilders.get('reminder_history')!;
      expect(historyBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({ reminder_id: 'rem-001', error_message: AUTH_ERROR })
      );
    });

    it('escalates a failed beat with the real error', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', [makeDueReminder()]);

      const onFailure = vi.fn().mockResolvedValue(undefined);
      await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'failed', error: AUTH_ERROR }),
        onFailure
      );

      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'rem-001' }),
        AUTH_ERROR,
        1,
        FIRST_FOR_DESTINATION
      );
    });

    it('escalates when the deliver callback throws', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', [makeDueReminder()]);

      const onFailure = vi.fn().mockResolvedValue(undefined);
      await processHeartbeat(vi.fn().mockRejectedValue(new Error('spawn ENOENT')), onFailure);

      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'rem-001' }),
        'spawn ENOENT',
        1,
        FIRST_FOR_DESTINATION
      );
    });

    it('does not escalate a delivered beat', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', [makeDueReminder()]);
      setQueryResult('scheduled_reminders', [{ id: 'rem-001' }]); // claim CAS win

      const onFailure = vi.fn().mockResolvedValue(undefined);
      const stats = await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'delivered' }),
        onFailure
      );

      expect(stats.delivered).toBe(1);
      expect(onFailure).not.toHaveBeenCalled();
    });

    it('still accepts a bare boolean, and says the detail is missing', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', [makeDueReminder()]);

      const onFailure = vi.fn().mockResolvedValue(undefined);
      const stats = await processHeartbeat(vi.fn().mockResolvedValue(false), onFailure);

      expect(stats.failed).toBe(1);
      // The reason must not be the old placeholder, and must not be empty —
      // it has to say that no detail was available.
      const reason = onFailure.mock.calls[0][1] as string;
      expect(reason).not.toBe('Delivery callback returned false');
      expect(reason).toMatch(/no detail/i);
    });

    it('keeps processing later reminders when escalation itself throws', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', [
        makeDueReminder({ id: 'rem-001' }),
        makeDueReminder({ id: 'rem-002' }),
      ]); // select due
      // One claim result per reminder — the CAS wins on exactly one row.
      setQueryResult('scheduled_reminders', [{ id: 'rem-001' }]);
      setQueryResult('scheduled_reminders', [{ id: 'rem-002' }]);

      const deliver = vi.fn().mockResolvedValue({ status: 'failed', error: AUTH_ERROR });
      const onFailure = vi.fn().mockRejectedValue(new Error('inbox insert failed'));

      const stats = await processHeartbeat(deliver, onFailure);

      // Both reminders were attempted — a broken escalation must not take the
      // rest of the tick down with it.
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(onFailure).toHaveBeenCalledTimes(2);
      expect(stats.failed).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Failure streak, recovery, and deliberate no-ops (round two, 2026-09-11)
  //
  // Lumen's review of #606: the streak was a process-local counter, so a
  // restart reset it — and it is the deduplication key for the direct outage
  // alert. And a strategy watchdog that stands down on a completed group used
  // to return `false`, which would have paged a human every time a task group
  // finished.
  // ═══════════════════════════════════════════════════════════════
  describe('processHeartbeat - streak, recovery, and skips', () => {
    const AUTH_ERROR = 'Backend claude is not authenticated (not logged in)';

    /**
     * Queue the two reminder_history round-trips one beat makes: the streak
     * SELECT, then the attempt INSERT. Clears the blanket default queued in
     * beforeEach first — it sits at the head of the FIFO and would otherwise
     * answer the SELECT with a non-array, making every streak read as zero.
     */
    function queueHistory(prior: (string | { status: string; triggered_at: string })[]) {
      queryResultQueues.delete('reminder_history');
      setQueryResult(
        'reminder_history',
        // `triggered_at` matters as well as status: it is what dates the start
        // of an outage, and therefore what identifies the episode a notice
        // belongs to. Entries may give it explicitly or leave it null.
        prior.map((entry) =>
          typeof entry === 'string' ? { status: entry, triggered_at: null } : entry
        )
      );
      setQueryResult('reminder_history', { id: 'hist-001' });
    }

    /**
     * Myra's two active beats: different reminders, one SB, one Telegram chat,
     * and cron expressions that collide at 16:00Z every day. Reported by her
     * on 2026-09-11 against this branch.
     */
    function makeCollidingBeats() {
      return [
        makeDueReminder({ id: 'rem-hourly', sb_id: 'sb-myra', cron_expression: '0 * * * *' }),
        makeDueReminder({ id: 'rem-daily', sb_id: 'sb-myra', cron_expression: '0 9 * * *' }),
      ];
    }

    it('tells only the first of two colliding beats to alert the destination', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', makeCollidingBeats());
      // Both beats win their claim CAS, then both fail on the same backend.
      setQueryResult('scheduled_reminders', [{ id: 'rem-hourly' }]);
      setQueryResult('scheduled_reminders', [{ id: 'rem-daily' }]);

      // The hook reports that its alert LANDED. Only then is the destination
      // claimed — see the sibling test below for what happens when it does not.
      const onFailure = vi.fn().mockResolvedValue(ALERTED);
      await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'failed', error: AUTH_ERROR }),
        onFailure
      );

      // Both still escalate — the durable inbox row is per-beat and both
      // monitors genuinely stopped. It is the unsolicited message to the human
      // that collapses, and the flag is what collapses it.
      expect(onFailure).toHaveBeenCalledTimes(2);
      expect(onFailure.mock.calls[0][3]).toMatchObject({ destinationAlreadyAlerted: false });
      expect(onFailure.mock.calls[1][3]).toMatchObject({ destinationAlreadyAlerted: true });
    });

    // Lumen's round-three P1, at the level that owns the decision. The original
    // `claimDestination` added the key BEFORE the hook ran, so a first beat
    // whose send failed still silenced its sibling and nobody heard anything.
    it('does NOT claim the destination when the first beat failed to alert', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', makeCollidingBeats());
      setQueryResult('scheduled_reminders', [{ id: 'rem-hourly' }]);
      setQueryResult('scheduled_reminders', [{ id: 'rem-daily' }]);

      // The first beat tried and its channel send rejected.
      const onFailure = vi
        .fn()
        .mockResolvedValueOnce({ alerted: false })
        .mockResolvedValue(ALERTED);

      await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'failed', error: AUTH_ERROR }),
        onFailure
      );

      // So the second beat must still be free to reach the human. One dead send
      // must never buy silence for the whole destination.
      expect(onFailure).toHaveBeenCalledTimes(2);
      expect(onFailure.mock.calls[1][3]).toMatchObject({ destinationAlreadyAlerted: false });
    });

    it('does not claim the destination when the hook itself throws', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', makeCollidingBeats());
      setQueryResult('scheduled_reminders', [{ id: 'rem-hourly' }]);
      setQueryResult('scheduled_reminders', [{ id: 'rem-daily' }]);

      const onFailure = vi
        .fn()
        .mockRejectedValueOnce(new Error('escalation exploded'))
        .mockResolvedValue(ALERTED);

      await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'failed', error: AUTH_ERROR }),
        onFailure
      );

      // A hook that threw told nobody anything.
      expect(onFailure.mock.calls[1][3]).toMatchObject({ destinationAlreadyAlerted: false });
    });

    it('gives every beat of one outage the same episode key', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', [makeDueReminder()]);
      // Two failures already on the record, newest first — the OLDEST of the
      // contiguous run is when this outage began, and therefore its identity.
      // The delivered row below it ends the run and must not be counted.
      queueHistory([
        { status: 'failed', triggered_at: '2026-09-09T02:00:00.000Z' },
        { status: 'failed', triggered_at: '2026-09-09T01:00:00.000Z' },
        { status: 'delivered', triggered_at: '2026-09-09T00:00:00.000Z' },
      ]);

      const onFailure = vi.fn().mockResolvedValue(ALERTED);
      await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'failed', error: AUTH_ERROR }),
        onFailure
      );

      expect(onFailure.mock.calls[0][3]).toMatchObject({
        episodeKey: '2026-09-09T01:00:00.000Z',
      });
    });

    it('does not collapse beats that reach different destinations', async () => {
      initHeartbeatService({ enableLocalCron: false });

      // Same SB, same channel, different chat — two people to tell, so the
      // second is not a duplicate of the first.
      setQueryResult('scheduled_reminders', [
        makeDueReminder({ id: 'rem-a', sb_id: 'sb-myra', delivery_target: 'chat-1' }),
        makeDueReminder({ id: 'rem-b', sb_id: 'sb-myra', delivery_target: 'chat-2' }),
      ]);
      setQueryResult('scheduled_reminders', [{ id: 'rem-a' }]);
      setQueryResult('scheduled_reminders', [{ id: 'rem-b' }]);

      const onFailure = vi.fn().mockResolvedValue(undefined);
      await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'failed', error: AUTH_ERROR }),
        onFailure
      );

      expect(onFailure).toHaveBeenCalledTimes(2);
      expect(onFailure.mock.calls[0][3]).toMatchObject({ destinationAlreadyAlerted: false });
      expect(onFailure.mock.calls[1][3]).toMatchObject({ destinationAlreadyAlerted: false });
    });

    it('leaves beats with no owning SB to dedupe on their own streak', async () => {
      initHeartbeatService({ enableLocalCron: false });

      // No sb_id means no destination key, so nothing is claimed and nothing
      // is suppressed — two ownerless beats must not silence each other.
      setQueryResult('scheduled_reminders', [
        makeDueReminder({ id: 'rem-a', sb_id: null }),
        makeDueReminder({ id: 'rem-b', sb_id: null }),
      ]);
      setQueryResult('scheduled_reminders', [{ id: 'rem-a' }]);
      setQueryResult('scheduled_reminders', [{ id: 'rem-b' }]);

      const onFailure = vi.fn().mockResolvedValue(undefined);
      await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'failed', error: AUTH_ERROR }),
        onFailure
      );

      expect(onFailure.mock.calls[0][3]).toMatchObject({ destinationAlreadyAlerted: false });
      expect(onFailure.mock.calls[1][3]).toMatchObject({ destinationAlreadyAlerted: false });
    });

    it('derives the consecutive count from history, not from process memory', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', [makeDueReminder()]);
      // Three failures already on the record, newest first. This process has
      // never seen them — an in-memory counter would report 1.
      queueHistory(['failed', 'failed', 'failed', 'delivered']);

      const onFailure = vi.fn().mockResolvedValue(undefined);
      await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'failed', error: AUTH_ERROR }),
        onFailure
      );

      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'rem-001' }),
        AUTH_ERROR,
        4,
        FIRST_FOR_DESTINATION
      );
    });

    it('stops counting at the last delivered beat', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', [makeDueReminder()]);
      // One recent failure, then a success, then older failures that belong to
      // a previous, already-closed outage.
      queueHistory(['failed', 'delivered', 'failed', 'failed']);

      const onFailure = vi.fn().mockResolvedValue(undefined);
      await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'failed', error: AUTH_ERROR }),
        onFailure
      );

      expect(onFailure).toHaveBeenCalledWith(
        expect.anything(),
        AUTH_ERROR,
        2,
        FIRST_FOR_DESTINATION
      );
    });

    it('announces recovery when a beat lands after failures', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', [makeDueReminder()]);
      setQueryResult('scheduled_reminders', [{ id: 'rem-001' }]); // claim CAS win
      queueHistory(['failed', 'failed']);

      const onRecovery = vi.fn().mockResolvedValue(undefined);
      const stats = await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'delivered' }),
        vi.fn(),
        onRecovery
      );

      expect(stats.delivered).toBe(1);
      expect(onRecovery).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'rem-001' }),
        2,
        FIRST_FOR_DESTINATION
      );
    });

    it('does not announce recovery when the beat was never failing', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', [makeDueReminder()]);
      setQueryResult('scheduled_reminders', [{ id: 'rem-001' }]);
      queueHistory(['delivered', 'delivered']);

      const onRecovery = vi.fn().mockResolvedValue(undefined);
      await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'delivered' }),
        vi.fn(),
        onRecovery
      );

      expect(onRecovery).not.toHaveBeenCalled();
    });

    it('keeps the tick alive when the recovery notice throws', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', [makeDueReminder()]);
      setQueryResult('scheduled_reminders', [{ id: 'rem-001' }]);
      queueHistory(['failed']);

      const onRecovery = vi.fn().mockRejectedValue(new Error('telegram unreachable'));
      const stats = await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'delivered' }),
        vi.fn(),
        onRecovery
      );

      // The beat delivered. A failed all-clear must not retroactively turn a
      // working beat into a failed one.
      expect(onRecovery).toHaveBeenCalled();
      expect(stats.delivered).toBe(1);
      expect(stats.failed).toBe(0);
    });

    // The watchdog case Lumen reproduced: a completed/paused/cancelled group
    // makes the watchdog stand down, which is correct behaviour and must not
    // raise an outage alert.
    it('does NOT escalate or count a skipped beat', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', [makeDueReminder()]);
      setQueryResult('scheduled_reminders', [{ id: 'rem-001' }]);

      const onFailure = vi.fn().mockResolvedValue(undefined);
      const onRecovery = vi.fn().mockResolvedValue(undefined);
      const stats = await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'skipped', reason: 'group already completed' }),
        onFailure,
        onRecovery
      );

      expect(onFailure).not.toHaveBeenCalled();
      expect(onRecovery).not.toHaveBeenCalled();
      expect(stats.failed).toBe(0);
      expect(stats.delivered).toBe(0);
      expect(stats.skipped).toBe(1);
    });

    it('records a skipped beat as skipped, with its reason, not as a failure', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', [makeDueReminder()]);
      setQueryResult('scheduled_reminders', [{ id: 'rem-001' }]);

      await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'skipped', reason: 'group already completed' })
      );

      const historyBuilder = tableBuilders.get('reminder_history')!;
      expect(historyBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          reminder_id: 'rem-001',
          status: 'skipped',
          error_message: 'group already completed',
        })
      );
    });

    it('treats an unreadable streak as zero rather than failing the beat', async () => {
      initHeartbeatService({ enableLocalCron: false });

      setQueryResult('scheduled_reminders', [makeDueReminder()]);
      queryResultQueues.delete('reminder_history');
      setQueryResult('reminder_history', null, { message: 'permission denied' });
      setQueryResult('reminder_history', { id: 'hist-001' });

      const onFailure = vi.fn().mockResolvedValue(undefined);
      const stats = await processHeartbeat(
        vi.fn().mockResolvedValue({ status: 'failed', error: AUTH_ERROR }),
        onFailure
      );

      // Unknown streak fails toward alerting, never toward silence.
      expect(stats.failed).toBe(1);
      expect(onFailure).toHaveBeenCalledWith(
        expect.anything(),
        AUTH_ERROR,
        1,
        FIRST_FOR_DESTINATION
      );
    });
  });
});
