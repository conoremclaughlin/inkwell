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
});
