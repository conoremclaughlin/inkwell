import { describe, expect, it } from 'vitest';
import {
  classifyReminder,
  describeCron,
  isStrategyWatchdog,
  shapeAutomations,
  type ReminderSourceRow,
  type StrategyGroupSourceRow,
} from './automation-shaper.js';

function makeReminder(overrides: Partial<ReminderSourceRow> = {}): ReminderSourceRow {
  return {
    id: 'rem-1',
    title: 'Water the plants',
    description: null,
    cron_expression: null,
    next_run_at: '2026-07-05T10:00:00Z',
    last_run_at: null,
    delivery_channel: 'telegram',
    status: 'active',
    metadata: {},
    agent_identities: { agent_id: 'myra', name: 'Myra' },
    ...overrides,
  };
}

function makeStrategyGroup(
  overrides: Partial<StrategyGroupSourceRow> = {}
): StrategyGroupSourceRow {
  return {
    id: 'group-1',
    title: 'Ship the roadmap',
    status: 'active',
    strategy: 'sequential',
    strategy_config: { watchdogIntervalMinutes: 10 },
    strategy_started_at: '2026-07-01T00:00:00Z',
    strategy_paused_at: null,
    updated_at: '2026-07-03T12:00:00Z',
    agent_identities: { agent_id: 'wren', name: 'Wren' },
    ...overrides,
  };
}

describe('describeCron', () => {
  it('describes one-shot reminders as Once', () => {
    expect(describeCron(null)).toBe('Once');
  });

  it('describes minute intervals', () => {
    expect(describeCron('*/10 * * * *')).toBe('Every 10 minutes');
    expect(describeCron('*/1 * * * *')).toBe('Every minute');
  });

  it('describes hourly intervals', () => {
    expect(describeCron('0 */2 * * *')).toBe('Every 2 hours');
    expect(describeCron('30 * * * *')).toBe('Every hour');
  });

  it('describes daily schedules with zero-padded time', () => {
    expect(describeCron('0 9 * * *')).toBe('Daily at 09:00');
    expect(describeCron('5 17 * * *')).toBe('Daily at 17:05');
  });

  it('describes weekly and weekday schedules', () => {
    expect(describeCron('0 9 * * 1')).toBe('Weekly on Monday at 09:00');
    expect(describeCron('0 9 * * 0')).toBe('Weekly on Sunday at 09:00');
    expect(describeCron('30 8 * * 1-5')).toBe('Weekdays at 08:30');
  });

  it('describes monthly schedules', () => {
    expect(describeCron('0 9 1 * *')).toBe('Monthly on day 1 at 09:00');
  });

  it('falls back to the raw expression for unusual patterns', () => {
    expect(describeCron('0 9 * 2 3')).toBe('0 9 * 2 3');
    expect(describeCron('not-a-cron')).toBe('not-a-cron');
  });
});

describe('classifyReminder', () => {
  it('labels metadata-tagged check-ins as heartbeats', () => {
    const reminder = makeReminder({ metadata: { reminderType: 'daily-checkin' } });
    expect(classifyReminder(reminder)).toBe('heartbeat');
  });

  it('labels recurring reminders with heartbeat-shaped titles as heartbeats', () => {
    expect(
      classifyReminder(
        makeReminder({ title: 'Morning check-in', cron_expression: '0 9 * * *', metadata: {} })
      )
    ).toBe('heartbeat');
    expect(
      classifyReminder(
        makeReminder({ title: 'Heartbeat sweep', cron_expression: '*/30 * * * *', metadata: {} })
      )
    ).toBe('heartbeat');
  });

  it('does not label one-shot check-in-titled reminders as heartbeats', () => {
    expect(
      classifyReminder(makeReminder({ title: 'Check-in with Alex', cron_expression: null }))
    ).toBe('reminder');
  });

  it('labels ordinary reminders as reminders', () => {
    expect(classifyReminder(makeReminder({ cron_expression: '0 9 * * *' }))).toBe('reminder');
  });
});

describe('isStrategyWatchdog', () => {
  it('detects watchdog reminders by metadata flag', () => {
    expect(
      isStrategyWatchdog(makeReminder({ metadata: { strategyWatchdog: true, groupId: 'g' } }))
    ).toBe(true);
    expect(isStrategyWatchdog(makeReminder({ metadata: {} }))).toBe(false);
    expect(isStrategyWatchdog(makeReminder({ metadata: null }))).toBe(false);
  });
});

describe('shapeAutomations', () => {
  it('shapes plain reminders with agent and cadence', () => {
    const items = shapeAutomations([makeReminder({ cron_expression: '0 9 * * *' })], []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'rem-1',
      kind: 'reminder',
      title: 'Water the plants',
      agentId: 'myra',
      agentName: 'Myra',
      cadence: 'Daily at 09:00',
      status: 'active',
      deliveryChannel: 'telegram',
      missionGroupId: null,
      lastRunSessionId: null,
    });
  });

  it('folds watchdog reminders into their strategy item instead of listing them', () => {
    const watchdog = makeReminder({
      id: 'watchdog-1',
      title: 'Strategy watchdog: "Ship the roadmap"',
      cron_expression: '*/10 * * * *',
      next_run_at: '2026-07-04T10:10:00Z',
      last_run_at: '2026-07-04T10:00:00Z',
      metadata: { strategyWatchdog: true, groupId: 'group-1', inkSessionId: 'session-9' },
    });
    const items = shapeAutomations([watchdog], [makeStrategyGroup()]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'group-1',
      kind: 'strategy',
      title: 'Ship the roadmap (sequential)',
      agentId: 'wren',
      cadence: 'Watchdog: every 10 minutes',
      status: 'active',
      nextRunAt: '2026-07-04T10:10:00Z',
      lastRunAt: '2026-07-04T10:00:00Z',
      lastRunSessionId: 'session-9',
      missionGroupId: 'group-1',
    });
  });

  it('derives strategy cadence from config when no watchdog reminder exists', () => {
    const items = shapeAutomations([], [makeStrategyGroup()]);
    expect(items[0].cadence).toBe('Watchdog: every 10 minutes');
    expect(items[0].nextRunAt).toBeNull();
    expect(items[0].lastRunAt).toBe('2026-07-03T12:00:00Z');
  });

  it('marks paused strategies via strategy_paused_at', () => {
    const items = shapeAutomations(
      [],
      [makeStrategyGroup({ strategy_paused_at: '2026-07-02T00:00:00Z' })]
    );
    expect(items[0].status).toBe('paused');
  });

  it('skips task groups without a strategy', () => {
    const items = shapeAutomations([], [makeStrategyGroup({ strategy: null })]);
    expect(items).toHaveLength(0);
  });

  it('skips orphaned watchdogs without a groupId', () => {
    const orphan = makeReminder({
      id: 'watchdog-orphan',
      metadata: { strategyWatchdog: true },
    });
    expect(shapeAutomations([orphan], [])).toHaveLength(0);
  });

  it('sorts by nextRunAt ascending with missing next runs last', () => {
    const items = shapeAutomations(
      [
        makeReminder({ id: 'later', next_run_at: '2026-07-06T00:00:00Z' }),
        makeReminder({ id: 'none', next_run_at: null, title: 'A completed one' }),
        makeReminder({ id: 'sooner', next_run_at: '2026-07-04T00:00:00Z' }),
      ],
      []
    );
    expect(items.map((i) => i.id)).toEqual(['sooner', 'later', 'none']);
  });
});
