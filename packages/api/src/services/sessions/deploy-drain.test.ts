import { describe, expect, it, vi } from 'vitest';
import { DeployDrainGate } from './deploy-drain.js';
import type { DrainAdmission, DrainBlocker } from './deploy-drain.types.js';

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
