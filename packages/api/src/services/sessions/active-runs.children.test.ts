/**
 * The children an admitted generation owns (spec:live-agent-surfaces, P2c):
 * several per generation, each given back by its own handle, and stopped by
 * shutdown with an exit reported only when it is confirmed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  attachRunChild,
  closeIntakeAndDrain,
  listOwnedChildren,
  mayGenerationProceed,
  otherGenerationOwnsChild,
  registerActiveRun,
  resetActiveRuns,
  stopOwnedChildren,
  type OwnedChild,
} from './active-runs.js';

const admit = (sessionId: string, turnEpoch: string) =>
  registerActiveRun({
    sessionId,
    userId: 'user-synthetic',
    sbSlug: 'synthetic-sb',
    backend: 'ink',
    startedAt: Date.now(),
    turnEpoch,
  });

/** A child that exits, with the given confirmation, only once aborted. */
function child(onAbort: () => { childExited: boolean } | Error = () => ({ childExited: true })) {
  let settle!: (value: { childExited: boolean }) => void;
  let fail!: (error: Error) => void;
  const settled = new Promise<{ childExited: boolean }>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  settled.catch(() => undefined);
  const abort = vi.fn(() => {
    const outcome = onAbort();
    if (outcome instanceof Error) fail(outcome);
    else settle(outcome);
  });
  return { abort, settled, settle, fail } satisfies OwnedChild & Record<string, unknown>;
}

beforeEach(() => resetActiveRuns());
afterEach(() => resetActiveRuns());

describe('attachRunChild', () => {
  it('takes several children under the admitted generation, and gives back exactly the one released', () => {
    admit('s1', 'e1');
    const parent = attachRunChild('s1', 'e1', child());
    const summarizer = attachRunChild('s1', 'e1', child());
    const clone = attachRunChild('s1', 'e1', child());
    expect(listOwnedChildren()).toHaveLength(3);

    summarizer!.release();
    summarizer!.release();
    expect(listOwnedChildren()).toHaveLength(2);
    expect(parent).toBeDefined();
    expect(clone).toBeDefined();
  });

  it('refuses a generation that is not the admitted one, and any child once intake has closed', async () => {
    admit('s1', 'e1');
    expect(attachRunChild('s1', 'stale', child())).toBeUndefined();
    expect(attachRunChild('unadmitted', 'e1', child())).toBeUndefined();
    registerActiveRun({
      sessionId: 's2',
      userId: 'u',
      sbSlug: 'sb',
      backend: 'ink',
      startedAt: Date.now(),
    });
    // An entry without an epoch belongs to no generation that could name it.
    expect(attachRunChild('s2', undefined as unknown as string, child())).toBeUndefined();

    await closeIntakeAndDrain(10);
    expect(attachRunChild('s1', 'e1', child())).toBeUndefined();
    expect(listOwnedChildren()).toEqual([]);
  });

  it("keeps a replaced generation's children owned, and its late release never touches the newer one's", () => {
    admit('s1', 'old');
    const oldChild = attachRunChild('s1', 'old', child());
    admit('s1', 'new');
    // The old generation can no longer take a child on...
    expect(attachRunChild('s1', 'old', child())).toBeUndefined();
    // ...the child it already has is still running in this process, and the
    // newer generation starts nothing beside it.
    expect(attachRunChild('s1', 'new', child())).toBeUndefined();
    expect(listOwnedChildren()).toEqual([{ sessionId: 's1', turnEpoch: 'old' }]);

    // Its confirmed exit (the release) lets the newer generation proceed...
    oldChild!.release();
    const newChild = attachRunChild('s1', 'new', child());
    expect(newChild).toBeDefined();
    // ...and a late second release of the old handle touches nothing newer.
    oldChild!.release();
    expect(listOwnedChildren()).toEqual([{ sessionId: 's1', turnEpoch: 'new' }]);
  });
});

describe('stopOwnedChildren', () => {
  it('aborts every owned child, across generations and sessions, and gives back only those confirmed gone', async () => {
    // A replaced generation's child on s1, and three children of one
    // generation on s2.
    admit('s1', 'old');
    const oldChild = child();
    attachRunChild('s1', 'old', oldChild);
    admit('s1', 'new');
    admit('s2', 'e2');
    const exits = child();
    const lingers = child(() => ({ childExited: false }));
    const rejects = child(() => new Error('synthetic settle failure'));
    attachRunChild('s2', 'e2', exits);
    attachRunChild('s2', 'e2', lingers);
    attachRunChild('s2', 'e2', rejects);

    const result = await stopOwnedChildren(1_000);

    for (const c of [oldChild, exits, lingers, rejects]) expect(c.abort).toHaveBeenCalledTimes(1);
    expect(result.confirmed).toEqual([
      { sessionId: 's1', turnEpoch: 'old' },
      { sessionId: 's2', turnEpoch: 'e2' },
    ]);
    expect(result.unconfirmed).toEqual([
      { sessionId: 's2', turnEpoch: 'e2', reason: 'not-exited' },
      { sessionId: 's2', turnEpoch: 'e2', reason: 'rejected' },
    ]);
    // An unconfirmed exit stays owned: it is an unknown effect, not a stop.
    expect(listOwnedChildren()).toEqual([
      { sessionId: 's2', turnEpoch: 'e2' },
      { sessionId: 's2', turnEpoch: 'e2' },
    ]);
    // s1's newer generation may proceed once the old child's exit is confirmed.
    expect(attachRunChild('s1', 'new', child())).toBeDefined();
  });

  it('reports a child that has not settled by the timeout as unconfirmed, and keeps it', async () => {
    admit('s1', 'e1');
    const hangs = child();
    hangs.abort.mockImplementation(() => undefined);
    attachRunChild('s1', 'e1', hangs);

    const result = await stopOwnedChildren(20);

    expect(result).toEqual({
      confirmed: [],
      unconfirmed: [{ sessionId: 's1', turnEpoch: 'e1', reason: 'timeout' }],
    });
    expect(listOwnedChildren()).toHaveLength(1);
    // Its later exit is still a confirmed exit when stopped again.
    hangs.settle({ childExited: true });
    expect((await stopOwnedChildren(20)).confirmed).toHaveLength(1);
  });

  it('stops only the named generation when given one', async () => {
    admit('s1', 'e1');
    admit('s2', 'e2');
    const mine = child();
    const theirs = child();
    attachRunChild('s1', 'e1', mine);
    attachRunChild('s2', 'e2', theirs);

    const result = await stopOwnedChildren(1_000, { sessionId: 's1', turnEpoch: 'e1' });

    expect(result.confirmed).toEqual([{ sessionId: 's1', turnEpoch: 'e1' }]);
    expect(theirs.abort).not.toHaveBeenCalled();
    expect(listOwnedChildren()).toEqual([{ sessionId: 's2', turnEpoch: 'e2' }]);
  });

  it('still waits on a child whose abort throws', async () => {
    admit('s1', 'e1');
    const throwing = child();
    throwing.abort.mockImplementation(() => {
      throwing.settle({ childExited: true });
      throw new Error('synthetic signal failure');
    });
    attachRunChild('s1', 'e1', throwing);

    expect((await stopOwnedChildren(1_000)).confirmed).toHaveLength(1);
  });

  it('refuses a timeout that is not finite and non-negative', async () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(stopOwnedChildren(bad)).rejects.toThrow(RangeError);
    }
  });
});

// Lumen, #701 d84b473b: a takeover never runs work beside a child of another
// generation whose exit is not confirmed, and nothing but a confirmed exit
// lifts that.
describe('the older-generation barrier', () => {
  /** s1: generation 'old' owns one child set up by `make`, then 'new' is admitted. */
  function takeOverWith(make: () => ReturnType<typeof child>) {
    admit('s1', 'old');
    const older = make();
    expect(attachRunChild('s1', 'old', older)).toBeDefined();
    admit('s1', 'new');
    return older;
  }
  const blocked = () => {
    expect(otherGenerationOwnsChild('s1', 'new')).toBe(true);
    expect(mayGenerationProceed('s1', 'new')).toBe(false);
    expect(attachRunChild('s1', 'new', child())).toBeUndefined();
  };

  it('blocks the newer generation while the older child is pending, and lifts on a confirmed exit', async () => {
    takeOverWith(() => child());
    blocked();

    const stopped = await stopOwnedChildren(1_000);

    expect(stopped.confirmed).toEqual([{ sessionId: 's1', turnEpoch: 'old' }]);
    expect(mayGenerationProceed('s1', 'new')).toBe(true);
    expect(attachRunChild('s1', 'new', child())).toBeDefined();
  });

  it('stays blocked after the older child settles with childExited:false, however often it is stopped', async () => {
    takeOverWith(() => child(() => ({ childExited: false })));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const stopped = await stopOwnedChildren(1_000);
      expect(stopped.unconfirmed).toEqual([
        { sessionId: 's1', turnEpoch: 'old', reason: 'not-exited' },
      ]);
      blocked();
    }
  });

  it('stays blocked after the older child rejects', async () => {
    takeOverWith(() => child(() => new Error('synthetic settle failure')));
    expect((await stopOwnedChildren(1_000)).unconfirmed).toEqual([
      { sessionId: 's1', turnEpoch: 'old', reason: 'rejected' },
    ]);
    blocked();
  });

  it('stays blocked after a stop times out, and lifts when the late exit is confirmed', async () => {
    const older = takeOverWith(() => {
      const hangs = child();
      hangs.abort.mockImplementation(() => undefined);
      return hangs;
    });
    expect((await stopOwnedChildren(20)).unconfirmed).toEqual([
      { sessionId: 's1', turnEpoch: 'old', reason: 'timeout' },
    ]);
    blocked();

    older.settle({ childExited: true });
    expect((await stopOwnedChildren(1_000)).confirmed).toHaveLength(1);
    expect(mayGenerationProceed('s1', 'new')).toBe(true);
  });

  it('never blocks the same generation, or another session', () => {
    admit('s1', 'e1');
    admit('s2', 'e2');
    const own = [child(), child(), child()].map((c) => attachRunChild('s1', 'e1', c));
    expect(own.every(Boolean)).toBe(true);
    expect(mayGenerationProceed('s1', 'e1')).toBe(true);
    expect(attachRunChild('s2', 'e2', child())).toBeDefined();
    expect(otherGenerationOwnsChild('s2', 'e2')).toBe(false);
  });
});
