/**
 * The no-progress breaker's decisions (spec session-lifecycle-model §5).
 * The database round trip is in wake-source-breaker.integration.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_NO_PROGRESS_LIMIT,
  decideAdmission,
  decideCompletedAttempt,
  parseWakeSourceTag,
  recordWakeSourceCompletion,
  taskFingerprint,
  taskGroupFingerprint,
  type WakeSourceBreaker,
  type WakeSourceTag,
} from './wake-source-breaker';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const pendingTask = {
  status: 'pending',
  outcome: null,
  gate_state: null,
  gate_attempt: 1,
  gate_version: 0,
  gate_request_revision: 0,
};

const t0 = '2026-10-02T10:00:00.000Z';
const t1 = '2026-10-02T10:05:00.000Z';
const t2 = '2026-10-02T10:10:00.000Z';
const t3 = '2026-10-02T10:15:00.000Z';

function attempt(over: Partial<Parameters<typeof decideCompletedAttempt>[1]> = {}) {
  return {
    dispatchedAt: t1,
    fingerprintAtDispatch: 'fp-a',
    fingerprintNow: 'fp-a',
    completedAt: t2,
    ...over,
  };
}

describe('fingerprints', () => {
  it('a task fingerprint moves with its status, outcome and gate state', () => {
    const base = taskFingerprint(pendingTask);
    expect(taskFingerprint({ ...pendingTask })).toBe(base);
    expect(taskFingerprint({ ...pendingTask, status: 'in_progress' })).not.toBe(base);
    expect(taskFingerprint({ ...pendingTask, outcome: 'failed' })).not.toBe(base);
    expect(taskFingerprint({ ...pendingTask, gate_state: 'open' })).not.toBe(base);
    expect(taskFingerprint({ ...pendingTask, gate_attempt: 2 })).not.toBe(base);
  });

  it('a group fingerprint ignores task order but not task state or the cursor', () => {
    const group = { status: 'active', current_task_index: 0 };
    const a = { id: 'a', status: 'pending', outcome: null };
    const b = { id: 'b', status: 'pending', outcome: null };
    const base = taskGroupFingerprint(group, [a, b]);
    expect(taskGroupFingerprint(group, [b, a])).toBe(base);
    expect(taskGroupFingerprint(group, [a, { ...b, status: 'completed' }])).not.toBe(base);
    expect(taskGroupFingerprint({ ...group, current_task_index: 1 }, [a, b])).not.toBe(base);
    expect(taskGroupFingerprint({ ...group, status: 'paused' }, [a, b])).not.toBe(base);
  });
});

describe('decideAdmission', () => {
  it('admits an item with no row or no trip', () => {
    expect(decideAdmission(null, 'fp')).toEqual({ allowed: true, clearTrip: false });
    expect(decideAdmission({ tripped_at: null, tripped_fingerprint: null }, 'fp')).toEqual({
      allowed: true,
      clearTrip: false,
    });
  });

  it('holds a tripped item while its state is the one it tripped on', () => {
    expect(decideAdmission({ tripped_at: t2, tripped_fingerprint: 'fp' }, 'fp')).toEqual({
      allowed: false,
      trippedAt: t2,
    });
  });

  it('holds a tripped item whose state cannot be read', () => {
    expect(decideAdmission({ tripped_at: t2, tripped_fingerprint: 'fp' }, null).allowed).toBe(
      false
    );
  });

  it('admits and clears a tripped item whose state has moved', () => {
    expect(decideAdmission({ tripped_at: t2, tripped_fingerprint: 'fp' }, 'fp-2')).toEqual({
      allowed: true,
      clearTrip: true,
    });
  });
});

describe('decideCompletedAttempt', () => {
  const fresh = {
    no_progress_count: 0,
    last_counted_at: null,
    last_fingerprint: null,
    tripped_at: null,
    trip_count: 0,
  };

  it('counts a completed attempt that left the state unchanged', () => {
    const d = decideCompletedAttempt(fresh, attempt());
    expect(d.outcome).toBe('no_progress');
    expect(d.count).toBe(1);
    expect(d.update).toMatchObject({ no_progress_count: 1, last_counted_at: t2 });
  });

  it('trips at the limit, once', () => {
    const two = { ...fresh, no_progress_count: 2, last_counted_at: t0, last_fingerprint: 'fp-a' };
    const d = decideCompletedAttempt(two, attempt());
    expect(DEFAULT_NO_PROGRESS_LIMIT).toBe(3);
    expect(d.outcome).toBe('tripped');
    expect(d.update).toMatchObject({
      no_progress_count: 3,
      tripped_at: t2,
      tripped_fingerprint: 'fp-a',
      last_tripped_at: t2,
      trip_count: 1,
    });

    // A queued attempt that still completes after the trip counts, but does
    // not trip (or announce) a second time.
    const tripped = { ...two, no_progress_count: 3, last_counted_at: t0, tripped_at: t0 };
    const again = decideCompletedAttempt(tripped, attempt());
    expect(again.outcome).toBe('no_progress');
    expect(again.update).not.toHaveProperty('tripped_at');
  });

  it('resets on progress during the turn and clears a trip', () => {
    const tripped = {
      ...fresh,
      no_progress_count: 3,
      last_counted_at: t0,
      last_fingerprint: 'fp-a',
      tripped_at: t0,
    };
    const d = decideCompletedAttempt(tripped, attempt({ fingerprintNow: 'fp-b' }));
    expect(d.outcome).toBe('progress');
    expect(d.count).toBe(0);
    expect(d.update).toMatchObject({ no_progress_count: 0, tripped_at: null });
  });

  it('starts the run again when the state moved between attempts', () => {
    // Someone else changed the item after the last counted attempt.
    const two = { ...fresh, no_progress_count: 2, last_counted_at: t0, last_fingerprint: 'fp-a' };
    const d = decideCompletedAttempt(
      two,
      attempt({ fingerprintAtDispatch: 'fp-b', fingerprintNow: 'fp-b' })
    );
    expect(d.outcome).toBe('no_progress');
    expect(d.count).toBe(1);
  });

  it('ignores an attempt queued behind one already counted', () => {
    const counted = {
      ...fresh,
      no_progress_count: 1,
      last_counted_at: t2,
      last_fingerprint: 'fp-a',
    };
    const d = decideCompletedAttempt(counted, attempt({ dispatchedAt: t1, completedAt: t3 }));
    expect(d.outcome).toBe('duplicate');
    expect(d.update).toBeNull();
    expect(d.count).toBe(1);
  });

  it('counts nothing when the state cannot be read', () => {
    const d = decideCompletedAttempt(fresh, attempt({ fingerprintNow: null }));
    expect(d.outcome).toBe('unknown');
    expect(d.update).toBeNull();
  });

  it('honours a configured limit', () => {
    expect(decideCompletedAttempt(fresh, attempt(), 1).outcome).toBe('tripped');
  });
});

const tag: WakeSourceTag = {
  source: 'strategy_watchdog',
  workKind: 'task_group',
  workId: '00000000-0000-4000-8000-000000000001',
  revision: '',
  fingerprint: 'fp-a',
  dispatchedAt: t1,
  taskGroupId: '00000000-0000-4000-8000-000000000001',
  ownerSbId: null,
};

describe('parseWakeSourceTag', () => {
  it('reads a complete tag', () => {
    expect(parseWakeSourceTag({ wakeSource: tag })).toEqual(tag);
  });

  it('refuses a tag with an unknown source, kind or a missing field', () => {
    expect(parseWakeSourceTag({ wakeSource: { ...tag, source: 'heartbeat' } })).toBeNull();
    expect(parseWakeSourceTag({ wakeSource: { ...tag, workKind: 'thread' } })).toBeNull();
    expect(parseWakeSourceTag({ wakeSource: { ...tag, fingerprint: '' } })).toBeNull();
    expect(parseWakeSourceTag({ wakeSource: { ...tag, dispatchedAt: 'later' } })).toBeNull();
    expect(parseWakeSourceTag({})).toBeNull();
    expect(parseWakeSourceTag(undefined)).toBeNull();
  });
});

describe('recordWakeSourceCompletion', () => {
  function fakeBreaker() {
    return {
      recordCompletedAttempt: vi.fn().mockResolvedValue({ outcome: 'no_progress', count: 1 }),
    } as unknown as WakeSourceBreaker & {
      recordCompletedAttempt: ReturnType<typeof vi.fn>;
    };
  }

  it('records a tagged wake', async () => {
    const breaker = fakeBreaker();
    const result = await recordWakeSourceCompletion(
      {} as never,
      'user-1',
      { wakeSource: tag, triggerTurnCompleted: true },
      breaker
    );
    expect(result).toEqual({ outcome: 'no_progress', count: 1 });
    expect(breaker.recordCompletedAttempt).toHaveBeenCalledWith('user-1', tag);
  });

  it('never counts a heartbeat, however many nothing-due checks it runs', async () => {
    const breaker = fakeBreaker();
    for (let i = 0; i < 3; i += 1) {
      const result = await recordWakeSourceCompletion(
        {} as never,
        'user-1',
        { triggerType: 'heartbeat', reminderId: 'r-1', triggerTurnCompleted: true },
        breaker
      );
      expect(result).toBeNull();
    }
    expect(breaker.recordCompletedAttempt).not.toHaveBeenCalled();
  });

  it('never counts a human message or a reply', async () => {
    const breaker = fakeBreaker();
    expect(await recordWakeSourceCompletion({} as never, 'user-1', {}, breaker)).toBeNull();
    expect(await recordWakeSourceCompletion({} as never, 'user-1', undefined, breaker)).toBeNull();
    expect(breaker.recordCompletedAttempt).not.toHaveBeenCalled();
  });
});
