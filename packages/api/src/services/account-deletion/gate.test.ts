import { describe, expect, it } from 'vitest';
import { GateClosedError, WorkGate } from './gate';

describe('WorkGate', () => {
  it('admits work while open and counts it until it leaves', () => {
    const gate = new WorkGate();
    const a = gate.enter('acct');
    const b = gate.enter('acct');
    expect(gate.inFlightCount('acct')).toBe(2);
    a.release();
    a.release();
    expect(gate.inFlightCount('acct')).toBe(1);
    b.release();
    expect(gate.inFlightCount('acct')).toBe(0);
  });

  it('refuses work that enters after the gate closes, holding nothing', () => {
    const gate = new WorkGate();
    gate.close('acct');
    expect(() => gate.enter('acct')).toThrow(GateClosedError);
    expect(gate.inFlightCount('acct')).toBe(0);
  });

  it('keeps work that entered before the close until it leaves', async () => {
    const gate = new WorkGate();
    const lease = gate.enter('acct');
    gate.close('acct');
    let drained: boolean | undefined;
    const waiting = gate.waitDrained('acct', 1000).then((value) => (drained = value));
    await Promise.resolve();
    expect(drained).toBeUndefined();
    lease.release();
    await waiting;
    expect(drained).toBe(true);
  });

  it('reports false when the drain times out, and leaves the gate closed', async () => {
    const gate = new WorkGate();
    const lease = gate.enter('acct');
    gate.close('acct');
    await expect(gate.waitDrained('acct', 10)).resolves.toBe(false);
    expect(gate.isClosed('acct')).toBe(true);
    expect(gate.inFlightCount('acct')).toBe(1);
    lease.release();
  });

  it('drains at once when nothing is inside', async () => {
    const gate = new WorkGate();
    gate.close('acct');
    await expect(gate.waitDrained('acct', 1)).resolves.toBe(true);
  });

  it('keeps accounts apart', () => {
    const gate = new WorkGate();
    gate.close('a');
    const lease = gate.enter('b');
    expect(gate.inFlightCount('b')).toBe(1);
    expect(() => gate.enter('a')).toThrow(GateClosedError);
    lease.release();
  });

  it('forgets a closed key only once nothing of it remains', () => {
    const gate = new WorkGate();
    const lease = gate.enter('acct');
    gate.close('acct');
    gate.forget('acct');
    expect(gate.isClosed('acct')).toBe(true);
    lease.release();
    gate.forget('acct');
    expect(gate.isClosed('acct')).toBe(false);
  });

  it('registers before it checks: a close between the two still refuses', () => {
    // The order the spec relies on. enter() counts the work first, so a
    // deletion that closes and then reads the count sees it; if the close
    // came first, enter() sees the mark and leaves.
    const gate = new WorkGate();
    gate.close('acct');
    let counted = -1;
    try {
      gate.enter('acct');
    } catch {
      counted = gate.inFlightCount('acct');
    }
    expect(counted).toBe(0);
  });
});
