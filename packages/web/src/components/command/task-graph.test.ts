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
import { computeDepths, executionLabel } from './task-graph';

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

  it('terminates on a direct cycle and flags BOTH members', () => {
    const { depth, cyclic } = computeDepths(['a', 'b'], deps({ a: ['b'], b: ['a'] }));

    // Marking only the node the back-edge landed on would label a different
    // task depending on iteration order, and tell the reader nothing about
    // how far the cycle reaches.
    expect([...cyclic].sort()).toEqual(['a', 'b']);
    // Still produces a usable layout rather than throwing.
    expect(depth.get('a')).toBeTypeOf('number');
    expect(depth.get('b')).toBeTypeOf('number');
  });

  it('flags every member of a longer cycle, not just one', () => {
    const { cyclic } = computeDepths(['a', 'b', 'c'], deps({ a: ['c'], b: ['a'], c: ['b'] }));

    expect([...cyclic].sort()).toEqual(['a', 'b', 'c']);
  });

  it('flags the same set regardless of which node the walk starts from', () => {
    const graph = { a: ['c'], b: ['a'], c: ['b'] };
    const fromA = computeDepths(['a', 'b', 'c'], deps(graph));
    const fromC = computeDepths(['c', 'b', 'a'], deps(graph));

    expect([...fromA.cyclic].sort()).toEqual([...fromC.cyclic].sort());
  });

  it('reports exactly one back-edge per cycle, in blocker->task direction', () => {
    const { backEdges } = computeDepths(['a', 'b'], deps({ a: ['b'], b: ['a'] }));

    expect(backEdges.size).toBe(1);
    // The recorded edge is the dependency that could not be honoured: it runs
    // from the blocker to the task it blocks, matching the rendered edge id.
    expect([...backEdges][0]).toMatch(/^(a->b|b->a)$/);
  });

  it('records no back-edges when the graph is acyclic', () => {
    const { backEdges, cyclic } = computeDepths(
      ['a', 'b', 'c', 'd'],
      deps({ b: ['a'], c: ['a'], d: ['b', 'c'] })
    );

    expect(backEdges.size).toBe(0);
    expect(cyclic.size).toBe(0);
  });

  it('does not mark a task that merely points into a cycle', () => {
    // x depends on a, which is in a cycle. x itself is not on the cycle and
    // must not be labelled as such.
    const { cyclic } = computeDepths(['a', 'b', 'x'], deps({ a: ['b'], b: ['a'], x: ['a'] }));

    expect(cyclic.has('x')).toBe(false);
    expect(cyclic.has('a')).toBe(true);
    expect(cyclic.has('b')).toBe(true);
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

describe('executionLabel', () => {
  it('narrates the gate lifecycle in order of severity', () => {
    const gate = (gateState: string | null, extra: Record<string, unknown> = {}) =>
      executionLabel({ taskType: 'verification', gateState, ...extra });

    expect(gate('failed', { gateAttempt: 2 })).toEqual({
      text: '✖ gate FAILED · attempt 2',
      emphasis: true,
    });
    expect(gate('passed')?.text).toBe('✓ gate passed');
    expect(gate('open')?.emphasis).toBe(true);
    expect(gate('in_progress')?.text).toContain('verifying');
  });

  it('a dwelling gate is scheduled, never stalled — shows time to eligible', () => {
    const label = executionLabel({
      taskType: 'verification',
      gateState: 'not_ready',
      eligibleAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    });
    expect(label?.text).toMatch(/scheduled — opens in 2h/);
  });

  it('a gate past its window but unopened reads as waiting on deps, not scheduled', () => {
    const label = executionLabel({
      taskType: 'verification',
      gateState: 'not_ready',
      eligibleAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(label?.text).toBe('gate waiting on deps');
  });

  it('work nodes: upstream failure outranks claims and readiness', () => {
    expect(executionLabel({ taskType: 'work', depFailed: true, ready: true })).toEqual({
      text: '⛔ upstream failed',
      emphasis: true,
    });
    expect(executionLabel({ taskType: 'work', claimed: true, ready: true })?.text).toBe(
      '⚙ claimed'
    );
    expect(executionLabel({ taskType: 'work', ready: true })).toEqual({
      text: '▶ ready',
      emphasis: true,
    });
    expect(executionLabel({ taskType: 'work' })).toBeNull();
  });
});

// ─── summarizeGroups ───

import { summarizeGroups, buildGroupFlow } from './task-graph';
import { getSkin } from './skins';
import type { TaskNode } from './store';

function task(overrides: Partial<TaskNode> & { id: string }): TaskNode {
  return {
    title: overrides.id,
    status: 'pending',
    priority: 'medium',
    groupId: null,
    groupTitle: null,
    taskOrder: null,
    agentId: null,
    blockedBy: [],
    taskType: 'work',
    outcome: null,
    gateState: null,
    gateAttempt: null,
    eligibleAt: null,
    claimedBySessionId: null,
    assigneeIdentityId: null,
    groupExecutionModel: null,
    groupExecutionPhase: null,
    ...overrides,
  };
}

/** Marks a task as living in an executable graph group. */
const executable = { groupExecutionModel: 'graph', groupExecutionPhase: 'worker_active' } as const;

describe('summarizeGroups', () => {
  it('sorts running work above open gates above ready above size', () => {
    const tasks: TaskNode[] = [
      // g-big: large but dormant (blocked behind an active fetched dep)
      ...Array.from({ length: 10 }, (_, i) =>
        task({
          id: `big-${i}`,
          groupId: 'g-big',
          groupTitle: 'Big backlog',
          blockedBy: ['big-anchor'],
        })
      ),
      task({ id: 'big-anchor', groupId: 'g-big', groupTitle: 'Big backlog', status: 'blocked' }),
      // g-gate: an open verification gate
      task({
        id: 'gate-1',
        groupId: 'g-gate',
        groupTitle: 'Gated',
        taskType: 'verification',
        gateState: 'open',
      }),
      // g-run: one in-progress task
      task({ id: 'run-1', groupId: 'g-run', groupTitle: 'Running', status: 'in_progress' }),
      // g-ready: one ready task in an executable graph group
      task({ id: 'ready-1', groupId: 'g-ready', groupTitle: 'Ready', ...executable }),
    ];
    const ordered = summarizeGroups(tasks).map((g) => g.id);
    expect(ordered).toEqual(['g-run', 'g-gate', 'g-ready', 'g-big']);
  });

  it('counts gates, failures, and readiness per the SATISFIES mirror', () => {
    const inG = { groupId: 'g', groupTitle: 'G', ...executable };
    const tasks: TaskNode[] = [
      task({ id: 'w1', ...inG, status: 'completed' }),
      // ready: sole dep is completed work
      task({ id: 'w2', ...inG, blockedBy: ['w1'] }),
      // NOT ready: claimed
      task({ id: 'w3', ...inG, claimedBySessionId: 'sess-1' }),
      // failed gate counts in failed, not gatesOpen
      task({ id: 'v1', ...inG, taskType: 'verification', gateState: 'failed' }),
      // downstream of the failed gate: dependency-failure
      task({ id: 'w4', ...inG, blockedBy: ['v1'] }),
      task({ id: 'v2', ...inG, taskType: 'verification', gateState: 'in_progress' }),
    ];
    const [g] = summarizeGroups(tasks);
    expect(g.total).toBe(6);
    expect(g.ready).toBe(1); // only w2
    expect(g.gatesOpen).toBe(1); // v2 (in_progress verification)
    expect(g.failed).toBe(2); // v1 (failed gate) + w4 (failed dep)
  });

  it('collects groupless tasks under an Ungrouped row', () => {
    const tasks: TaskNode[] = [
      task({ id: 'solo-1' }),
      task({ id: 'in-group', groupId: 'g', groupTitle: 'G' }),
    ];
    const rows = summarizeGroups(tasks);
    const ungrouped = rows.find((r) => r.id === 'ungrouped');
    expect(ungrouped?.title).toBe('Ungrouped');
    expect(ungrouped?.total).toBe(1);
  });

  it('READY is executor-scoped: linear, ungrouped, and idle-graph tasks are never ready', () => {
    // Identical pending/unclaimed/no-dep tasks; only the executable graph
    // group's task earns the READY verdict — the executor will not act on
    // the others, so calling them ready lies about "what's about to occur".
    const tasks: TaskNode[] = [
      task({ id: 'lin', groupId: 'g-linear', groupTitle: 'Linear' }),
      task({ id: 'solo' }),
      task({
        id: 'idle',
        groupId: 'g-idle',
        groupTitle: 'Authoring',
        groupExecutionModel: 'graph',
        groupExecutionPhase: 'idle',
      }),
      task({ id: 'exec', groupId: 'g-exec', groupTitle: 'Executing', ...executable }),
    ];
    const byId = Object.fromEntries(summarizeGroups(tasks).map((g) => [g.id, g.ready]));
    expect(byId).toEqual({ 'g-linear': 0, ungrouped: 0, 'g-idle': 0, 'g-exec': 1 });
  });
});

// ─── buildGroupFlow ───

describe('buildGroupFlow', () => {
  const skin = getSkin('pixel');

  it('regression: a large ungrouped set renders as a LIST, never a node column', () => {
    // 200 live ungrouped tasks once produced a ~18,000px single-column flow
    // compressed to nothing by fitView — the original unreadable wall.
    const tasks: TaskNode[] = Array.from({ length: 200 }, (_, i) => task({ id: `solo-${i}` }));
    const flow = buildGroupFlow(tasks, 'ungrouped', skin);
    expect(flow.nodes).toHaveLength(0);
    expect(flow.edges).toHaveLength(0);
    expect(flow.listTasks).toHaveLength(200);
  });

  it('ungrouped list orders by status then title', () => {
    const tasks: TaskNode[] = [
      task({ id: 'b-pend', title: 'b', status: 'pending' }),
      task({ id: 'z-run', title: 'z', status: 'in_progress' }),
      task({ id: 'a-block', title: 'a', status: 'blocked' }),
    ];
    const flow = buildGroupFlow(tasks, 'ungrouped', skin);
    expect(flow.listTasks?.map((t) => t.id)).toEqual(['z-run', 'b-pend', 'a-block']);
  });

  it('a graph group renders its own nodes plus the header, nothing else', () => {
    const tasks: TaskNode[] = [
      task({ id: 'in-1', groupId: 'g1', groupTitle: 'Mine', ...executable }),
      task({ id: 'in-2', groupId: 'g1', groupTitle: 'Mine', blockedBy: ['in-1'], ...executable }),
      task({ id: 'other', groupId: 'g2', groupTitle: 'Other' }),
      task({ id: 'solo' }),
    ];
    const flow = buildGroupFlow(tasks, 'g1', skin);
    expect(flow.listTasks).toBeNull();
    expect(flow.nodes.map((n) => n.id).sort()).toEqual(['group-g1', 'task-in-1', 'task-in-2']);
    // in-1 → in-2 dependency edge plus header → entry-point edge
    expect(flow.edges.map((e) => e.id).sort()).toEqual(['e-dep-in-1-in-2', 'e-group-g1-task-in-1']);
  });
});

// ─── feedWarnings ───

import { feedWarnings } from './task-graph';

describe('feedWarnings', () => {
  const full = { fetched: 100, total: 100, truncated: false };
  const cut = { fetched: 100, total: 250, truncated: true };

  it('is silent when both feeds are complete (or unknown)', () => {
    expect(feedWarnings(full, full)).toEqual([]);
    expect(feedWarnings(null, null)).toEqual([]);
  });

  it('warns for a truncated TASK feed alone', () => {
    const warnings = feedWarnings(cut, full);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('100 of 250 active tasks');
  });

  it('warns for a truncated GROUP feed alone — the task banner must not stay hidden', () => {
    const warnings = feedWarnings(full, cut);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('100 of 250 task groups');
  });

  it('warns for both feeds independently when both overflow', () => {
    expect(feedWarnings(cut, cut)).toHaveLength(2);
  });
});
