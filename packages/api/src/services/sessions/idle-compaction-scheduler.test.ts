import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_IDLE_COMPACTION_CONFIG,
  IdleCompactionScheduler,
  type IdleCompactionDeps,
  type IdleRunReport,
  type IdleSessionState,
} from './idle-compaction-scheduler.js';
import { InkRunner } from './ink-runner.js';

const HOUR = 3600;
const T0 = Date.parse('2026-10-12T06:00:00.000Z');

interface Harness {
  scheduler: IdleCompactionScheduler;
  deps: IdleCompactionDeps;
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;
  delivered: Array<Parameters<IdleCompactionDeps['deliver']>[0]>;
  setState(state: IdleSessionState | null): void;
  /** Hold the next session-state read open until the returned release is called. */
  holdStateRead(): () => void;
  setNow(ms: number): void;
}

// The mechanics under test, at fixed values, not the shipped defaults.
const CONFIG = {
  ...DEFAULT_IDLE_COMPACTION_CONFIG,
  enabled: true,
  minContextTokens: 150_000,
  minGrowthTokens: 50_000,
};

function harness(overrides: Partial<typeof DEFAULT_IDLE_COMPACTION_CONFIG> = {}): Harness {
  const timers: Harness['timers'] = [];
  const delivered: Harness['delivered'] = [];
  let state: IdleSessionState | null = { busy: false, ended: false };
  let held: Promise<void> | null = null;
  let now = T0;
  const deps: IdleCompactionDeps = {
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    sessionState: async () => {
      if (held) await held;
      return state;
    },
    deliver: async (input) => {
      delivered.push(input);
    },
    log: () => undefined,
  };
  return {
    scheduler: new IdleCompactionScheduler({ ...CONFIG, ...overrides }, deps),
    deps,
    timers,
    delivered,
    setState: (next) => {
      state = next;
    },
    holdStateRead: () => {
      let release!: () => void;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        held = null;
        release();
      };
    },
    setNow: (ms) => {
      now = ms;
    },
  };
}

const SCOPE = { providerSessionId: 'native-1', model: 'claude-opus-5-5' };
const ttl = (seconds: number) => ({ kind: 'ttl' as const, seconds, ...SCOPE });
const readOnly = (scope: { providerSessionId?: string; model?: string } = {}) => ({
  kind: 'read-only' as const,
  ...SCOPE,
  ...scope,
});

function run(overrides: Partial<IdleRunReport> = {}): IdleRunReport {
  return {
    sessionId: 'session-a',
    userId: 'user-1',
    sbSlug: 'myra',
    sbId: 'sb-1',
    providerContextTokens: 292_000,
    cacheEvidence: ttl(HOUR),
    lastRequestStartedAt: new Date(T0).toISOString(),
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

  it("counts from the last request's start: generation time already spent the cache", () => {
    const h = harness();
    // The run's last invocation began 20 minutes ago and ran until now.
    const decision = h.scheduler.noteRunFinished(
      run({ lastRequestStartedAt: new Date(T0 - 20 * 60 * 1000).toISOString() })
    );
    expect(decision).toEqual({
      armed: true,
      fireAt: T0 + 35 * 60 * 1000,
      expiresAt: T0 + 40 * 60 * 1000,
    });
    expect(h.timers[0].ms).toBe(35 * 60 * 1000);
  });

  it('does not arm once the useful window has passed during the run', () => {
    const h = harness();
    // Four and a half minutes of generation on a five-minute cache.
    expect(
      h.scheduler.noteRunFinished(
        run({
          cacheEvidence: ttl(300),
          lastRequestStartedAt: new Date(T0 - 270 * 1000).toISOString(),
        })
      )
    ).toEqual({ armed: false, reason: 'the cache window passed during the run' });
    expect(h.timers).toHaveLength(0);
  });

  it('does not arm without knowing when the last request started', () => {
    const h = harness();
    expect(h.scheduler.noteRunFinished(run({ lastRequestStartedAt: undefined }))).toEqual({
      armed: false,
      reason: 'request start unknown',
    });
    expect(h.scheduler.noteRunFinished(run({ lastRequestStartedAt: 'not a time' }))).toEqual({
      armed: false,
      reason: 'request start unknown',
    });
  });

  it('after an idle compaction, arms again only once the context has grown', () => {
    const h = harness();
    // The compaction itself left 160k: above the floor, but it is the new baseline.
    h.scheduler.noteRunFinished(run({ idleCompaction: true, providerContextTokens: 160_000 }));
    expect(h.scheduler.noteRunFinished(run({ providerContextTokens: 209_999 }))).toEqual({
      armed: false,
      reason: 'context 209999 has not grown 50000 since the last idle compaction left 160000',
    });
    expect(h.scheduler.noteRunFinished(run({ providerContextTokens: 210_000 }))).toMatchObject({
      armed: true,
    });
  });

  it('a refused compaction that left the context large does not buy another attempt', () => {
    const h = harness();
    h.scheduler.noteRunFinished(run({ idleCompaction: true, providerContextTokens: 292_000 }));
    expect(h.scheduler.noteRunFinished(run({ providerContextTokens: 300_000 }))).toMatchObject({
      armed: false,
    });
  });

  it('caps the margin at a fifth of a five-minute lifetime', () => {
    const h = harness();
    const decision = h.scheduler.noteRunFinished(run({ cacheEvidence: ttl(300) }));
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
      h.scheduler.noteRunFinished(run({ sessionId: 'session-b', cacheEvidence: undefined }))
    ).toEqual({ armed: false, reason: 'cache lifetime unknown' });
  });

  it("keeps the session's last written lifetime through a run that only read the cache", () => {
    const h = harness();
    h.scheduler.noteRunFinished(run({ providerContextTokens: 90_000 }));
    const decision = h.scheduler.noteRunFinished(run({ cacheEvidence: readOnly() }));
    expect(decision).toMatchObject({ armed: true, expiresAt: T0 + HOUR * 1000 });
  });

  // Lumen, #845 r3: an unknown write may have replaced what was cached, so it
  // inherits nothing and forgets what was learned; absent evidence is unknown.
  it('an unknown or absent write inherits nothing, and forgets the learned lifetime', () => {
    for (const unknown of [{ kind: 'unknown' as const }, undefined]) {
      const h = harness();
      h.scheduler.noteRunFinished(run({ providerContextTokens: 90_000 }));
      expect(h.scheduler.noteRunFinished(run({ cacheEvidence: unknown }))).toEqual({
        armed: false,
        reason: 'cache lifetime unknown',
      });
      // A read-only run after it has nothing left to inherit.
      expect(h.scheduler.noteRunFinished(run({ cacheEvidence: readOnly() }))).toEqual({
        armed: false,
        reason: 'cache lifetime unknown',
      });
    }
  });

  // Lumen, #845 r2: a lifetime learned under one native session or model says
  // nothing about another.
  it('inherits a learned lifetime only for the same native session and model', () => {
    for (const [what, later, expected] of [
      ['the same session and model', {}, true],
      ['a reseeded native session', { providerSessionId: 'native-2' }, false],
      ['another model', { model: 'claude-fable-5' }, false],
      ['an unreported native session', { providerSessionId: undefined }, false],
    ] as const) {
      const h = harness();
      h.scheduler.noteRunFinished(run({ providerContextTokens: 90_000 }));
      const decision = h.scheduler.noteRunFinished(run({ cacheEvidence: readOnly(later) }));
      expect(decision.armed, what).toBe(expected);
      if (!expected)
        expect(decision, what).toEqual({ armed: false, reason: 'cache lifetime unknown' });
    }
  });

  // Lumen, #845 r4: two unreported models are not the same model.
  it('a lifetime learned without a model is not inherited by a read without one', () => {
    const h = harness();
    h.scheduler.noteRunFinished(
      run({
        providerContextTokens: 90_000,
        cacheEvidence: { kind: 'ttl', seconds: HOUR, providerSessionId: 'native-1' },
      })
    );
    expect(
      h.scheduler.noteRunFinished(
        run({ cacheEvidence: { kind: 'read-only', providerSessionId: 'native-1' } })
      )
    ).toEqual({ armed: false, reason: 'cache lifetime unknown' });
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
      {
        report: run(),
        providerContextTokens: 292_000,
        cacheTtlSeconds: HOUR,
        ticket: { generation: expect.any(Number), expiresAt: T0 + HOUR * 1000 },
      },
    ]);
    expect(h.scheduler.armedSessionIds()).toEqual([]);
  });

  it('skips a timer that fires after the cache has already expired', async () => {
    const h = harness();
    h.scheduler.noteRunFinished(run());
    h.setNow(T0 + HOUR * 1000);
    await expect(h.scheduler.fire('session-a')).resolves.toEqual({
      delivered: false,
      reason: 'the cache has already expired',
    });
    expect(h.delivered).toEqual([]);
  });

  it('skips when the cache expires while the session state is being read', async () => {
    const h = harness();
    h.scheduler.noteRunFinished(run());
    const release = h.holdStateRead();
    const fired = h.scheduler.fire('session-a');
    h.setNow(T0 + HOUR * 1000);
    release();
    await expect(fired).resolves.toEqual({
      delivered: false,
      reason: 'the cache has already expired',
    });
    expect(h.delivered).toEqual([]);
  });

  // Lumen, #845 r1: the candidate used to leave the map before its awaited
  // checks, so nothing that happened during them could void it.
  for (const [what, interrupt] of [
    ['a cancel', (h: Harness) => h.scheduler.cancel('session-a')],
    ['a stop', (h: Harness) => h.scheduler.stop()],
    ['a newer run', (h: Harness) => h.scheduler.noteRunFinished(run())],
  ] as const) {
    it(`does not deliver when ${what} lands while it is being checked`, async () => {
      const h = harness();
      h.scheduler.noteRunFinished(run());
      const release = h.holdStateRead();
      const fired = h.scheduler.fire('session-a');
      interrupt(h);
      release();
      await expect(fired).resolves.toEqual({
        delivered: false,
        reason: 'superseded while it was checked',
      });
      expect(h.delivered).toEqual([]);
    });
  }

  it('a newer run during the check keeps its own timer armed', async () => {
    const h = harness();
    h.scheduler.noteRunFinished(run());
    const release = h.holdStateRead();
    const fired = h.scheduler.fire('session-a');
    h.scheduler.noteRunFinished(run());
    release();
    await fired;
    expect(h.scheduler.armedSessionIds()).toEqual(['session-a']);
  });

  it('arms nothing after a stop', () => {
    const h = harness();
    h.scheduler.stop();
    expect(h.scheduler.noteRunFinished(run())).toEqual({ armed: false, reason: 'stopped' });
    expect(h.timers).toHaveLength(0);
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

  it('does not deliver when the session state cannot be read', async () => {
    const h = harness();
    h.deps.sessionState = async () => {
      throw new Error('boom');
    };
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

// Lumen, #845 r2: the turn is fenced where it takes the session's lock, not
// only while the timer checks it.
describe('IdleCompactionScheduler.admissionRefusal', () => {
  async function ticketFor(h: Harness) {
    h.scheduler.noteRunFinished(run());
    await h.scheduler.fire('session-a');
    return h.delivered[0].ticket;
  }

  it('admits the ticket it just issued', async () => {
    const h = harness();
    const ticket = await ticketFor(h);
    expect(h.scheduler.admissionRefusal('session-a', ticket)).toBeNull();
  });

  it('refuses once a run has started or finished since the ticket was issued', async () => {
    for (const interrupt of [
      (h: Harness) => h.scheduler.cancel('session-a'),
      (h: Harness) => h.scheduler.noteRunFinished(run({ providerContextTokens: 1_000 })),
    ]) {
      const h = harness();
      const ticket = await ticketFor(h);
      interrupt(h);
      expect(h.scheduler.admissionRefusal('session-a', ticket)).toBe('superseded before admission');
    }
  });

  it('refuses after a stop, and once the cache has expired', async () => {
    const stopped = harness();
    const stoppedTicket = await ticketFor(stopped);
    stopped.scheduler.stop();
    expect(stopped.scheduler.admissionRefusal('session-a', stoppedTicket)).toBe('stopped');

    const late = harness();
    const lateTicket = await ticketFor(late);
    late.setNow(T0 + HOUR * 1000);
    expect(late.scheduler.admissionRefusal('session-a', lateTicket)).toBe(
      'the cache has already expired'
    );
  });
});

// Lumen, #845 r3: across the result-line boundary. A server that learned an
// hour from an earlier run reads this run's line through the real runner
// parse. The run wrote without a split and then only read, so ink chat
// reports unknown (chat.integration.test.ts pins that line): nothing arms,
// and a later read-only run has nothing left to inherit.
describe('unknown evidence across the result-line boundary', () => {
  it('a line reporting unknown arms nothing after a learned hour, and leaves nothing to inherit', () => {
    const h = harness();
    expect(h.scheduler.noteRunFinished(run()).armed).toBe(true);
    const line = JSON.stringify({
      type: 'result',
      usage: {
        contextTokens: 72_000,
        inputTokens: 2,
        outputTokens: 10,
        providerContextTokens: 292_002,
        cacheEvidence: { kind: 'unknown' },
        lastRequestStartedAt: new Date(T0).toISOString(),
        providerSessionId: 'native-1',
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = (new InkRunner() as any).parseOutput(line, '').usage;
    expect(
      h.scheduler.noteRunFinished(
        run({
          providerContextTokens: parsed.providerContextTokens,
          cacheEvidence: parsed.cacheEvidence,
        })
      )
    ).toEqual({ armed: false, reason: 'cache lifetime unknown' });
    expect(h.scheduler.noteRunFinished(run({ cacheEvidence: readOnly() }))).toEqual({
      armed: false,
      reason: 'cache lifetime unknown',
    });
  });
});
