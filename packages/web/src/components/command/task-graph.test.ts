/**
 * Dependency layering for the task graph.
 *
 * The graph previously chained tasks by task_order — a straight line that
 * looked like a workflow but encoded nothing. These tests cover the real
 * layering over `blocked_by`, and in particular the cycle guard: `blocked_by`
 * is an unconstrained `uuid[]`, so a cycle is representable, and an
 * unguarded longest-path walk over one never terminates.
 */

import { describe, it, expect } from 'vitest';
import { computeDepths } from './task-graph';

/** Builds a dependenciesOf lookup from a plain adjacency map. */
function deps(map: Record<string, string[]>) {
  return (id: string) => map[id] ?? [];
}

describe('computeDepths', () => {
  it('puts tasks with no blockers in column 0', () => {
    const { depth } = computeDepths(['a', 'b'], deps({}));

    expect(depth.get('a')).toBe(0);
    expect(depth.get('b')).toBe(0);
  });

  it('places a task one column right of its blocker', () => {
    const { depth } = computeDepths(['a', 'b'], deps({ b: ['a'] }));

    expect(depth.get('a')).toBe(0);
    expect(depth.get('b')).toBe(1);
  });

  it('uses the longest path, not the first, so no edge points backwards', () => {
    // d is blocked by both b (depth 1) and a (depth 0). Taking the shorter
    // path would place d at 1, level with its own blocker b.
    const { depth } = computeDepths(['a', 'b', 'd'], deps({ b: ['a'], d: ['a', 'b'] }));

    expect(depth.get('d')).toBe(2);
  });

  it('layers a diamond so both middle tasks share a column', () => {
    const { depth } = computeDepths(
      ['a', 'b', 'c', 'd'],
      deps({ b: ['a'], c: ['a'], d: ['b', 'c'] })
    );

    expect(depth.get('b')).toBe(1);
    expect(depth.get('c')).toBe(1);
    expect(depth.get('d')).toBe(2);
  });

  it('terminates on a direct cycle and flags it', () => {
    const { depth, cyclic } = computeDepths(['a', 'b'], deps({ a: ['b'], b: ['a'] }));

    expect(cyclic.size).toBeGreaterThan(0);
    // Still produces a usable layout rather than throwing.
    expect(depth.get('a')).toBeTypeOf('number');
    expect(depth.get('b')).toBeTypeOf('number');
  });

  it('terminates on a longer cycle', () => {
    const { cyclic } = computeDepths(['a', 'b', 'c'], deps({ a: ['c'], b: ['a'], c: ['b'] }));

    expect(cyclic.size).toBeGreaterThan(0);
  });

  it('flags a task that blocks itself', () => {
    const { cyclic } = computeDepths(['a'], deps({ a: ['a'] }));

    expect(cyclic.has('a')).toBe(true);
  });

  it('lays out the acyclic part normally when one cycle exists elsewhere', () => {
    const { depth, cyclic } = computeDepths(
      ['a', 'b', 'x', 'y'],
      deps({ b: ['a'], x: ['y'], y: ['x'] })
    );

    expect(depth.get('b')).toBe(1);
    expect(cyclic.has('a')).toBe(false);
    expect(cyclic.has('b')).toBe(false);
  });

  it('visits a shared blocker once rather than re-walking it per dependent', () => {
    // Fan-out from one root: a diamond chain where a naive walk re-expands
    // the shared prefix. Counting calls pins the memoisation.
    let calls = 0;
    const counted = (id: string) => {
      calls += 1;
      return (
        ({ b: ['a'], c: ['a'], d: ['b', 'c'], e: ['d'] } as Record<string, string[]>)[id] ?? []
      );
    };

    computeDepths(['a', 'b', 'c', 'd', 'e'], counted);

    // One expansion per task, regardless of how many dependents share it.
    expect(calls).toBe(5);
  });
});
