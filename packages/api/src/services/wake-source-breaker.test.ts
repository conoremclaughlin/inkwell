/**
 * The no-progress breaker's decisions (spec session-lifecycle-model §5).
 * The database round trip is in wake-source-breaker.integration.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_NO_PROGRESS_LIMIT,
  WakeSourceBreaker,
  decideAdmission,
  decideCompletedAttempt,
  issueWakeSourceTag,
  parseWakeSourceTag,
  recordWakeSourceCompletion,
  taskFingerprint,
  taskGroupFingerprint,
  type WakeSourceTagFields,
} from './wake-source-breaker';
import { makeFakeSupabase, type Row } from './sessions/fake-supabase';

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
    expect(taskFingerprint({ ...pendingTask, status: 'completed' })).not.toBe(base);
    expect(taskFingerprint({ ...pendingTask, status: 'blocked' })).not.toBe(base);
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

// Lumen, #725 finding 1. claim_graph_task moves a node pending -> in_progress
// (a verification gate open -> in_progress) and bumps gate_version;
// release_graph_claim moves both back and bumps gate_version again. A turn that
// only claims and releases changed nothing about the work.
describe('claim bookkeeping is not progress', () => {
  const openGate = {
    status: 'pending',
    outcome: null,
    gate_state: 'open',
    gate_attempt: 1,
    gate_version: 4,
    gate_request_revision: 0,
  };
  const claimedGate = {
    ...openGate,
    status: 'in_progress',
    gate_state: 'in_progress',
    gate_version: 5,
  };
  const releasedGate = { ...openGate, gate_version: 6 };

  it('a claimed node reads the same as an unclaimed one', () => {
    expect(taskFingerprint({ ...pendingTask, status: 'in_progress' })).toBe(
      taskFingerprint(pendingTask)
    );
    expect(taskFingerprint(claimedGate)).toBe(taskFingerprint(openGate));
    expect(taskFingerprint(releasedGate)).toBe(taskFingerprint(openGate));
  });

  it('three claim-and-release turns trip the breaker', () => {
    let row: Parameters<typeof decideCompletedAttempt>[0] = null;
    let gate = openGate;
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const before = taskFingerprint(gate);
      gate = { ...gate, gate_version: gate.gate_version + 2 };
      const d = decideCompletedAttempt(row, {
        dispatchedAt: new Date(Date.UTC(2026, 9, 2, 12, i * 2)).toISOString(),
        completedAt: new Date(Date.UTC(2026, 9, 2, 12, i * 2 + 1)).toISOString(),
        fingerprintAtDispatch: before,
        fingerprintNow: taskFingerprint(gate),
      });
      outcomes.push(d.outcome);
      row = { ...(row ?? { trip_count: 0, tripped_at: null }), ...d.update } as typeof row;
    }
    expect(outcomes).toEqual(['no_progress', 'no_progress', 'tripped']);
  });

  it('a completion read before the boundary release lands is still no progress', () => {
    // The run-boundary release is fire-and-forget, so the completion can read
    // the node while the turn's claim is still on it.
    const d = decideCompletedAttempt(null, {
      dispatchedAt: '2026-10-02T12:00:00.000Z',
      completedAt: '2026-10-02T12:01:00.000Z',
      fingerprintAtDispatch: taskFingerprint(openGate),
      fingerprintNow: taskFingerprint(claimedGate),
    });
    expect(d.outcome).toBe('no_progress');
  });

  it('control: a verdict, completion, retry, outcome or new revision is progress', () => {
    const base = taskFingerprint(openGate);
    expect(taskFingerprint({ ...openGate, status: 'completed', gate_state: 'passed' })).not.toBe(
      base
    );
    expect(taskFingerprint({ ...openGate, gate_state: 'failed' })).not.toBe(base);
    expect(taskFingerprint({ ...openGate, gate_attempt: 2 })).not.toBe(base);
    expect(taskFingerprint({ ...openGate, outcome: 'skipped' })).not.toBe(base);
    expect(taskFingerprint({ ...openGate, gate_request_revision: 1 })).not.toBe(base);
    expect(taskFingerprint({ ...openGate, gate_state: 'not_ready' })).not.toBe(base);
  });

  it('in a strategy group, a task taken up is not progress and a task finished is', () => {
    const group = { status: 'active', current_task_index: 0 };
    const a = { id: 'a', status: 'pending', outcome: null };
    const base = taskGroupFingerprint(group, [a]);
    expect(taskGroupFingerprint(group, [{ ...a, status: 'in_progress' }])).toBe(base);
    expect(taskGroupFingerprint(group, [{ ...a, status: 'completed' }])).not.toBe(base);
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

const tagFields: WakeSourceTagFields = {
  source: 'strategy_watchdog',
  workKind: 'task_group',
  workId: '00000000-0000-4000-8000-000000000001',
  revision: '',
  fingerprint: 'fp-a',
  dispatchedAt: t1,
  taskGroupId: '00000000-0000-4000-8000-000000000001',
  ownerSbId: null,
};
const tag = issueWakeSourceTag(tagFields);

describe('parseWakeSourceTag', () => {
  it('reads a tag this server issued', () => {
    expect(parseWakeSourceTag({ wakeSource: tag })).toEqual(tag);
  });

  // Lumen, #725 finding 2: a caller-written tag must never count.
  it('refuses a tag nobody signed, or one changed after it was signed', () => {
    expect(parseWakeSourceTag({ wakeSource: tagFields })).toBeNull();
    expect(parseWakeSourceTag({ wakeSource: { ...tag, fingerprint: 'fp-b' } })).toBeNull();
    expect(parseWakeSourceTag({ wakeSource: { ...tag, ownerSbId: 'someone-else' } })).toBeNull();
    expect(parseWakeSourceTag({ wakeSource: { ...tag, signature: 'a'.repeat(64) } })).toBeNull();
    expect(parseWakeSourceTag({ wakeSource: { ...tag, signature: 'not-hex' } })).toBeNull();
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

  it('never counts a tag a caller wrote into metadata', async () => {
    const breaker = fakeBreaker();
    expect(
      await recordWakeSourceCompletion({} as never, 'user-1', { wakeSource: tagFields }, breaker)
    ).toBeNull();
    expect(breaker.recordCompletedAttempt).not.toHaveBeenCalled();
  });

  it('never counts a human message or a reply', async () => {
    const breaker = fakeBreaker();
    expect(await recordWakeSourceCompletion({} as never, 'user-1', {}, breaker)).toBeNull();
    expect(await recordWakeSourceCompletion({} as never, 'user-1', undefined, breaker)).toBeNull();
    expect(breaker.recordCompletedAttempt).not.toHaveBeenCalled();
  });
});

// Lumen, #725 finding 4. A completion reads the row (count 2, version 0) and
// pauses before its compare-and-set; a reset clears the row in between. The
// completion must not write its stale count back over the reset.
describe('a reset fences a completion that read the row before it', () => {
  const groupId = '00000000-0000-4000-8000-000000000002';
  const nodeFields: WakeSourceTagFields = {
    source: 'graph_dispatch',
    workKind: 'graph_node',
    workId: '00000000-0000-4000-8000-000000000003',
    revision: '0',
    fingerprint: 'same',
    dispatchedAt: '2026-10-02T12:00:00.000Z',
    taskGroupId: groupId,
    ownerSbId: null,
  };

  function rig(nowIso: string) {
    const row: Row = {
      id: 'breaker-1',
      user_id: 'user-1',
      source: 'graph_dispatch',
      work_kind: 'graph_node',
      work_id: nodeFields.workId,
      revision: '0',
      task_group_id: groupId,
      version: 0,
      no_progress_count: 2,
      last_counted_at: null,
      last_fingerprint: 'same',
      tripped_at: null,
      tripped_fingerprint: null,
      trip_count: 0,
    };
    const client = makeFakeSupabase({ wake_source_breakers: [row] });
    const breaker = new WakeSourceBreaker({ getClient: () => client } as never, {
      now: () => new Date(nowIso),
    });
    vi.spyOn(breaker, 'readFingerprint').mockResolvedValue('same');
    // Hold the completion between its read and its write.
    const internals = breaker as unknown as {
      writeRow: (...args: unknown[]) => Promise<void>;
      notifyTrip: (...args: unknown[]) => Promise<void>;
    };
    internals.notifyTrip = vi.fn(async () => undefined);
    const write = internals.writeRow.bind(breaker);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const ready = new Promise<void>((r) => (entered = r));
    let first = true;
    internals.writeRow = async (...args: unknown[]) => {
      if (first) {
        first = false;
        entered();
        await held;
      }
      return write(...args);
    };
    return { row, breaker, release, ready };
  }

  const resets = {
    reset: (b: WakeSourceBreaker) =>
      b.reset({
        userId: 'user-1',
        source: 'graph_dispatch',
        workKind: 'graph_node',
        workId: nodeFields.workId,
        revision: '0',
      }),
    resetGroup: (b: WakeSourceBreaker) => b.resetGroup('user-1', 'graph_dispatch', groupId),
  };

  for (const [entry, doReset] of Object.entries(resets)) {
    it(`${entry}: the stale completion is excluded, never written back`, async () => {
      const { row, breaker, release, ready } = rig('2026-10-02T12:01:00.000Z');
      const pending = breaker.recordCompletedAttempt('user-1', issueWakeSourceTag(nodeFields));
      await ready;
      await doReset(breaker);
      expect(row.no_progress_count).toBe(0);
      expect(row.version).toBe(1);
      release();
      const result = await pending;
      expect(result.outcome).toBe('duplicate');
      expect(row.no_progress_count).toBe(0);
      expect(row.tripped_at).toBeNull();
    });
  }

  it('control: an attempt dispatched after the reset counts from zero', async () => {
    const { row, breaker, release } = rig('2026-10-02T12:01:00.000Z');
    release();
    await resets.reset(breaker);
    const result = await breaker.recordCompletedAttempt(
      'user-1',
      issueWakeSourceTag({ ...nodeFields, dispatchedAt: '2026-10-02T12:02:00.000Z' })
    );
    expect(result).toEqual({ outcome: 'no_progress', count: 1 });
    expect(row.no_progress_count).toBe(1);
  });
});
