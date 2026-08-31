/**
 * The schema advertised ISO 8601 and rejected half of it.
 *
 * `z.string().datetime()` accepts only a `Z` suffix. Every field using it
 * described itself as ISO 8601, which permits offsets — so a caller who read
 * the documentation and sent `2026-09-02T07:30:00-07:00` got
 * `-32602 Invalid datetime`, naming a field they had filled in correctly.
 *
 * Then, because that failure arrived alone in its turn, they saw nothing at
 * all (#552). Two defects stacked: a schema narrower than its own promise, and
 * a loop that swallowed the complaint.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isoDateTime } from './schema-primitives';
import { createReminderSchema } from './reminder-handlers';

describe('isoDateTime', () => {
  it.each([
    ['2026-09-02T14:30:00Z', 'UTC, the only form that used to work'],
    ['2026-09-02T07:30:00-07:00', 'negative offset — the form that was rejected'],
    ['2026-09-02T22:30:00+08:00', 'positive offset'],
    ['2026-09-02T14:30:00.123Z', 'fractional seconds'],
  ])('accepts %s (%s)', (value) => {
    expect(isoDateTime().safeParse(value).success).toBe(true);
  });

  it.each([
    ['2026-09-02', 'a date with no time'],
    ['not a date', 'prose'],
    ['', 'empty'],
    ['2026-09-02 14:30:00', 'a space instead of T'],
  ])('still rejects %s (%s)', (value) => {
    expect(isoDateTime().safeParse(value).success).toBe(false);
  });

  // Widening only. Anything that parsed before must still parse, or this is a
  // breaking change wearing a bug fix's clothes.
  it('accepts everything the bare validator did', () => {
    const bare = z.string().datetime();
    for (const value of ['2026-09-02T14:30:00Z', '2026-09-02T14:30:00.000Z']) {
      expect(bare.safeParse(value).success).toBe(true);
      expect(isoDateTime().safeParse(value).success).toBe(true);
    }
  });
});

/**
 * Through the actual registered schema, not just the helper — the helper being
 * right is worth nothing if `create_reminder` doesn't use it. This is the exact
 * call that failed.
 */
describe('create_reminder accepts the time Myra actually sent', () => {
  it('takes an offset timestamp for runAt', () => {
    const parsed = createReminderSchema.safeParse({
      title: 'Spravato prep — eat before 9 AM',
      runAt: '2026-09-02T07:30:00-07:00',
      agentId: 'myra',
    });

    expect(parsed.success).toBe(true);
  });

  it('names runAt when the value is genuinely unparseable', () => {
    const parsed = createReminderSchema.safeParse({ title: 'x', runAt: 'tomorrow morning' });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(['runAt']);
    }
  });
});
