/**
 * The in-process inkling turn registry: what an owner's Stop reaches, and
 * what GET /api/admin/inklings reports as each inkling's activity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelInklingTurns,
  inklingTurnActivity,
  liveInklingTurns,
  trackInklingTurn,
} from './inkling-turns';

const T0 = '2026-10-04T09:00:00.000Z';
const T1 = '2026-10-04T09:00:30.000Z';
const T2 = '2026-10-04T09:01:00.000Z';

let sbCounter = 0;
/** A fresh id per test: the registry is module state shared by the file. */
function freshSb(): string {
  sbCounter += 1;
  return `inkling-${sbCounter}`;
}

/** Start a turn with the clock at `at`. */
function startAt(sbId: string, at: string): ReturnType<typeof trackInklingTurn> {
  vi.setSystemTime(new Date(at));
  return trackInklingTurn(sbId);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('inklingTurnActivity', () => {
  it('is idle, since null, for an inkling with no turn', () => {
    expect(inklingTurnActivity(freshSb())).toEqual({ state: 'idle', since: null });
  });

  it('is working from the moment a turn is tracked, since its start', () => {
    const sb = freshSb();
    const turn = startAt(sb, T0);
    vi.setSystemTime(new Date(T2));
    expect(inklingTurnActivity(sb)).toEqual({ state: 'working', since: T0 });
    turn.done();
  });

  it('is idle again once the runner returns', () => {
    const sb = freshSb();
    const turn = startAt(sb, T0);
    turn.done();
    expect(inklingTurnActivity(sb)).toEqual({ state: 'idle', since: null });
    expect(liveInklingTurns(sb)).toBe(0);
  });

  it('reports the oldest live turn as since, and moves on when it finishes', () => {
    const sb = freshSb();
    const first = startAt(sb, T0);
    const second = startAt(sb, T1);
    expect(inklingTurnActivity(sb)).toEqual({ state: 'working', since: T0 });
    first.done();
    expect(inklingTurnActivity(sb)).toEqual({ state: 'working', since: T1 });
    second.done();
    expect(inklingTurnActivity(sb)).toEqual({ state: 'idle', since: null });
  });

  it('takes the oldest start, not the first tracked, when the clock stepped back', () => {
    const sb = freshSb();
    const tracked1st = startAt(sb, T1);
    const tracked2nd = startAt(sb, T0);
    expect(inklingTurnActivity(sb)).toEqual({ state: 'working', since: T0 });
    tracked1st.done();
    tracked2nd.done();
  });

  it('is stopping after Stop until the runner returns, then idle', () => {
    const sb = freshSb();
    const turn = startAt(sb, T0);
    expect(cancelInklingTurns(sb)).toBe(1);
    expect(turn.signal.aborted).toBe(true);
    expect(inklingTurnActivity(sb)).toEqual({ state: 'stopping', since: T0 });
    turn.done();
    expect(inklingTurnActivity(sb)).toEqual({ state: 'idle', since: null });
  });

  it('is stopping only when every live turn was stopped', () => {
    const sb = freshSb();
    const a = startAt(sb, T0);
    const b = startAt(sb, T1);
    cancelInklingTurns(sb);
    expect(inklingTurnActivity(sb)).toEqual({ state: 'stopping', since: T0 });
    a.done();
    expect(inklingTurnActivity(sb)).toEqual({ state: 'stopping', since: T1 });
    b.done();
    expect(inklingTurnActivity(sb)).toEqual({ state: 'idle', since: null });
  });

  it('is working when a new turn starts while a stopped one winds down, since the new turn', () => {
    const sb = freshSb();
    const stopped = startAt(sb, T0);
    cancelInklingTurns(sb);
    const fresh = startAt(sb, T2);
    expect(inklingTurnActivity(sb)).toEqual({ state: 'working', since: T2 });
    fresh.done();
    expect(inklingTurnActivity(sb)).toEqual({ state: 'stopping', since: T0 });
    stopped.done();
    expect(inklingTurnActivity(sb)).toEqual({ state: 'idle', since: null });
  });

  it("is one inkling's own: another's turns and Stop do not show", () => {
    const mine = freshSb();
    const theirs = freshSb();
    const turn = startAt(theirs, T0);
    expect(inklingTurnActivity(mine)).toEqual({ state: 'idle', since: null });
    const myTurn = startAt(mine, T1);
    cancelInklingTurns(theirs);
    expect(inklingTurnActivity(mine)).toEqual({ state: 'working', since: T1 });
    expect(inklingTurnActivity(theirs)).toEqual({ state: 'stopping', since: T0 });
    turn.done();
    myTurn.done();
  });
});

// Lumen's review probes of #736 at 11bff2c0, kept as regressions.
describe('completion and Stop, in any order', () => {
  it("a finished turn's late done() cannot remove a newer turn", () => {
    const sb = freshSb();
    const old = trackInklingTurn(sb);
    old.done();
    const fresh = trackInklingTurn(sb);
    old.done();
    expect(liveInklingTurns(sb)).toBe(1);
    expect(inklingTurnActivity(sb).state).toBe('working');
    expect(fresh.signal.aborted).toBe(false);
    fresh.done();
    expect(inklingTurnActivity(sb)).toEqual({ state: 'idle', since: null });
  });

  it('a runner that returns inside Stop leaves no stale activity', () => {
    const sb = freshSb();
    const first = trackInklingTurn(sb);
    const second = trackInklingTurn(sb);
    first.signal.addEventListener('abort', first.done, { once: true });
    second.signal.addEventListener('abort', second.done, { once: true });
    expect(cancelInklingTurns(sb)).toBe(2);
    expect(first.signal.aborted && second.signal.aborted).toBe(true);
    expect(inklingTurnActivity(sb)).toEqual({ state: 'idle', since: null });
  });

  it('Stop and completion settle to idle whichever runs first', async () => {
    for (const stopFirst of [true, false]) {
      const sb = freshSb();
      const turn = trackInklingTurn(sb);
      const stop = () => cancelInklingTurns(sb);
      const steps = stopFirst ? [stop, turn.done] : [turn.done, stop];
      await Promise.all(steps.map((step) => Promise.resolve().then(step)));
      expect(inklingTurnActivity(sb), `stop first: ${stopFirst}`).toEqual({
        state: 'idle',
        since: null,
      });
    }
  });
});
