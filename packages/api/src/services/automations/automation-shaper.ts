/**
 * Automation Shaper
 *
 * Presentation-level unification of scheduled reminders, heartbeats, and
 * work strategies into a single "automations" list for the dashboard.
 * Pure shaping logic — no database access — so it can be unit tested.
 *
 * NO schema changes: kinds are derived heuristically from existing rows.
 * - Reminders with metadata.reminderType === 'daily-checkin' (or recurring
 *   check-in-shaped titles) are labeled heartbeats.
 * - Strategy watchdog reminders (metadata.strategyWatchdog) are folded into
 *   the strategy item for their task group instead of listed separately.
 * - Strategies come from active task_groups with a strategy configured.
 */

export type AutomationKind = 'reminder' | 'heartbeat' | 'strategy';

export interface AutomationItem {
  id: string;
  kind: AutomationKind;
  title: string;
  agentId: string | null;
  agentName: string | null;
  cadence: string;
  status: string;
  lastRunAt: string | null;
  lastRunSessionId: string | null;
  nextRunAt: string | null;
  /** Task group id for strategy items — links to /missions/<groupId>. */
  missionGroupId: string | null;
  deliveryChannel: string | null;
}

/** Subset of a scheduled_reminders row (with joined agent identity) we shape from. */
export interface ReminderSourceRow {
  id: string;
  title: string;
  description: string | null;
  cron_expression: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  delivery_channel: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  agent_identities?: { agent_id: string; name: string } | null;
}

/** Subset of a task_groups row (with joined agent identity) we shape from. */
export interface StrategyGroupSourceRow {
  id: string;
  title: string;
  status: string;
  strategy: string | null;
  strategy_config: Record<string, unknown> | null;
  strategy_started_at: string | null;
  strategy_paused_at: string | null;
  updated_at: string | null;
  agent_identities?: { agent_id: string; name: string } | null;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatTimeOfDay(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Human-readable description of a cron expression. Covers the common
 * patterns PCP generates; falls back to the raw expression.
 */
export function describeCron(cronExpression: string | null): string {
  if (!cronExpression) return 'Once';

  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) return cronExpression;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // */N * * * * — every N minutes
  const everyMinutes = minute.match(/^\*\/(\d+)$/);
  if (everyMinutes && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const n = parseInt(everyMinutes[1], 10);
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  // M */N * * * — every N hours
  const everyHours = hour.match(/^\*\/(\d+)$/);
  if (
    /^\d+$/.test(minute) &&
    everyHours &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const n = parseInt(everyHours[1], 10);
    return n === 1 ? 'Every hour' : `Every ${n} hours`;
  }

  // M * * * * — hourly at minute M
  if (
    /^\d+$/.test(minute) &&
    hour === '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    return 'Every hour';
  }

  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    const time = formatTimeOfDay(parseInt(hour, 10), parseInt(minute, 10));

    // M H * * * — daily
    if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
      return `Daily at ${time}`;
    }

    // M H * * D — weekly on a single day
    if (dayOfMonth === '*' && month === '*' && /^[0-6]$/.test(dayOfWeek)) {
      return `Weekly on ${WEEKDAYS[parseInt(dayOfWeek, 10)]} at ${time}`;
    }

    // M H * * 1-5 — weekdays
    if (dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
      return `Weekdays at ${time}`;
    }

    // M H D * * — monthly on day D
    if (/^\d+$/.test(dayOfMonth) && month === '*' && dayOfWeek === '*') {
      return `Monthly on day ${parseInt(dayOfMonth, 10)} at ${time}`;
    }
  }

  return cronExpression;
}

/** True when the reminder is a strategy watchdog (internal plumbing for a strategy). */
export function isStrategyWatchdog(reminder: ReminderSourceRow): boolean {
  return reminder.metadata?.strategyWatchdog === true;
}

/**
 * Classify a (non-watchdog) reminder as heartbeat or plain reminder.
 * Heartbeats are recurring agent check-ins: either explicitly tagged via
 * metadata.reminderType, or recurring reminders whose title reads like a
 * check-in/heartbeat.
 */
export function classifyReminder(reminder: ReminderSourceRow): 'reminder' | 'heartbeat' {
  const reminderType = reminder.metadata?.reminderType;
  if (typeof reminderType === 'string' && /check-?in|heartbeat/i.test(reminderType)) {
    return 'heartbeat';
  }
  if (reminder.cron_expression && /\bheartbeat\b|\bcheck-?in\b/i.test(reminder.title)) {
    return 'heartbeat';
  }
  return 'reminder';
}

function reminderToAutomation(reminder: ReminderSourceRow): AutomationItem {
  return {
    id: reminder.id,
    kind: classifyReminder(reminder),
    title: reminder.title,
    agentId: reminder.agent_identities?.agent_id ?? null,
    agentName: reminder.agent_identities?.name ?? null,
    cadence: describeCron(reminder.cron_expression),
    status: reminder.status,
    lastRunAt: reminder.last_run_at,
    lastRunSessionId: null,
    nextRunAt: reminder.next_run_at,
    missionGroupId: null,
    deliveryChannel: reminder.delivery_channel,
  };
}

function strategyToAutomation(
  group: StrategyGroupSourceRow,
  watchdog: ReminderSourceRow | undefined
): AutomationItem {
  const config = group.strategy_config ?? {};
  const watchdogIntervalMinutes =
    typeof config.watchdogIntervalMinutes === 'number' ? config.watchdogIntervalMinutes : null;

  let cadence: string;
  if (watchdog?.cron_expression) {
    cadence = `Watchdog: ${describeCron(watchdog.cron_expression).toLowerCase()}`;
  } else if (watchdogIntervalMinutes) {
    cadence = `Watchdog: every ${watchdogIntervalMinutes} minutes`;
  } else {
    cadence = 'Continuous';
  }

  const strategyLabel = group.strategy ? ` (${group.strategy})` : '';
  const watchdogSessionId = watchdog?.metadata?.inkSessionId;

  return {
    id: group.id,
    kind: 'strategy',
    title: `${group.title}${strategyLabel}`,
    agentId: group.agent_identities?.agent_id ?? null,
    agentName: group.agent_identities?.name ?? null,
    cadence,
    status: group.strategy_paused_at ? 'paused' : group.status,
    lastRunAt: watchdog?.last_run_at ?? group.updated_at,
    lastRunSessionId: typeof watchdogSessionId === 'string' ? watchdogSessionId : null,
    nextRunAt: watchdog?.next_run_at ?? null,
    missionGroupId: group.id,
    deliveryChannel: null,
  };
}

/**
 * Shape reminders + strategy task groups into a unified automations list.
 *
 * Strategy watchdog reminders are not listed as standalone items; they
 * enrich the strategy item for their group (cadence, next run, session).
 * Sorted by nextRunAt ascending, items without a next run last.
 */
export function shapeAutomations(
  reminders: ReminderSourceRow[],
  strategyGroups: StrategyGroupSourceRow[]
): AutomationItem[] {
  const watchdogByGroupId = new Map<string, ReminderSourceRow>();
  const plainReminders: ReminderSourceRow[] = [];

  for (const reminder of reminders) {
    if (isStrategyWatchdog(reminder)) {
      const groupId = reminder.metadata?.groupId;
      if (typeof groupId === 'string') {
        watchdogByGroupId.set(groupId, reminder);
      }
      // Watchdogs without a groupId are orphaned internals — skip entirely.
      continue;
    }
    plainReminders.push(reminder);
  }

  const items: AutomationItem[] = [
    ...plainReminders.map(reminderToAutomation),
    ...strategyGroups
      .filter((group) => group.strategy !== null)
      .map((group) => strategyToAutomation(group, watchdogByGroupId.get(group.id))),
  ];

  return items.sort((a, b) => {
    if (a.nextRunAt && b.nextRunAt) return a.nextRunAt.localeCompare(b.nextRunAt);
    if (a.nextRunAt) return -1;
    if (b.nextRunAt) return 1;
    return a.title.localeCompare(b.title);
  });
}
