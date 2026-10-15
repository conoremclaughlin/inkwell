import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolSettlementSupervisor } from './tool-settlement-supervisor.js';

const owner = {
  sessionId: 'synthetic-session',
  turnId: 'synthetic-turn',
  attemptId: 'synthetic-attempt',
};
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(maxActiveAttempts = 2) {
  const supervisor = new ToolSettlementSupervisor({
    sessionId: owner.sessionId,
    maxActiveAttempts,
  });
  const work = deferred();
  const requestStop = vi.fn(() => undefined);
  const lease = supervisor.track(owner, { settled: work.promise, requestStop });
  return { supervisor, work, requestStop, lease };
}

afterEach(() => vi.useRealTimers());

describe('session tool settlement supervisor (promise fixtures only)', () => {
  it('keeps generation, admission, deadline and actual settlement distinct', async () => {
    vi.useFakeTimers();
    const h = fixture();
    h.lease.markGenerationEnded();
    h.lease.closeAdmission();
    const waiting = h.lease.wait(25);
    await vi.advanceTimersByTimeAsync(25);
    expect(await waiting).toMatchObject({
      generationEnded: true,
      admission: 'closed',
      waitExpired: true,
      resources: 'live',
      stopRequested: false,
    });
    expect(h.supervisor.observe()).toHaveLength(1);
    expect(h.requestStop).not.toHaveBeenCalled();
    h.work.resolve();
    expect(await h.lease.wait(25)).toMatchObject({ resources: 'settled', waitExpired: true });
    expect(h.supervisor.observe()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops once and retains an abort-ignoring owner until actual settlement', async () => {
    vi.useFakeTimers();
    const h = fixture();
    const waiting = h.supervisor.stopAndWait(10);
    h.lease.requestStop();
    expect(h.requestStop).toHaveBeenCalledOnce();
    expect(() =>
      h.supervisor.track(
        { ...owner, attemptId: 'new' },
        { settled: Promise.resolve(), requestStop: () => undefined }
      )
    ).toThrow('closing');
    await vi.advanceTimersByTimeAsync(10);
    expect(await waiting).toMatchObject([
      { owner, resources: 'live', admission: 'closed', stopRequested: true, waitExpired: true },
    ]);
    h.work.resolve();
    await h.lease.wait(10);
    expect(h.supervisor.observe()).toEqual([]);
  });

  it('does not transfer a late settlement to a newer turn', async () => {
    const h = fixture();
    const later = deferred();
    const laterOwner = {
      ...owner,
      turnId: 'synthetic-newer-turn',
      attemptId: 'synthetic-newer-attempt',
    };
    const second = h.supervisor.track(laterOwner, {
      settled: later.promise,
      requestStop: () => undefined,
    });
    await h.lease.wait(0);
    h.work.resolve();
    await h.lease.wait(0);
    expect(h.supervisor.observe()).toEqual([second.observe()]);
    expect(second.observe()).toMatchObject({
      owner: laterOwner,
      waitExpired: false,
      resources: 'live',
    });
    later.resolve();
    await second.wait(0);
    expect(h.supervisor.observe()).toEqual([]);
  });

  it('bounds owners and rejects duplicate or mismatched ownership', async () => {
    const h = fixture(1);
    const ports = { settled: Promise.resolve(), requestStop: () => undefined };
    expect(() => h.supervisor.track(owner, ports)).toThrow('already live');
    expect(() => h.supervisor.track({ ...owner, sessionId: 'other' }, ports)).toThrow('session');
    expect(() => h.supervisor.track({ ...owner, attemptId: 'next' }, ports)).toThrow('capacity');
    h.work.resolve();
    await h.lease.wait(0);
    const next = h.supervisor.track({ ...owner, attemptId: 'next' }, ports);
    await next.wait(0);
    expect(h.supervisor.observe()).toEqual([]);
  });

  it('returns copied observations and captures the owner identity at admission', async () => {
    const supervisor = new ToolSettlementSupervisor({
      sessionId: owner.sessionId,
      maxActiveAttempts: 1,
    });
    const work = deferred();
    const supplied = { ...owner };
    const lease = supervisor.track(supplied, {
      settled: work.promise,
      requestStop: () => undefined,
    });
    supplied.turnId = 'changed';
    const observed = supervisor.observe();
    observed[0]!.owner.turnId = 'tampered';
    observed[0]!.resources = 'settled';
    expect(supervisor.observe()[0]).toMatchObject({ owner, resources: 'live' });
    work.resolve();
    await lease.wait(0);
    expect(supervisor.observe()).toEqual([]);
  });

  it('keeps cleanup rejection visible and requires positive reconciliation', async () => {
    const h = fixture();
    await expect(h.lease.reconcile(async () => true)).rejects.toThrow('reconciliation');
    h.work.reject(new Error('synthetic resource release failure'));
    expect(await h.lease.wait(0)).toMatchObject({
      resources: 'reconciliation-required',
      waitExpired: false,
    });
    expect(await h.lease.reconcile(async () => false)).toBe(false);
    expect(
      await h.lease.reconcile(() => {
        throw new Error('synthetic confirmation failure');
      })
    ).toBe(false);
    expect(h.supervisor.observe()).toHaveLength(1);
    expect(await h.lease.reconcile(async () => true)).toBe(true);
    expect(h.supervisor.observe()).toEqual([]);
  });

  it('shares an in-flight reconciliation without invoking cleanup twice', async () => {
    const h = fixture();
    h.work.reject(new Error('synthetic release failure'));
    await h.lease.wait(0);
    const release = deferred();
    const confirm = vi.fn(async () => {
      await release.promise;
      return true;
    });
    const first = h.lease.reconcile(confirm);
    const second = h.lease.reconcile(confirm);
    expect(first).toBe(second);
    release.resolve();
    await first;
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('reports a throwing stop port without hiding its live owner', async () => {
    const supervisor = new ToolSettlementSupervisor({
      sessionId: owner.sessionId,
      maxActiveAttempts: 1,
    });
    const work = deferred();
    const lease = supervisor.track(owner, {
      settled: work.promise,
      requestStop: () => {
        throw new Error('synthetic stop failure');
      },
    });
    lease.requestStop();
    expect(await lease.wait(0)).toMatchObject({
      resources: 'live',
      stopRequested: true,
      stopFailed: true,
    });
    work.resolve();
    await lease.wait(0);
    expect(supervisor.observe()).toEqual([]);
  });

  it.each([-1, NaN, Infinity, 0.5, 2_147_483_648])(
    'rejects an invalid deadline %s without stopping work',
    async (ms) => {
      const h = fixture();
      await expect(h.lease.wait(ms)).rejects.toThrow('deadline');
      await expect(h.supervisor.stopAndWait(ms)).rejects.toThrow('deadline');
      expect(h.requestStop).not.toHaveBeenCalled();
      h.work.resolve();
      await h.lease.wait(0);
    }
  );

  it.each([0, -1, NaN, Infinity, 0.5])('rejects invalid owner capacity %s', (maxActiveAttempts) => {
    expect(
      () => new ToolSettlementSupervisor({ sessionId: owner.sessionId, maxActiveAttempts })
    ).toThrow('bounds');
  });
});
