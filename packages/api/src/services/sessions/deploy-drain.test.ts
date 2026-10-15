import { describe, expect, it, vi } from 'vitest';
import { DeployDrainGate } from './deploy-drain.js';
import type {
  DrainAdmission,
  DrainAdmissionObservation,
  DrainBlocker,
} from './deploy-drain.types.js';

const admission = (id = 'synthetic-turn'): DrainAdmission => ({ id, kind: 'turn' });

describe('DeployDrainGate (unwired foundation)', () => {
  it('defaults to incomplete coverage, not permission to restart an empty process', () => {
    const gate = new DeployDrainGate('process-a');
    gate.beginDrain();
    expect(gate.snapshot()).toMatchObject({
      mode: 'draining',
      ready: false,
      blockers: [{ kind: 'coverage-gap', id: 'census-not-wired' }],
    });
    expect(gate.snapshot().receipt).toBeUndefined();
  });

  it.each(['', '  '])('refuses an empty process incarnation %j', (incarnation) => {
    expect(() => new DeployDrainGate(incarnation)).toThrow('process incarnation');
  });

  it('cannot be ready in open mode, even with no tracked work', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    expect(gate.snapshot()).toMatchObject({ mode: 'open', ready: false });
    expect(gate.snapshot().receipt).toBeUndefined();
  });

  it('starts idempotently, but a cancelled attempt cannot cancel the next one', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    const first = gate.beginDrain()!;
    const revision = gate.snapshot().revision;
    expect(gate.beginDrain()).toEqual(first);
    expect(gate.snapshot().revision).toBe(revision);
    expect(gate.cancelDrain({ ...first, incarnation: 'process-b' })).toBe(false);
    expect(gate.cancelDrain(first)).toBe(true);
    expect(gate.cancelDrain(first)).toBe(false);
    const second = gate.beginDrain()!;
    expect(second.attempt).toBe(first.attempt + 1);
    expect(gate.cancelDrain(first)).toBe(false);
  });

  it.each(['turn', 'compaction', 'child-turn'] as const)(
    'refuses new %s reservations while draining, sealed and shut down',
    (kind) => {
      const gate = new DeployDrainGate('process-a', () => []);
      gate.beginDrain();
      expect(gate.reserveAdmission({ id: 'new', kind })).toBeUndefined();
      gate.sealDrain(gate.snapshot().receipt!);
      expect(gate.reserveAdmission({ id: 'new', kind })).toBeUndefined();
      gate.closeForShutdown();
      expect(gate.reserveAdmission({ id: 'new', kind })).toBeUndefined();
    }
  );

  it('retains a pre-drain reservation until preparation cleanup, without registering it', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    const reserved = gate.reserveAdmission(admission())!;
    gate.beginDrain();
    const register = vi.fn(() => true);
    expect(gate.commitAdmission(reserved, register)).toEqual({
      status: 'refused',
      reason: 'admission-closed',
    });
    expect(register).not.toHaveBeenCalled();
    expect(gate.snapshot()).toMatchObject({
      ready: false,
      blockers: [{ kind: 'reservation', id: 'synthetic-turn' }],
    });
    expect(gate.releaseReservation(reserved)).toBe(true);
    expect(gate.snapshot().ready).toBe(true);
    expect(gate.releaseReservation(reserved)).toBe(false);
  });

  it('observes synthetic canonical-owner continuation/finalization without revoking it', () => {
    const blockers: DrainBlocker[] = [];
    const gate = new DeployDrainGate('process-a', () => blockers);
    const reserved = gate.reserveAdmission(admission())!;
    expect(
      gate.commitAdmission(reserved, () => {
        blockers.push({ kind: 'executing-turn', id: reserved.id });
        return true;
      })
    ).toEqual({ status: 'committed' });
    gate.beginDrain();
    expect(gate.snapshot().ready).toBe(false);
    // Synthetic canonical-owner census, not a second execution owner in the gate.
    blockers[0] = { kind: 'unfinalized-turn', id: reserved.id };
    blockers.push({ kind: 'effect-write', id: 'reply-receipt' });
    expect(gate.snapshot().blockers).toHaveLength(2);
    blockers.shift();
    expect(gate.snapshot().ready).toBe(false);
    blockers.pop();
    expect(gate.snapshot().ready).toBe(true);
    expect(gate.commitAdmission(reserved, () => true).status).toBe('refused');
  });

  it('does not transfer the reservation until synchronous registration succeeds', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    const reserved = gate.reserveAdmission(admission())!;
    expect(gate.commitAdmission(reserved, () => false)).toEqual({
      status: 'refused',
      reason: 'registration-refused',
    });
    expect(gate.snapshot().blockers).toHaveLength(1);
    expect(gate.commitAdmission(reserved, () => true)).toEqual({ status: 'committed' });
    expect(gate.snapshot().blockers).toHaveLength(0);
  });

  it('uses unforgeable local reservation handles, not equality of their printed IDs', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    const input = admission();
    const reserved = gate.reserveAdmission(input)!;
    expect(Object.isFrozen(reserved)).toBe(true);
    expect(gate.reserveAdmission(input)).toBeUndefined();
    const register = vi.fn(() => true);
    expect(gate.commitAdmission({ ...reserved }, register).status).toBe('refused');
    expect(gate.releaseReservation(input)).toBe(false);
    expect(register).not.toHaveBeenCalled();
    expect(gate.commitAdmission(reserved, register).status).toBe('committed');
    expect(gate.commitAdmission(reserved, register).status).toBe('refused');
    expect(register).toHaveBeenCalledTimes(1);
  });

  it.each([
    { id: '', kind: 'turn' },
    { id: '  ', kind: 'turn' },
    { id: 'synthetic', kind: 'unexpected' },
  ])('refuses malformed admission metadata %j', (value) => {
    const gate = new DeployDrainGate('process-a', () => []);
    expect(gate.reserveAdmission(value as DrainAdmission)).toBeUndefined();
    expect(gate.snapshot().blockers).toEqual([]);
  });

  it('keeps thrown registration unknown without echoing the exception or retrying it', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    const reserved = gate.reserveAdmission(admission())!;
    const register = vi.fn(() => {
      throw new Error('synthetic-private-body');
    });
    expect(gate.commitAdmission(reserved, register)).toEqual({
      status: 'unknown',
      reason: 'registration-threw',
    });
    expect(gate.commitAdmission(reserved, register)).toEqual({
      status: 'unknown',
      reason: 'previous-unknown',
    });
    expect(register).toHaveBeenCalledTimes(1);
    expect(gate.releaseReservation(reserved)).toBe(false);
    const attempt = gate.beginDrain()!;
    expect(gate.snapshot().ready).toBe(false);
    expect(JSON.stringify(gate.snapshot())).not.toContain('synthetic-private-body');
    expect(gate.cancelDrain(attempt)).toBe(true);
    expect(gate.snapshot().blockers).toEqual([{ kind: 'unknown', id: reserved.id }]);
  });

  it('keeps a non-boolean registration result unknown (no async handoff)', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    const reserved = gate.reserveAdmission(admission())!;
    const invalid = (() => Promise.resolve(true)) as unknown as () => boolean;
    expect(gate.commitAdmission(reserved, invalid)).toEqual({
      status: 'unknown',
      reason: 'invalid-registration-result',
    });
    expect(gate.releaseReservation(reserved)).toBe(false);
  });

  it('cannot release or double-commit a reservation inside its registration callback', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    const reserved = gate.reserveAdmission(admission())!;
    const nested = vi.fn(() => true);
    expect(
      gate.commitAdmission(reserved, () => {
        expect(gate.releaseReservation(reserved)).toBe(false);
        expect(gate.commitAdmission(reserved, nested).status).toBe('unknown');
        return true;
      }).status
    ).toBe('committed');
    expect(nested).not.toHaveBeenCalled();
  });

  it('retains an unknown hold when registration reenters the drain gate', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    const reserved = gate.reserveAdmission(admission())!;
    expect(
      gate.commitAdmission(reserved, () => {
        gate.beginDrain();
        return true;
      })
    ).toEqual({ status: 'unknown', reason: 'gate-changed' });
    expect(gate.releaseReservation(reserved)).toBe(false);
    expect(gate.snapshot()).toMatchObject({
      ready: false,
      blockers: [{ kind: 'unknown', id: reserved.id }],
    });
  });

  it.each([
    'executing-turn',
    'unfinalized-turn',
    'owned-child',
    'state-write',
    'effect-write',
    'compaction',
    'launch-hold',
    'coverage-gap',
    'unknown',
  ] as const)('a %s blocker prevents readiness and sealing', (kind) => {
    const blocker: DrainBlocker = { kind, id: 'synthetic-obligation' };
    const gate = new DeployDrainGate('process-a', () => [blocker]);
    gate.beginDrain();
    const snapshot = gate.snapshot();
    expect(snapshot.ready).toBe(false);
    expect(snapshot.blockers).toEqual([blocker]);
    expect(gate.sealDrain(snapshot)).toBeUndefined();
  });

  it('copies census records rather than exposing mutable registry entries', () => {
    const blocker = { kind: 'state-write' as const, id: 'write-1' };
    const gate = new DeployDrainGate('process-a', () => [blocker]);
    gate.beginDrain();
    const snapshot = gate.snapshot();
    (snapshot.blockers[0] as { id: string }).id = 'changed-outside';
    expect(blocker.id).toBe('write-1');
    expect(gate.snapshot().blockers[0].id).toBe('write-1');
  });

  it.each(
    [undefined, null, {}, [{ kind: 'other', id: 'x' }], [null], [{ kind: 'unknown', id: ' ' }]].map(
      (invalid) => ({ invalid })
    )
  )('an invalid census $invalid fails closed', ({ invalid }) => {
    const gate = new DeployDrainGate('process-a', () => invalid as readonly DrainBlocker[]);
    gate.beginDrain();
    expect(gate.snapshot()).toMatchObject({
      ready: false,
      blockers: [{ kind: 'unknown', id: 'census-unavailable' }],
    });
  });

  it('a throwing census fails closed without including its error body', () => {
    const gate = new DeployDrainGate('process-a', () => {
      throw new Error('synthetic-private-census');
    });
    gate.beginDrain();
    expect(gate.snapshot().ready).toBe(false);
    expect(JSON.stringify(gate.snapshot())).not.toContain('synthetic-private-census');
  });

  it('a reentrant census cannot erase the reservation it just created from the snapshot', () => {
    const gate = new DeployDrainGate('process-a', () => {
      gate.cancelDrain({ incarnation: 'process-a', attempt: 1 });
      gate.reserveAdmission(admission());
      gate.beginDrain();
      return [];
    });
    gate.beginDrain();
    expect(gate.snapshot()).toMatchObject({
      ready: false,
      blockers: [{ kind: 'unknown', id: 'census-mutated-gate' }],
    });
  });

  it('rechecks the canonical census between observation, seal and restart', () => {
    const blockers: DrainBlocker[] = [];
    const gate = new DeployDrainGate('process-a', () => blockers);
    const attempt = gate.beginDrain()!;
    const observed = gate.snapshot().receipt!;
    expect(gate.isRestartReady(observed)).toBe(false);
    blockers.push({ kind: 'owned-child', id: 'child' });
    expect(gate.sealDrain(observed)).toBeUndefined();
    blockers.pop();
    const sealed = gate.sealDrain(gate.snapshot().receipt!)!;
    expect(sealed.revision).toBeGreaterThan(observed.revision);
    expect(gate.isRestartReady(observed)).toBe(false);
    expect(gate.isRestartReady(sealed)).toBe(true);
    expect(gate.cancelDrain(attempt)).toBe(false);
    expect(gate.beginDrain()).toEqual(attempt);
    blockers.push({ kind: 'effect-write', id: 'late-receipt' });
    expect(gate.isRestartReady(sealed)).toBe(false);
    expect(gate.snapshot().ready).toBe(false);
    expect(gate.cancelDrain(attempt)).toBe(false);
  });

  it('refuses ready receipts from an earlier attempt and another process incarnation', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    const first = gate.beginDrain()!;
    const receipt = gate.snapshot().receipt!;
    gate.cancelDrain(first);
    gate.beginDrain();
    expect(gate.sealDrain(receipt)).toBeUndefined();
    const fresh = gate.snapshot().receipt!;
    expect(gate.sealDrain({ ...fresh, revision: fresh.revision - 1 })).toBeUndefined();
    const other = new DeployDrainGate('process-b', () => []);
    other.beginDrain();
    expect(other.sealDrain(receipt)).toBeUndefined();
    expect(gate.sealDrain(fresh)).toBeDefined();
  });

  it('cannot seal or claim restart readiness if the census changes the gate', () => {
    let mutate = false;
    const gate = new DeployDrainGate('process-a', () => {
      if (mutate) gate.closeForShutdown();
      return [];
    });
    gate.beginDrain();
    const observed = gate.snapshot().receipt!;
    mutate = true;
    expect(gate.sealDrain(observed)).toBeUndefined();
    expect(gate.snapshot().mode).toBe('shutdown');
  });

  it('actual shutdown is terminal, from open, draining or sealed', () => {
    for (const mode of ['open', 'draining', 'sealed']) {
      const gate = new DeployDrainGate('process-a', () => []);
      if (mode !== 'open') gate.beginDrain();
      const sealed = mode === 'sealed' ? gate.sealDrain(gate.snapshot().receipt!) : undefined;
      gate.closeForShutdown();
      const snapshot = gate.snapshot();
      gate.closeForShutdown();
      expect(gate.snapshot()).toEqual(snapshot);
      expect(snapshot).toMatchObject({ mode: 'shutdown', ready: false });
      expect(gate.beginDrain()).toBeUndefined();
      expect(gate.cancelDrain(snapshot)).toBe(false);
      if (sealed) expect(gate.isRestartReady(sealed)).toBe(false);
    }
  });
});

describe('uncertain admission reconciliation (synthetic registry)', () => {
  const makeUnknown = (gate: DeployDrainGate, input = admission()) => {
    const reserved = gate.reserveAdmission(input)!;
    expect(
      gate.commitAdmission(reserved, () => {
        throw new Error('synthetic-registration-uncertainty');
      }).status
    ).toBe('unknown');
    return reserved;
  };
  const settled = (
    reservation: DrainAdmission,
    outcome: DrainAdmissionObservation['outcome'] = 'absent'
  ): DrainAdmissionObservation => ({
    admissionId: reservation.id,
    preparationSettled: true,
    outcome,
  });

  it('clears settled absent preparation, bumps revision, and invalidates the old handle', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    const reserved = makeUnknown(gate);
    gate.beginDrain();
    const before = gate.snapshot();
    expect(gate.reconcileAdmission(reserved, () => settled(reserved))).toEqual({
      status: 'reconciled',
      outcome: 'absent',
    });
    const after = gate.snapshot();
    expect(after).toMatchObject({ ready: true, blockers: [] });
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(gate.sealDrain(before)).toBeUndefined();
    const retry = vi.fn(() => settled(reserved));
    expect(gate.reconcileAdmission(reserved, retry)).toEqual({
      status: 'held',
      reason: 'not-unknown',
    });
    expect(gate.commitAdmission(reserved, () => true).status).toBe('refused');
    expect(retry).not.toHaveBeenCalled();
  });

  it.each([
    ['turn', 'executing-turn'],
    ['turn', 'unfinalized-turn'],
    ['child-turn', 'executing-turn'],
    ['compaction', 'compaction'],
  ] as const)(
    'transfers %s uncertainty to existing %s census coverage, never launches it',
    (kind, ownerKind) => {
      const blockers: DrainBlocker[] = [];
      const gate = new DeployDrainGate('process-a', () => blockers);
      const reserved = makeUnknown(gate, { id: 'owned', kind });
      blockers.push({ id: reserved.id, kind: ownerKind });
      gate.beginDrain();
      const revision = gate.snapshot().revision;
      expect(gate.reconcileAdmission(reserved, () => settled(reserved, 'registered'))).toEqual({
        status: 'reconciled',
        outcome: 'registered',
      });
      expect(gate.snapshot()).toMatchObject({ ready: false, blockers });
      expect(gate.snapshot().revision).toBeGreaterThan(revision);
      expect(gate.releaseReservation(reserved)).toBe(false);
      blockers.pop();
      expect(gate.snapshot().ready).toBe(true);
    }
  );

  it('may resolve positive ownership while an unrelated coverage gap still blocks readiness', () => {
    const gate = new DeployDrainGate('process-a', () => [
      { id: 'synthetic-turn', kind: 'executing-turn' },
      { id: 'other-source', kind: 'coverage-gap' },
    ]);
    const reserved = makeUnknown(gate);
    gate.beginDrain();
    expect(gate.reconcileAdmission(reserved, () => settled(reserved, 'registered')).status).toBe(
      'reconciled'
    );
    expect(gate.snapshot()).toMatchObject({ ready: false });
    expect(gate.snapshot().blockers).toHaveLength(2);
  });

  it.each(['absent', 'registered'] as const)(
    'cannot resolve %s without positive preparation quiescence',
    (outcome) => {
      const gate = new DeployDrainGate('process-a', () =>
        outcome === 'registered' ? [{ id: 'synthetic-turn', kind: 'executing-turn' }] : []
      );
      const reserved = makeUnknown(gate);
      expect(
        gate.reconcileAdmission(reserved, () => ({
          ...settled(reserved, outcome),
          preparationSettled: false,
        }))
      ).toEqual({ status: 'held', reason: 'unconfirmed' });
      expect(gate.releaseReservation(reserved)).toBe(false);
    }
  );

  it.each([
    'unknown',
    'reservation',
    'launch-hold',
    'coverage-gap',
    'owned-child',
    'effect-write',
  ] as const)('an absent claim cannot erase a same-ID canonical %s', (kind) => {
    const gate = new DeployDrainGate('process-a', () => [{ id: 'synthetic-turn', kind }]);
    const reserved = makeUnknown(gate);
    expect(gate.reconcileAdmission(reserved, () => settled(reserved))).toEqual({
      status: 'held',
      reason: 'unconfirmed',
    });
    expect(gate.snapshot().blockers).toHaveLength(2);
  });

  it.each(['unknown', 'coverage-gap'] as const)(
    'an incomplete census (%s) cannot establish absence',
    (kind) => {
      const gate = new DeployDrainGate('process-a', () => [{ id: 'different-id', kind }]);
      const reserved = makeUnknown(gate);
      expect(gate.reconcileAdmission(reserved, () => settled(reserved)).status).toBe('held');
      expect(gate.releaseReservation(reserved)).toBe(false);
    }
  );

  it('the default unwired census cannot release an absent claim', () => {
    const gate = new DeployDrainGate('process-a');
    const reserved = makeUnknown(gate);
    expect(gate.reconcileAdmission(reserved, () => settled(reserved)).status).toBe('held');
  });

  it.each(['unknown', 'coverage-gap', 'launch-hold', 'reservation'] as const)(
    'positive ownership does not override a same-ID %s',
    (kind) => {
      const gate = new DeployDrainGate('process-a', () => [
        { id: 'synthetic-turn', kind: 'executing-turn' },
        { id: 'synthetic-turn', kind },
      ]);
      const reserved = makeUnknown(gate);
      expect(gate.reconcileAdmission(reserved, () => settled(reserved, 'registered')).status).toBe(
        'held'
      );
      expect(gate.snapshot().blockers).toHaveLength(3);
    }
  );

  it.each(
    [
      [] as DrainBlocker[],
      [{ id: 'different', kind: 'executing-turn' }] as DrainBlocker[],
      [{ id: 'synthetic-turn', kind: 'compaction' }] as DrainBlocker[],
      [{ id: 'synthetic-turn', kind: 'owned-child' }] as DrainBlocker[],
    ].map((blockers) => ({ blockers }))
  )(
    'a registered claim needs matching execution ownership, not just any blocker ($blockers)',
    ({ blockers }) => {
      const gate = new DeployDrainGate('process-a', () => blockers);
      const reserved = makeUnknown(gate);
      expect(gate.reconcileAdmission(reserved, () => settled(reserved, 'registered')).status).toBe(
        'held'
      );
    }
  );

  it('does not treat a reserved-looking census ID as an internal failure sentinel', () => {
    const gate = new DeployDrainGate('process-a', () => [
      { id: 'census-unavailable', kind: 'executing-turn' },
    ]);
    const reserved = makeUnknown(gate, admission('census-unavailable'));
    expect(gate.reconcileAdmission(reserved, () => settled(reserved, 'registered')).status).toBe(
      'reconciled'
    );
    expect(gate.snapshot().blockers).toEqual([{ id: reserved.id, kind: 'executing-turn' }]);
  });

  it.each([
    null,
    undefined,
    {},
    Promise.resolve(true),
    { admissionId: 'wrong-id', preparationSettled: true, outcome: 'absent' },
    { admissionId: 'synthetic-turn', preparationSettled: true, outcome: 'unknown' },
    { admissionId: 'synthetic-turn', preparationSettled: 'yes', outcome: 'absent' },
  ])('retains uncertainty on malformed or ambiguous observation %j', (observation) => {
    const gate = new DeployDrainGate('process-a', () => []);
    const reserved = makeUnknown(gate);
    expect(
      gate.reconcileAdmission(reserved, () => observation as DrainAdmissionObservation).status
    ).toBe('held');
    expect(gate.snapshot().blockers).toEqual([{ kind: 'unknown', id: reserved.id }]);
  });

  it('retains a throwing observer without publishing its error or allowing retry dispatch', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    const reserved = makeUnknown(gate);
    const result = gate.reconcileAdmission(reserved, () => {
      throw new Error('synthetic-private-evidence');
    });
    expect(result).toEqual({ status: 'held', reason: 'evidence-unavailable' });
    expect(JSON.stringify({ result, state: gate.snapshot() })).not.toContain(
      'synthetic-private-evidence'
    );
    const register = vi.fn(() => true);
    expect(gate.commitAdmission(reserved, register).status).toBe('unknown');
    expect(register).not.toHaveBeenCalled();
  });

  it.each(['throw', 'malformed', 'sparse'] as const)(
    'retains uncertainty when census is %s',
    (fault) => {
      const gate = new DeployDrainGate('process-a', () => {
        if (fault === 'throw') throw new Error('synthetic-private-census');
        return (fault === 'sparse' ? Array(1) : [null]) as DrainBlocker[];
      });
      const reserved = makeUnknown(gate);
      expect(gate.reconcileAdmission(reserved, () => settled(reserved))).toEqual({
        status: 'held',
        reason: 'evidence-unavailable',
      });
      gate.beginDrain();
      expect(gate.snapshot().ready).toBe(false);
      expect(JSON.stringify(gate.snapshot())).not.toContain('synthetic-private-census');
    }
  );

  it.each(['observer', 'getter', 'census'] as const)(
    'retains the hold if the %s changes the gate',
    (source) => {
      const readCensus = vi.fn(() => {
        if (source === 'census') gate.closeForShutdown();
        return [];
      });
      const gate = new DeployDrainGate('process-a', readCensus);
      const reserved = makeUnknown(gate);
      const result = gate.reconcileAdmission(reserved, () => {
        if (source === 'observer') gate.beginDrain();
        return {
          ...settled(reserved),
          get outcome() {
            if (source === 'getter') gate.closeForShutdown();
            return 'absent' as const;
          },
        };
      });
      expect(result).toEqual({ status: 'held', reason: 'gate-changed' });
      // Do not consult a new authority source after observing a changed gate.
      expect(readCensus).toHaveBeenCalledTimes(source === 'census' ? 1 : 0);
      expect(gate.snapshot().blockers).toContainEqual({ kind: 'unknown', id: reserved.id });
    }
  );

  it('rejects nested resolution/release/commit while keeping the hold visible', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    const reserved = makeUnknown(gate);
    const nested = vi.fn(() => settled(reserved));
    expect(
      gate.reconcileAdmission(reserved, () => {
        expect(gate.snapshot().blockers).toEqual([{ kind: 'unknown', id: reserved.id }]);
        expect(gate.releaseReservation(reserved)).toBe(false);
        expect(gate.commitAdmission(reserved, () => true).status).toBe('unknown');
        expect(gate.reconcileAdmission(reserved, nested)).toEqual({
          status: 'held',
          reason: 'not-unknown',
        });
        return settled(reserved);
      }).status
    ).toBe('reconciled');
    expect(nested).not.toHaveBeenCalled();
  });

  it('rejects copied, pending and in-commit handles without invoking the observer', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    const unknown = makeUnknown(gate);
    const pending = gate.reserveAdmission(admission('pending'))!;
    const observe = vi.fn(() => settled(unknown));
    for (const handle of [{ ...unknown }, pending]) {
      expect(gate.reconcileAdmission(handle, observe)).toEqual({
        status: 'held',
        reason: 'not-unknown',
      });
    }
    gate.commitAdmission(pending, () => {
      expect(gate.reconcileAdmission(pending, observe)).toEqual({
        status: 'held',
        reason: 'not-unknown',
      });
      return false;
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it('rejects sealed and shutdown gates without consulting observations', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    const reserved = makeUnknown(gate);
    expect(gate.reconcileAdmission(reserved, () => settled(reserved)).status).toBe('reconciled');
    gate.beginDrain();
    gate.sealDrain(gate.snapshot().receipt!);
    const observe = vi.fn(() => settled(reserved));
    expect(gate.reconcileAdmission(reserved, observe)).toEqual({
      status: 'held',
      reason: 'gate-closed',
    });
    gate.closeForShutdown();
    expect(gate.reconcileAdmission(reserved, observe)).toEqual({
      status: 'held',
      reason: 'gate-closed',
    });
    expect(observe).not.toHaveBeenCalled();
  });
});

describe('explicit seal abandonment', () => {
  it('opens with a new attempt/revision and invalidates every old receipt', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    const attempt = gate.beginDrain()!;
    const ready = gate.snapshot().receipt!;
    const sealed = gate.sealDrain(ready)!;
    expect(gate.cancelDrain(attempt)).toBe(false);
    expect(gate.abandonSeal(sealed)).toBe(true);
    expect(gate.snapshot()).toMatchObject({
      mode: 'open',
      ready: false,
      attempt: sealed.attempt + 1,
      revision: sealed.revision + 1,
    });
    expect(gate.isRestartReady(sealed)).toBe(false);
    expect(gate.abandonSeal(sealed)).toBe(false);
    const newAttempt = gate.beginDrain()!;
    expect(newAttempt.attempt).toBeGreaterThan(sealed.attempt);
    expect(gate.cancelDrain(attempt)).toBe(false);
    expect(gate.sealDrain(ready)).toBeUndefined();
    const newSeal = gate.sealDrain(gate.snapshot().receipt!)!;
    expect(gate.abandonSeal(sealed)).toBe(false);
    expect(gate.isRestartReady(newSeal)).toBe(true);
  });

  it.each(['incarnation', 'attempt', 'revision'] as const)(
    'requires the exact sealed %s',
    (field) => {
      const gate = new DeployDrainGate('process-a', () => []);
      gate.beginDrain();
      const sealed = gate.sealDrain(gate.snapshot().receipt!)!;
      const wrong = {
        ...sealed,
        [field]: field === 'incarnation' ? 'process-b' : (sealed[field] as number) - 1,
      };
      const before = gate.snapshot();
      expect(gate.abandonSeal(wrong)).toBe(false);
      expect(gate.snapshot()).toEqual(before);
      expect(gate.isRestartReady(sealed)).toBe(true);
    }
  );

  it('can abandon a seal when a late external blocker makes restart unsafe', () => {
    const blockers: DrainBlocker[] = [];
    const gate = new DeployDrainGate('process-a', () => blockers);
    gate.beginDrain();
    const sealed = gate.sealDrain(gate.snapshot().receipt!)!;
    blockers.push({ id: 'late-write', kind: 'state-write' });
    expect(gate.isRestartReady(sealed)).toBe(false);
    expect(gate.abandonSeal(sealed)).toBe(true);
    expect(gate.snapshot().blockers).toEqual(blockers);
    expect(gate.reserveAdmission(admission())).toBeDefined();
  });

  it('does not substitute for cancel, and cannot undo actual shutdown', () => {
    const gate = new DeployDrainGate('process-a', () => []);
    expect(gate.abandonSeal(gate.snapshot())).toBe(false);
    gate.beginDrain();
    const ready = gate.snapshot().receipt!;
    expect(gate.abandonSeal(ready)).toBe(false);
    const sealed = gate.sealDrain(ready)!;
    gate.closeForShutdown();
    const before = gate.snapshot();
    expect(gate.abandonSeal(sealed)).toBe(false);
    expect(gate.snapshot()).toEqual(before);
  });
});
