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
