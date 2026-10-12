import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_IDLE_COMPACTION_CONFIG,
  effectiveWakeAt,
  IdleCompactionScheduler,
  type IdleCompactionDeps,
  type IdleRunReport,
  type IdleSessionState,
} from './idle-compaction-scheduler.js';

const HOUR = 3600;
const T0 = Date.parse('2026-10-12T06:00:00.000Z');

interface Harness {
  scheduler: IdleCompactionScheduler;
  deps: IdleCompactionDeps;
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;
  delivered: Array<Parameters<IdleCompactionDeps['deliver']>[0]>;
  setState(state: IdleSessionState | null): void;
  setWake(wake: Date | null | Error): void;
}

function harness(overrides: Partial<typeof DEFAULT_IDLE_COMPACTION_CONFIG> = {}): Harness {
  const timers: Harness['timers'] = [];
  const delivered: Harness['delivered'] = [];
  let state: IdleSessionState | null = { busy: false, ended: false };
  let wake: Date | null | Error = null;
  const deps: IdleCompactionDeps = {
    now: () => T0,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    nextScheduledWakeAt: async () => {
      if (wake instanceof Error) throw wake;
      return wake;
    },
    sessionState: async () => state,
    deliver: async (input) => {
      delivered.push(input);
    },
    log: () => undefined,
  };
  return {
    scheduler: new IdleCompactionScheduler(
      { ...DEFAULT_IDLE_COMPACTION_CONFIG, ...overrides },
      deps
    ),
    deps,
    timers,
    delivered,
    setState: (next) => {
      state = next;
    },
    setWake: (next) => {
      wake = next;
    },
  };
}

function run(overrides: Partial<IdleRunReport> = {}): IdleRunReport {
  return {
    sessionId: 'session-a',
    userId: 'user-1',
    sbSlug: 'myra',
    sbId: 'sb-1',
    providerContextTokens: 292_000,
    cacheTtlSeconds: HOUR,
    ...overrides,
  };
}

describe('IdleCompactionScheduler.noteRunFinished', () => {
  it('arms five minutes before a one-hour cache expires', () => {
    const h = harness();
    const decision = h.scheduler.noteRunFinished(run());
    expect(decision).toEqual({
      armed: true,
      fireAt: T0 + 55 * 60 * 1000,
      expiresAt: T0 + 60 * 60 * 1000,
    });
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(55 * 60 * 1000);
  });

  it('caps the margin at a fifth of a five-minute lifetime', () => {
    const h = harness();
    const decision = h.scheduler.noteRunFinished(run({ cacheTtlSeconds: 300 }));
    expect(decision).toMatchObject({ armed: true, fireAt: T0 + 240 * 1000 });
  });

  it('does not arm below the context floor', () => {
    const h = harness();
    expect(h.scheduler.noteRunFinished(run({ providerContextTokens: 117_319 }))).toEqual({
      armed: false,
      reason: 'context 117319 below 150000',
    });
    expect(h.timers).toHaveLength(0);
  });

  it('does not arm without a provider measurement or a known cache lifetime', () => {
    const h = harness();
    expect(h.scheduler.noteRunFinished(run({ providerContextTokens: undefined }))).toEqual({
      armed: false,
      reason: 'no provider measurement',
    });
    expect(
      h.scheduler.noteRunFinished(run({ sessionId: 'session-b', cacheTtlSeconds: undefined }))
    ).toEqual({ armed: false, reason: 'cache lifetime unknown' });
  });

  it("keeps the session's last written lifetime through a run that only read the cache", () => {
    const h = harness();
    h.scheduler.noteRunFinished(run({ providerContextTokens: 90_000 }));
    const decision = h.scheduler.noteRunFinished(run({ cacheTtlSeconds: undefined }));
    expect(decision).toMatchObject({ armed: true, expiresAt: T0 + HOUR * 1000 });
  });

  it('never arms after an idle compaction turn, however large the context stays', () => {
    const h = harness();
    expect(h.scheduler.noteRunFinished(run({ idleCompaction: true }))).toEqual({
      armed: false,
      reason: 'this run was an idle compaction',
    });
  });

  it('does nothing when disabled', () => {
    const h = harness({ enabled: false });
    expect(h.scheduler.noteRunFinished(run())).toEqual({ armed: false, reason: 'disabled' });
  });

  it("replaces an earlier run's timer, and a run that does not arm still clears it", () => {
    const h = harness();
    h.scheduler.noteRunFinished(run());
    h.scheduler.noteRunFinished(run());
    expect(h.timers.map((t) => t.cleared)).toEqual([true, false]);
    h.scheduler.noteRunFinished(run({ providerContextTokens: 1_000 }));
    expect(h.timers.map((t) => t.cleared)).toEqual([true, true]);
    expect(h.scheduler.armedSessionIds()).toEqual([]);
  });
});

describe('IdleCompactionScheduler.fire', () => {
  it('delivers the turn with the measured context and lifetime', async () => {
    const h = harness();
    h.scheduler.noteRunFinished(run());
    await expect(h.scheduler.fire('session-a')).resolves.toEqual({ delivered: true });
    expect(h.delivered).toEqual([
      { report: run(), providerContextTokens: 292_000, cacheTtlSeconds: HOUR },
    ]);
    expect(h.scheduler.armedSessionIds()).toEqual([]);
  });

  it('delivers when the next reminder falls after the cache expires', async () => {
    const h = harness();
    h.setWake(new Date(T0 + 61 * 60 * 1000));
    h.scheduler.noteRunFinished(run());
    await expect(h.scheduler.fire('session-a')).resolves.toEqual({ delivered: true });
  });

  it('skips when a reminder is due before the cache expires: that wake reads it warm', async () => {
    const h = harness();
    h.setWake(new Date(T0 + 58 * 60 * 1000));
    h.scheduler.noteRunFinished(run());
    await expect(h.scheduler.fire('session-a')).resolves.toEqual({
      delivered: false,
      reason: 'a reminder is due at 2026-10-12T06:58:00.000Z, before the cache expires',
    });
    expect(h.delivered).toEqual([]);
  });

  it('skips a busy, ended or vanished session', async () => {
    for (const [state, reason] of [
      [{ busy: true, ended: false }, 'session busy'],
      [{ busy: false, ended: true }, 'session ended'],
      [null, 'session gone'],
    ] as const) {
      const h = harness();
      h.setState(state);
      h.scheduler.noteRunFinished(run());
      await expect(h.scheduler.fire('session-a')).resolves.toEqual({ delivered: false, reason });
      expect(h.delivered).toEqual([]);
    }
  });

  it('does not deliver when the reminder schedule cannot be read', async () => {
    const h = harness();
    h.setWake(new Error('could not read reminders: boom'));
    h.scheduler.noteRunFinished(run());
    await expect(h.scheduler.fire('session-a')).rejects.toThrow('boom');
    expect(h.delivered).toEqual([]);
  });

  it('fires once: a second firing finds nothing armed', async () => {
    const h = harness();
    h.scheduler.noteRunFinished(run());
    await h.scheduler.fire('session-a');
    await expect(h.scheduler.fire('session-a')).resolves.toEqual({
      delivered: false,
      reason: 'not armed',
    });
    expect(h.delivered).toHaveLength(1);
  });

  it('the armed timer is what fires the turn', async () => {
    const h = harness();
    const deliver = vi.spyOn(h.deps, 'deliver');
    h.scheduler.noteRunFinished(run());
    h.timers[0].fn();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
  });
});

describe('effectiveWakeAt', () => {
  // 22:00–08:00 Pacific; on 2026-10-11/12 that is UTC-7.
  const overnight = { start: '22:00', end: '08:00', timezone: 'America/Los_Angeles' };
  const morning = '2026-10-12T15:00:00.000Z'; // 08:00 PDT

  it('is the earliest due time, and an overdue reminder wakes now', () => {
    const now = new Date('2026-10-12T19:30:00.000Z'); // 12:30 PDT
    expect(
      effectiveWakeAt(
        [
          { next_run_at: '2026-10-12T21:00:00Z' },
          { next_run_at: '2026-10-12T20:00:00Z' },
          { next_run_at: '2026-10-12T22:00:00Z' },
        ],
        overnight,
        now
      )?.toISOString()
    ).toBe('2026-10-12T20:00:00.000Z');
    expect(
      effectiveWakeAt([{ next_run_at: '2026-10-12T19:00:00Z' }], overnight, now)?.toISOString()
    ).toBe(now.toISOString());
  });

  it('a beat held in quiet hours wakes when they end, not at its stale due time', () => {
    const now = new Date('2026-10-12T06:30:00.000Z'); // 23:30 PDT
    expect(
      effectiveWakeAt([{ next_run_at: '2026-10-12T06:00:00Z' }], overnight, now)?.toISOString()
    ).toBe(morning);
  });

  it('a beat that comes due inside the coming quiet window is held to its end', () => {
    const now = new Date('2026-10-12T04:50:00.000Z'); // 21:50 PDT
    expect(
      effectiveWakeAt([{ next_run_at: '2026-10-12T05:00:00Z' }], overnight, now)?.toISOString()
    ).toBe(morning);
  });

  it('a reminder allowed to run in quiet hours wakes on time', () => {
    const now = new Date('2026-10-12T06:30:00.000Z');
    expect(
      effectiveWakeAt(
        [{ next_run_at: '2026-10-12T07:00:00Z', run_during_quiet_hours: true }],
        overnight,
        now
      )?.toISOString()
    ).toBe('2026-10-12T07:00:00.000Z');
  });

  it('without a quiet window, or without reminders', () => {
    const now = new Date('2026-10-12T06:30:00.000Z');
    expect(
      effectiveWakeAt([{ next_run_at: '2026-10-12T07:00:00Z' }], null, now)?.toISOString()
    ).toBe('2026-10-12T07:00:00.000Z');
    expect(effectiveWakeAt([], overnight, now)).toBeNull();
  });
});
