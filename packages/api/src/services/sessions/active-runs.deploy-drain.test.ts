import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admitStateWrite,
  attachRunChild,
  clearActiveRunIfOwner,
  getActiveRun,
  isIntakeOpen,
  mayGenerationProceed,
  markRunnerSettled,
  readDeployDrainBlockers,
  registerActiveRun,
  resetActiveRuns,
  restoreActiveRunIfCurrent,
  trackStateWrite,
  turnDrainAdmissionId,
  widenActiveRunCandidates,
  type ActiveRun,
} from './active-runs.js';
import { DeployDrainGate } from './deploy-drain.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const run = (extra: Partial<ActiveRun> = {}): ActiveRun => ({
  sessionId: 'synthetic-session',
  userId: 'synthetic-user',
  sbSlug: 'synthetic-sb',
  backend: 'ink',
  startedAt: 1000,
  turnEpoch: 'synthetic-epoch',
  ...extra,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const obligations = () =>
  readDeployDrainBlockers().filter((entry) => entry.kind !== 'coverage-gap');

beforeEach(() => resetActiveRuns());
afterEach(() => resetActiveRuns());

describe('deploy census over actual in-process owner registries', () => {
  it('names every remaining coverage gap even with empty registries', () => {
    expect(readDeployDrainBlockers()).toEqual([
      { kind: 'coverage-gap', id: 'deploy:admission-preparation-and-pending-queues' },
      { kind: 'coverage-gap', id: 'deploy:compaction' },
      { kind: 'coverage-gap', id: 'deploy:launch-reservations-and-survivors' },
      { kind: 'coverage-gap', id: 'deploy:effect-and-delivery-writes' },
      { kind: 'coverage-gap', id: 'deploy:durable-ingress' },
    ]);
    const gate = new DeployDrainGate('synthetic-process', readDeployDrainBlockers);
    gate.beginDrain();
    expect(gate.snapshot().ready).toBe(false);
    expect(gate.sealDrain(gate.snapshot())).toBeUndefined();
  });

  it.each(['succeeded', 'failed', 'refused'] as const)(
    'keeps a %s runner as unfinalized until the canonical owner clears it',
    (outcome) => {
      const entry = run();
      const id = turnDrainAdmissionId(entry.sessionId, entry.turnEpoch!);
      registerActiveRun(entry);
      expect(obligations()).toEqual([{ kind: 'executing-turn', id }]);
      markRunnerSettled(entry.sessionId, outcome);
      expect(obligations()).toEqual([{ kind: 'unfinalized-turn', id }]);
      clearActiveRunIfOwner(entry.sessionId, 'wrong-epoch');
      expect(obligations()).toEqual([{ kind: 'unfinalized-turn', id }]);
      clearActiveRunIfOwner(entry.sessionId, entry.turnEpoch);
      expect(obligations()).toEqual([]);
    }
  );

  it('copies only census labels, without exposing owner objects, routing or callbacks', () => {
    const entry = run({
      threadKey: 'synthetic-private-thread',
      senderSlug: 'private-sender',
      hostedControls: vi.fn(),
      hostedSteering: vi.fn(),
    });
    registerActiveRun(entry);
    const snapshot = readDeployDrainBlockers();
    const first = snapshot[0]!;
    expect(Object.keys(first).sort()).toEqual(['id', 'kind']);
    expect(JSON.stringify(snapshot)).not.toContain('private');
    (first as { id: string }).id = 'changed';
    expect(getActiveRun(entry.sessionId)).toBe(entry);
    expect(obligations()[0]!.id).toBe(turnDrainAdmissionId(entry.sessionId, entry.turnEpoch!));
    expect(entry.hostedControls).not.toHaveBeenCalled();
    expect(entry.hostedSteering).not.toHaveBeenCalled();
  });

  it('keeps logical admission IDs unambiguous and distinct from physical child labels', () => {
    expect(turnDrainAdmissionId('a:b', 'c')).not.toBe(turnDrainAdmissionId('a', 'b:c'));
    expect(turnDrainAdmissionId('owned-child', '1')).not.toBe('owned-child:1');
  });

  it.each([undefined, '', ' '])('reports a missing/unusable epoch %j as unknown', (turnEpoch) => {
    registerActiveRun(run({ turnEpoch }));
    expect(obligations()).toEqual([
      { kind: 'unknown', id: JSON.stringify(['unfenced-turn', 'synthetic-session']) },
    ]);
  });

  it('reports widened takeover ownership as uncertain and follows canonical restoration', () => {
    const previous = run({ turnEpoch: 'old' });
    registerActiveRun(previous);
    const current = run({ turnEpoch: 'candidate' });
    registerActiveRun(current);
    widenActiveRunCandidates(current.sessionId, ['old']);
    const id = turnDrainAdmissionId(current.sessionId, 'candidate');
    expect(obligations()).toEqual([
      { kind: 'executing-turn', id },
      { kind: 'unknown', id },
    ]);
    expect(restoreActiveRunIfCurrent(previous, 'candidate')).toBe(true);
    expect(obligations()).toEqual([
      { kind: 'executing-turn', id: turnDrainAdmissionId(previous.sessionId, 'old') },
    ]);
  });

  it('does not treat a candidate set containing only the current epoch as widened', () => {
    registerActiveRun(run());
    widenActiveRunCandidates('synthetic-session', ['synthetic-epoch']);
    expect(obligations()).toHaveLength(1);
    expect(obligations()[0]!.kind).toBe('executing-turn');
  });

  it('reconciles an uncertain logical child turn against actual registration, not a physical child', () => {
    const entry = run();
    const id = turnDrainAdmissionId(entry.sessionId, entry.turnEpoch!);
    const gate = new DeployDrainGate('synthetic-process', readDeployDrainBlockers);
    const reserved = gate.reserveAdmission({ id, kind: 'child-turn' })!;
    expect(
      gate.commitAdmission(reserved, () => {
        expect(registerActiveRun(entry)).toBe(true);
        throw new Error('synthetic-lost-registration-ack');
      }).status
    ).toBe('unknown');
    gate.beginDrain();
    expect(
      gate.reconcileAdmission(reserved, () => ({
        admissionId: id,
        outcome: 'registered',
        preparationSettled: true,
      }))
    ).toEqual({ status: 'reconciled', outcome: 'registered' });
    expect(gate.snapshot().blockers).toContainEqual({ kind: 'executing-turn', id });
    expect(gate.snapshot().blockers).not.toContainEqual({ kind: 'unknown', id });
    expect(gate.snapshot().ready).toBe(false); // Real integration coverage still missing.
  });

  it('a census query and pre-deploy drain do not revoke current generation continuation or state writes', () => {
    const entry = run();
    registerActiveRun(entry);
    const gate = new DeployDrainGate('synthetic-process', readDeployDrainBlockers);
    gate.beginDrain();
    readDeployDrainBlockers();
    expect(isIntakeOpen()).toBe(true);
    expect(mayGenerationProceed(entry.sessionId, entry.turnEpoch!)).toBe(true);
    expect(admitStateWrite(entry.sessionId)).toBe(true);
  });

  it('keeps distinct stable child labels after turn settlement and another child release', () => {
    const entry = run();
    registerActiveRun(entry);
    const first = { abort: vi.fn(), settled: deferred<{ childExited: boolean }>().promise };
    const second = { abort: vi.fn(), settled: deferred<{ childExited: boolean }>().promise };
    const a = attachRunChild(entry.sessionId, entry.turnEpoch!, first)!;
    const b = attachRunChild(entry.sessionId, entry.turnEpoch!, second)!;
    const children = obligations().filter((x) => x.kind === 'owned-child');
    expect(children).toHaveLength(2);
    expect(new Set(children.map((x) => x.id)).size).toBe(2);
    for (const child of children)
      expect(JSON.parse(child.id)).toEqual([
        'owned-child',
        entry.sessionId,
        entry.turnEpoch,
        expect.any(Number),
      ]);
    markRunnerSettled(entry.sessionId, 'succeeded');
    clearActiveRunIfOwner(entry.sessionId, entry.turnEpoch);
    expect(obligations()).toEqual(children);
    a.release();
    expect(obligations()).toEqual([children[1]]);
    expect(first.abort).not.toHaveBeenCalled();
    expect(second.abort).not.toHaveBeenCalled();
    b.release();
    expect(obligations()).toEqual([]);
  });

  it('keeps a replaced generation child visible, without attributing it to its replacement', () => {
    const entry = run();
    registerActiveRun(entry);
    const child = attachRunChild(entry.sessionId, entry.turnEpoch!, {
      abort: vi.fn(),
      settled: deferred<{ childExited: boolean }>().promise,
    })!;
    const childBlocker = obligations().find((x) => x.kind === 'owned-child')!;
    registerActiveRun(run({ turnEpoch: 'new' }));
    clearActiveRunIfOwner(entry.sessionId, entry.turnEpoch);
    expect(obligations()).toEqual([
      { kind: 'executing-turn', id: turnDrainAdmissionId(entry.sessionId, 'new') },
      childBlocker,
    ]);
    child.release();
  });

  it('does not infer a physical exit from a settled-but-unreleased child promise', async () => {
    const entry = run();
    registerActiveRun(entry);
    const completion = deferred<{ childExited: boolean }>();
    const child = attachRunChild(entry.sessionId, entry.turnEpoch!, {
      abort: vi.fn(),
      settled: completion.promise,
    })!;
    completion.resolve({ childExited: false });
    await completion.promise;
    clearActiveRunIfOwner(entry.sessionId, entry.turnEpoch);
    expect(obligations()).toHaveLength(1);
    expect(obligations()[0]!.kind).toBe('owned-child');
    child.release(); // Test-owned cleanup, not exit inferred by the census.
  });

  it('keeps the aggregate write hold until all tracked writes settle, including rejection', async () => {
    const a = deferred<void>();
    const b = deferred<void>();
    const pa = trackStateWrite(a.promise);
    const pb = trackStateWrite(b.promise);
    const observedRejection = pb.catch(() => undefined);
    expect(pa).toBe(a.promise);
    expect(pb).toBe(b.promise);
    const hold = [{ kind: 'state-write', id: 'active-runs:lifecycle-writes' }];
    expect(obligations()).toEqual(hold);
    a.resolve();
    await pa;
    expect(obligations()).toEqual(hold);
    b.reject(new Error('synthetic-private-write'));
    await observedRejection;
    expect(obligations()).toEqual([]);
  });
});
