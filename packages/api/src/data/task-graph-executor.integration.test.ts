/**
 * Workflow graph steps 2-3 — Executor Integration Tests (real DB)
 *
 * The executor guarantees live in plpgsql (readiness under SATISFIES,
 * in-transaction push, claim-token gating, verdict CAS, the execution-path
 * trigger fence) — invisible to unit mocks by construction. This suite
 * drives the full lifecycle through the real repositories against local
 * Supabase: claim → complete → push → gate open → verdict → downstream →
 * group complete, plus every refusal edge.
 *
 * Requires .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY.
 * Skipped automatically when credentials are unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { INTEGRATION_TEST_USER_ID } from '../test/integration-fixtures';
import type { Database } from './supabase/types';
import { TaskGroupsRepository } from './repositories/task-groups.repository';
import { ProjectTasksRepository } from './repositories/project-tasks.repository';

const projectRoot = resolve(__dirname, '../../../../');
const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  const parsed = dotenv.parse(readFileSync(envLocalPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
const available = !!(SUPABASE_URL && SUPABASE_KEY);

const d = available ? describe : describe.skip;

const USER = INTEGRATION_TEST_USER_ID;

interface Evaluation {
  readyWork: Array<{ id: string; title: string }>;
  openedGates: Array<{ id: string; attempt: number }>;
  openGates: Array<{ id: string }>;
  scheduledGates: Array<{ id: string; eligibleAt: string }>;
  dependencyFailures: Array<{ id: string; sources: Array<{ id: string; state: string }> }>;
  groupComplete: boolean;
  counts: { total: number; completed: number; failed: number; skipped: number };
}

const evalOf = (r: Record<string, unknown>) => r.evaluation as unknown as Evaluation;
const readyIds = (e: Evaluation) => e.readyWork.map((n) => n.id).sort();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Real dwell window for tests: long enough that the schedule assertion runs
 * while the gate is still dwelling, short enough to sleep through. Direct
 * eligible_at rewrites are fenced now (round-1 P1) — tests wait like
 * everyone else.
 */
const TEST_DWELL_SECONDS = 3;

d('workflow graph executor (real DB)', () => {
  let client: SupabaseClient<Database>;
  let groups: TaskGroupsRepository;
  let tasksRepo: ProjectTasksRepository;

  let sess1: string;
  let sess2: string;
  let ident: string | null;

  // Diamond with a convergence gate: w1 → (w2, w3) → gate → w4
  const g1 = randomUUID();
  const w1 = randomUUID();
  const w2 = randomUUID();
  const w3 = randomUUID();
  const w4 = randomUUID();
  const gate = randomUUID();

  // Failure/dwell/retry group: a → b → dwellGate
  const g2 = randomUUID();
  const a = randomUUID();
  const b = randomUUID();
  const dwellGate = randomUUID();

  const sessionIds: string[] = [];

  beforeAll(async () => {
    client = createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    groups = new TaskGroupsRepository(client);
    tasksRepo = new ProjectTasksRepository(client);

    const { data: identRow } = await client
      .from('agent_identities')
      .select('id')
      .limit(1)
      .maybeSingle();
    ident = identRow?.id ?? null;
    if (!ident) throw new Error('fixture: no agent identity available for gate assignee');

    const { data: sessions, error: sErr } = await client
      .from('sessions')
      .insert([{ user_id: USER }, { user_id: USER }])
      .select('id');
    if (sErr) throw new Error(`fixture sessions: ${sErr.message}`);
    sess1 = sessions![0].id;
    sess2 = sessions![1].id;
    sessionIds.push(sess1, sess2);

    const { error: gErr } = await client.from('task_groups').insert([
      { id: g1, user_id: USER, title: 'exec-itest diamond' },
      { id: g2, user_id: USER, title: 'exec-itest failures' },
    ]);
    if (gErr) throw new Error(`fixture groups: ${gErr.message}`);

    const { error: tErr } = await client.from('tasks').insert([
      { id: w1, user_id: USER, task_group_id: g1, title: 'w1 impl', task_type: 'work' },
      { id: w2, user_id: USER, task_group_id: g1, title: 'w2 tests', task_type: 'work' },
      { id: w3, user_id: USER, task_group_id: g1, title: 'w3 docs', task_type: 'work' },
      { id: w4, user_id: USER, task_group_id: g1, title: 'w4 ship', task_type: 'work' },
      {
        id: gate,
        user_id: USER,
        task_group_id: g1,
        title: 'g review',
        task_type: 'verification',
        gate_state: 'not_ready',
        assignee_identity_id: ident,
      },
      { id: a, user_id: USER, task_group_id: g2, title: 'a flaky', task_type: 'work' },
      { id: b, user_id: USER, task_group_id: g2, title: 'b downstream', task_type: 'work' },
      {
        id: dwellGate,
        user_id: USER,
        task_group_id: g2,
        title: 'g dwell',
        task_type: 'verification',
        gate_state: 'not_ready',
        assignee_identity_id: ident,
        verification: { notBeforeSeconds: TEST_DWELL_SECONDS },
      },
    ] as never);
    if (tErr) throw new Error(`fixture tasks: ${tErr.message}`);

    for (const [grp, edges] of [
      [
        g1,
        [
          { from: w1, to: w2 },
          { from: w1, to: w3 },
          { from: w2, to: gate },
          { from: w3, to: gate },
          { from: gate, to: w4 },
        ],
      ],
      [
        g2,
        [
          { from: a, to: b },
          { from: b, to: dwellGate },
        ],
      ],
    ] as Array<[string, Array<{ from: string; to: string }>]>) {
      const conv = await groups.convertToGraph({
        userId: USER,
        taskGroupId: grp,
        expectedVersion: 0,
        systemActor: true,
      });
      if (conv.success !== true) throw new Error(`fixture convert: ${JSON.stringify(conv)}`);
      const applied = await groups.applyTaskGraph({
        userId: USER,
        taskGroupId: grp,
        expectedVersion: 1,
        edges,
        systemActor: true,
      });
      if (applied.success !== true) throw new Error(`fixture edges: ${JSON.stringify(applied)}`);
    }
  });

  afterAll(async () => {
    await client.from('tasks').delete().in('id', [w1, w2, w3, w4, gate, a, b, dwellGate]);
    await client.from('task_groups').delete().in('id', [g1, g2]);
    await client.from('sessions').delete().in('id', sessionIds);
  });

  // ── Diamond lifecycle ────────────────────────────────────────────────

  it('sweep reports only the entry node ready; premature claims refuse not-ready', async () => {
    const sweep = await groups.sweepTaskGraph({ userId: USER, taskGroupId: g1 });
    expect(sweep.success).toBe(true);
    expect(readyIds(evalOf(sweep as Record<string, unknown>))).toEqual([w1]);

    const early = await groups.claimGraphTask({ userId: USER, taskId: w2, sessionId: sess1 });
    expect(early).toMatchObject({ success: false, reason: 'not-ready' });
  });

  it('claims are exclusive and completion is token-gated', async () => {
    const claim = await groups.claimGraphTask({ userId: USER, taskId: w1, sessionId: sess1 });
    expect(claim.success).toBe(true);
    const token = claim.claimToken as string;

    const second = await groups.claimGraphTask({ userId: USER, taskId: w1, sessionId: sess2 });
    expect(second).toMatchObject({ success: false, reason: 'already-claimed' });

    const wrongToken = await groups.completeGraphTask({
      userId: USER,
      taskId: w1,
      sessionId: sess1,
      claimToken: randomUUID(),
      outcome: 'completed',
    });
    expect(wrongToken).toMatchObject({ success: false, reason: 'claim-mismatch' });

    const done = await groups.completeGraphTask({
      userId: USER,
      taskId: w1,
      sessionId: sess1,
      claimToken: token,
      outcome: 'completed',
    });
    expect(done.success).toBe(true);
    // Push: the fan-out pair became ready inside the completing transaction.
    expect(readyIds(evalOf(done))).toEqual([w2, w3].sort());
  });

  it('the legacy write paths are fenced: completeTask, update(status), raw SQL all refuse', async () => {
    // Legacy repository completion (status flip) — refused by the trigger.
    await expect(tasksRepo.completeTask(w2)).rejects.toThrow(/executor-owned/);

    // update_task-style status write — refused.
    await expect(tasksRepo.update(w2, { status: 'completed' })).rejects.toThrow(/executor-owned/);

    // Direct claim-column write — refused.
    const { error } = await client
      .from('tasks')
      .update({ claimed_by_session_id: sess1 } as never)
      .eq('id', w2);
    expect(error?.message).toMatch(/executor-owned/);

    // Non-execution fields stay editable.
    const updated = await tasksRepo.update(w2, { priority: 'high' });
    expect(updated.priority).toBe('high');
  });

  it('a convergence gate opens only when EVERY inbound source satisfies', async () => {
    const c2 = await groups.claimGraphTask({ userId: USER, taskId: w2, sessionId: sess1 });
    const c3 = await groups.claimGraphTask({ userId: USER, taskId: w3, sessionId: sess2 });
    expect(c2.success).toBe(true);
    expect(c3.success).toBe(true);

    const firstDone = await groups.completeGraphTask({
      userId: USER,
      taskId: w2,
      sessionId: sess1,
      claimToken: c2.claimToken as string,
      outcome: 'completed',
    });
    expect(evalOf(firstDone).openedGates).toEqual([]);

    const secondDone = await groups.completeGraphTask({
      userId: USER,
      taskId: w3,
      sessionId: sess2,
      claimToken: c3.claimToken as string,
      outcome: 'completed',
    });
    expect(evalOf(secondDone).openedGates.map((g) => g.id)).toEqual([gate]);

    const { data: gateRow } = await client
      .from('tasks')
      .select('gate_state, gate_opened_at')
      .eq('id', gate)
      .single();
    expect(gateRow?.gate_state).toBe('open');
    expect(gateRow?.gate_opened_at).toBeTruthy();
  });

  it('verdict guards: evidence, attempt CAS, actor authority, completion bypass', async () => {
    const { data: gateRow } = await client
      .from('tasks')
      .select('gate_attempt, gate_version')
      .eq('id', gate)
      .single();
    const attempt = gateRow!.gate_attempt;
    const version = gateRow!.gate_version;

    const noEvidence = await groups.recordGateVerdict({
      userId: USER,
      taskId: gate,
      verdict: 'passed',
      expectedAttempt: attempt,
      expectedGateVersion: version,
      actorIdentityId: ident!,
    });
    expect(noEvidence).toMatchObject({ success: false, reason: 'evidence-required' });

    const wrongAttempt = await groups.recordGateVerdict({
      userId: USER,
      taskId: gate,
      verdict: 'passed',
      expectedAttempt: attempt + 1,
      expectedGateVersion: version,
      actorIdentityId: ident!,
      evidence: { kind: 'note' },
    });
    expect(wrongAttempt).toMatchObject({ success: false, reason: 'attempt-conflict' });

    // The user is not the assignee (the identity is) — three-valued-logic
    // regression: with assignee_user_id NULL this must still REFUSE.
    const wrongActor = await groups.recordGateVerdict({
      userId: USER,
      taskId: gate,
      verdict: 'passed',
      expectedAttempt: attempt,
      expectedGateVersion: version,
      actorUserId: USER,
      evidence: { kind: 'note' },
    });
    expect(wrongActor).toMatchObject({ success: false, reason: 'not-assignee' });

    const completeOnGate = await groups.completeGraphTask({
      userId: USER,
      taskId: gate,
      sessionId: sess1,
      claimToken: randomUUID(),
      outcome: 'completed',
    });
    expect(completeOnGate).toMatchObject({ success: false, reason: 'verification-node' });
  });

  it('assignee verdict passes the gate and pushes downstream; completion finishes the group', async () => {
    const { data: gateRow } = await client
      .from('tasks')
      .select('gate_attempt, gate_version')
      .eq('id', gate)
      .single();

    const passed = await groups.recordGateVerdict({
      userId: USER,
      taskId: gate,
      verdict: 'passed',
      expectedAttempt: gateRow!.gate_attempt,
      expectedGateVersion: gateRow!.gate_version,
      actorIdentityId: ident!,
      evidence: { kind: 'review', ref: 'pr:itest' },
    });
    expect(passed.success).toBe(true);
    expect(readyIds(evalOf(passed))).toEqual([w4]);

    const claim = await groups.claimGraphTask({ userId: USER, taskId: w4, sessionId: sess2 });
    const done = await groups.completeGraphTask({
      userId: USER,
      taskId: w4,
      sessionId: sess2,
      claimToken: claim.claimToken as string,
      outcome: 'completed',
    });
    expect(evalOf(done).groupComplete).toBe(true);
    expect(evalOf(done).counts).toMatchObject({ total: 5, completed: 5, failed: 0 });
  });

  it('records the full claim/verdict event trail', async () => {
    const { data: events } = await client
      .from('task_gate_events')
      .select('event, task_id')
      .in('task_id', [w1, w2, w3, w4, gate])
      .order('created_at');
    const kinds = (events ?? []).map((e) => e.event);
    expect(kinds.filter((k) => k === 'claimed')).toHaveLength(4);
    expect(kinds.filter((k) => k === 'claim_released')).toHaveLength(4);
    expect(kinds).toContain('opened');
    expect(kinds).toContain('passed');
  });

  it('a fully-terminal graph group may be completed manually — the fence is a predicate, not a path', async () => {
    const { error } = await client
      .from('task_groups')
      .update({ status: 'completed' } as never)
      .eq('id', g1);
    expect(error).toBeNull();
    // Round 3: no resurrection — a terminal graph group's status is fixed.
    const { error: reopenError } = await client
      .from('task_groups')
      .update({ status: 'active' } as never)
      .eq('id', g1);
    expect(reopenError?.message).toMatch(/terminal/);
  });

  it('P1 regression (r3): cancellation is final — late completions refuse and nothing resurrects', async () => {
    const gC = randomUUID();
    const solo = randomUUID();
    await client
      .from('task_groups')
      .insert([{ id: gC, user_id: USER, title: 'exec-itest cancellation' }]);
    await client
      .from('tasks')
      .insert([
        { id: solo, user_id: USER, task_group_id: gC, title: 'solo', task_type: 'work' },
      ] as never);
    await groups.convertToGraph({
      userId: USER,
      taskGroupId: gC,
      expectedVersion: 0,
      systemActor: true,
    });

    try {
      const claim = await groups.claimGraphTask({ userId: USER, taskId: solo, sessionId: sess1 });
      expect(claim.success).toBe(true);

      // Operator cancels while the node is claimed.
      const { error: cancelError } = await client
        .from('task_groups')
        .update({ status: 'cancelled' } as never)
        .eq('id', gC);
      expect(cancelError).toBeNull();

      // The round-3 exploit: a late completion landed and finalized the
      // cancelled group. Now it refuses.
      const late = await groups.completeGraphTask({
        userId: USER,
        taskId: solo,
        sessionId: sess1,
        claimToken: claim.claimToken as string,
        outcome: 'completed',
      });
      expect(late).toMatchObject({ success: false, reason: 'group-not-active' });

      // No resurrection in either direction, and no mutations either.
      const { error: toCompleted } = await client
        .from('task_groups')
        .update({ status: 'completed' } as never)
        .eq('id', gC);
      expect(toCompleted?.message).toMatch(/terminal/);
      const { error: toActive } = await client
        .from('task_groups')
        .update({ status: 'active' } as never)
        .eq('id', gC);
      expect(toActive?.message).toMatch(/terminal/);
      const mutate = await groups.applyTaskGraph({
        userId: USER,
        taskGroupId: gC,
        expectedVersion: 1,
        edges: [],
        systemActor: true,
      });
      expect(mutate).toMatchObject({ success: false, reason: 'group-not-active' });
    } finally {
      await client.from('tasks').delete().eq('id', solo);
      await client.from('task_groups').delete().eq('id', gC);
    }
  });

  it('P1 regression (r3): graph membership is fixed — moves in or out refuse; linear moves stay free', async () => {
    const gLin = randomUUID();
    const mover = randomUUID();
    await client
      .from('task_groups')
      .insert([{ id: gLin, user_id: USER, title: 'exec-itest linear-moves' }]);
    await client
      .from('tasks')
      .insert([
        { id: mover, user_id: USER, task_group_id: gLin, title: 'mover', task_type: 'work' },
      ] as never);

    try {
      // g2 is a started graph group with live nodes.
      const { error: moveOut } = await client
        .from('tasks')
        .update({ task_group_id: gLin } as never)
        .eq('id', b);
      expect(moveOut?.message).toMatch(/graph membership is fixed/);

      const { error: moveIn } = await client
        .from('tasks')
        .update({ task_group_id: g2 } as never)
        .eq('id', mover);
      expect(moveIn?.message).toMatch(/graph membership is fixed/);

      // Linear-world moves keep their legacy semantics.
      const { error: linearMove } = await client
        .from('tasks')
        .update({ task_group_id: null } as never)
        .eq('id', mover);
      expect(linearMove).toBeNull();
    } finally {
      await client.from('tasks').delete().eq('id', mover);
      await client.from('task_groups').delete().eq('id', gLin);
    }
  });

  it('P1 regression (r3): a delayed old-boundary release never takes the next turn’s claims', async () => {
    const { releaseGraphClaimsForSession } = await import('../services/graph-executor.service');
    const gB = randomUUID();
    const node = randomUUID();
    await client
      .from('task_groups')
      .insert([{ id: gB, user_id: USER, title: 'exec-itest boundary-generation' }]);
    await client
      .from('tasks')
      .insert([
        { id: node, user_id: USER, task_group_id: gB, title: 'node', task_type: 'work' },
      ] as never);
    await groups.convertToGraph({
      userId: USER,
      taskGroupId: gB,
      expectedVersion: 0,
      systemActor: true,
    });

    try {
      // The OLD boundary happened a minute ago; the claim below belongs to
      // the session's NEXT turn.
      const staleBoundary = new Date(Date.now() - 60_000).toISOString();
      const claim = await groups.claimGraphTask({ userId: USER, taskId: node, sessionId: sess1 });
      expect(claim.success).toBe(true);

      const staleReleased = await releaseGraphClaimsForSession(
        client,
        sess1,
        'delayed-old-boundary',
        staleBoundary
      );
      expect(staleReleased).toBe(0);
      const { data: stillClaimed } = await client
        .from('tasks')
        .select('claimed_by_session_id')
        .eq('id', node)
        .single();
      expect(stillClaimed?.claimed_by_session_id).toBe(sess1);

      // The CURRENT boundary releases it.
      const released = await releaseGraphClaimsForSession(
        client,
        sess1,
        'current-boundary',
        new Date().toISOString()
      );
      expect(released).toBe(1);
    } finally {
      await client.from('tasks').delete().eq('id', node);
      await client.from('task_groups').delete().eq('id', gB);
    }
  });

  it('P1 regression: mutating an OPEN gate’s inbound set resets it — fresh window, stale verdicts bounce, cut reopens in-transaction', async () => {
    const g4 = randomUUID();
    const m1 = randomUUID();
    const m2 = randomUUID();
    const mg = randomUUID();
    await client
      .from('task_groups')
      .insert([{ id: g4, user_id: USER, title: 'exec-itest mutation-reset' }]);
    await client.from('tasks').insert([
      { id: m1, user_id: USER, task_group_id: g4, title: 'm1', task_type: 'work' },
      { id: m2, user_id: USER, task_group_id: g4, title: 'm2 late dep', task_type: 'work' },
      {
        id: mg,
        user_id: USER,
        task_group_id: g4,
        title: 'mg gate',
        task_type: 'verification',
        gate_state: 'not_ready',
        assignee_identity_id: ident,
      },
    ] as never);
    await groups.convertToGraph({
      userId: USER,
      taskGroupId: g4,
      expectedVersion: 0,
      systemActor: true,
    });
    await groups.applyTaskGraph({
      userId: USER,
      taskGroupId: g4,
      expectedVersion: 1,
      edges: [{ from: m1, to: mg }],
      systemActor: true,
    });

    try {
      // Open the gate.
      const claim = await groups.claimGraphTask({ userId: USER, taskId: m1, sessionId: sess1 });
      const done = await groups.completeGraphTask({
        userId: USER,
        taskId: m1,
        sessionId: sess1,
        claimToken: claim.claimToken as string,
        outcome: 'completed',
      });
      expect(evalOf(done).openedGates.map((g) => g.id)).toEqual([mg]);
      const { data: openRow } = await client
        .from('tasks')
        .select('gate_attempt, gate_version')
        .eq('id', mg)
        .single();

      // While OPEN, a live mutation adds an unsatisfied inbound edge.
      const mutated = await groups.applyTaskGraph({
        userId: USER,
        taskGroupId: g4,
        expectedVersion: 2,
        edges: [
          { from: m1, to: mg },
          { from: m2, to: mg },
        ],
        systemActor: true,
      });
      expect(mutated.success).toBe(true);
      expect(mutated.resetGates).toEqual([mg]);
      const { data: resetRow } = await client
        .from('tasks')
        .select('gate_state, gate_opened_at, dwell_started_at, eligible_at')
        .eq('id', mg)
        .single();
      expect(resetRow?.gate_state).toBe('not_ready');
      expect(resetRow?.gate_opened_at).toBeNull();
      expect(resetRow?.dwell_started_at).toBeNull();

      // A verdict carrying the pre-mutation attempt/version must bounce —
      // the round-1 exploit was exactly this verdict landing.
      const stale = await groups.recordGateVerdict({
        userId: USER,
        taskId: mg,
        verdict: 'passed',
        expectedAttempt: openRow!.gate_attempt,
        expectedGateVersion: openRow!.gate_version,
        actorIdentityId: ident!,
        evidence: { kind: 'stale' },
      });
      expect(stale.success).toBe(false);

      // P1 regression: the group cannot be declared complete around the
      // executor while nodes are live.
      const { error: completeError } = await client
        .from('task_groups')
        .update({ status: 'completed' } as never)
        .eq('id', g4);
      expect(completeError?.message).toMatch(/non-terminal/);

      // Cutting the unsatisfied edge re-opens the gate IN the mutation
      // transaction — readiness propagates on mutation events too.
      const cut = await groups.applyTaskGraph({
        userId: USER,
        taskGroupId: g4,
        expectedVersion: 3,
        edges: [{ from: m1, to: mg }],
        systemActor: true,
      });
      expect(evalOf(cut).openedGates.map((g) => g.id)).toEqual([mg]);

      // And the gate is decidable again at its CURRENT attempt/version.
      const { data: freshRow } = await client
        .from('tasks')
        .select('gate_attempt, gate_version')
        .eq('id', mg)
        .single();
      const passed = await groups.recordGateVerdict({
        userId: USER,
        taskId: mg,
        verdict: 'passed',
        expectedAttempt: freshRow!.gate_attempt,
        expectedGateVersion: freshRow!.gate_version,
        actorIdentityId: ident!,
        evidence: { kind: 'review', ref: 'post-mutation' },
      });
      expect(passed.success).toBe(true);

      // Round 2: a PASSED gate's verdict is a per-attempt fact — mutating
      // its inbound would restate the premises of a decided gate. Refused.
      const intoPassed = await groups.applyTaskGraph({
        userId: USER,
        taskGroupId: g4,
        expectedVersion: 4,
        edges: [
          { from: m1, to: mg },
          { from: m2, to: mg },
        ],
        systemActor: true,
      });
      expect(intoPassed).toMatchObject({ success: false, reason: 'passed-gate-inbound' });
      expect(intoPassed.gates).toEqual([mg]);
    } finally {
      await client.from('tasks').delete().in('id', [m1, m2, mg]);
      await client.from('task_groups').delete().eq('id', g4);
    }
  });

  it('P1 regression (r2): a failed gate never completes the group — retry stays reachable, then completion is earned', async () => {
    const g5 = randomUUID();
    const loneGate = randomUUID();
    await client
      .from('task_groups')
      .insert([{ id: g5, user_id: USER, title: 'exec-itest failed-gate-completion' }]);
    await client.from('tasks').insert([
      {
        id: loneGate,
        user_id: USER,
        task_group_id: g5,
        title: 'lone gate',
        task_type: 'verification',
        gate_state: 'not_ready',
        assignee_identity_id: ident,
      },
    ] as never);
    await groups.convertToGraph({
      userId: USER,
      taskGroupId: g5,
      expectedVersion: 0,
      systemActor: true,
    });

    try {
      // No deps: the sweep opens it immediately.
      await groups.sweepTaskGraph({ userId: USER, taskGroupId: g5 });
      const { data: openRow } = await client
        .from('tasks')
        .select('gate_attempt, gate_version')
        .eq('id', loneGate)
        .single();

      const failed = await groups.recordGateVerdict({
        userId: USER,
        taskId: loneGate,
        verdict: 'failed',
        expectedAttempt: openRow!.gate_attempt,
        expectedGateVersion: openRow!.gate_version,
        actorIdentityId: ident!,
        reason: 'checks red',
      });
      expect(failed.success).toBe(true);
      // The exploit: every node terminal, but the gate is NOT passed.
      expect(evalOf(failed).groupComplete).toBe(false);

      const { error: completeError } = await client
        .from('task_groups')
        .update({ status: 'completed' } as never)
        .eq('id', g5);
      expect(completeError?.message).toMatch(/unpassed verification gates/);

      // Retry is still reachable (the group stayed active and swept)…
      const retried = await groups.retryGate({
        userId: USER,
        taskId: loneGate,
        expectedAttempt: openRow!.gate_attempt,
        actorIdentityId: ident!,
        reason: 'remediated',
      });
      expect(retried.success).toBe(true);
      // …and completion is earned once the gate passes.
      const { data: freshRow } = await client
        .from('tasks')
        .select('gate_attempt, gate_version')
        .eq('id', loneGate)
        .single();
      const passed = await groups.recordGateVerdict({
        userId: USER,
        taskId: loneGate,
        verdict: 'passed',
        expectedAttempt: freshRow!.gate_attempt,
        expectedGateVersion: freshRow!.gate_version,
        actorIdentityId: ident!,
        evidence: { kind: 'ok' },
      });
      expect(evalOf(passed).groupComplete).toBe(true);
      const { error: nowAllowed } = await client
        .from('task_groups')
        .update({ status: 'completed' } as never)
        .eq('id', g5);
      expect(nowAllowed).toBeNull();
    } finally {
      await client.from('tasks').delete().eq('id', loneGate);
      await client.from('task_groups').delete().eq('id', g5);
    }
  });

  it('P1 regression (r2): gate config and assignees freeze once execution starts; authoring stays free while idle', async () => {
    const g6 = randomUUID();
    const cfgGate = randomUUID();
    await client
      .from('task_groups')
      .insert([{ id: g6, user_id: USER, title: 'exec-itest config-freeze' }]);
    await client.from('tasks').insert([
      {
        id: cfgGate,
        user_id: USER,
        task_group_id: g6,
        title: 'configurable gate',
        task_type: 'verification',
        gate_state: 'not_ready',
        assignee_identity_id: ident,
      },
    ] as never);
    await groups.convertToGraph({
      userId: USER,
      taskGroupId: g6,
      expectedVersion: 0,
      systemActor: true,
    });

    try {
      // Idle phase: authoring edits pass.
      const { error: idleEdit } = await client
        .from('tasks')
        .update({ verification: { notBeforeSeconds: 5 } } as never)
        .eq('id', cfgGate);
      expect(idleEdit).toBeNull();

      // Execution starts: config and authority freeze.
      await client
        .from('task_groups')
        .update({ execution_phase: 'worker_active' } as never)
        .eq('id', g6);
      const { error: cfgError } = await client
        .from('tasks')
        .update({ verification: { mode: 'approval', notBeforeSeconds: 3600 } } as never)
        .eq('id', cfgGate);
      expect(cfgError?.message).toMatch(/frozen once graph execution starts/);
      const { error: assigneeError } = await client
        .from('tasks')
        .update({ assignee_identity_id: null, assignee_user_id: USER } as never)
        .eq('id', cfgGate);
      expect(assigneeError?.message).toMatch(/frozen once graph execution starts/);
      const { error: reasonError } = await client
        .from('tasks')
        .update({ outcome_reason: 'forged' } as never)
        .eq('id', cfgGate);
      expect(reasonError?.message).toMatch(/executor-owned/);
    } finally {
      await client.from('tasks').delete().eq('id', cfgGate);
      await client.from('task_groups').delete().eq('id', g6);
    }
  });

  it('P1 regression (r2): the turn boundary releases every claim the session holds', async () => {
    const { releaseGraphClaimsForSession } = await import('../services/graph-executor.service');
    const g7 = randomUUID();
    const p1 = randomUUID();
    const p2 = randomUUID();
    await client
      .from('task_groups')
      .insert([{ id: g7, user_id: USER, title: 'exec-itest boundary-release' }]);
    await client.from('tasks').insert([
      { id: p1, user_id: USER, task_group_id: g7, title: 'p1', task_type: 'work' },
      { id: p2, user_id: USER, task_group_id: g7, title: 'p2', task_type: 'work' },
    ] as never);
    await groups.convertToGraph({
      userId: USER,
      taskGroupId: g7,
      expectedVersion: 0,
      systemActor: true,
    });

    try {
      const c1 = await groups.claimGraphTask({ userId: USER, taskId: p1, sessionId: sess1 });
      const c2 = await groups.claimGraphTask({ userId: USER, taskId: p2, sessionId: sess1 });
      expect(c1.success).toBe(true);
      expect(c2.success).toBe(true);

      const released = await releaseGraphClaimsForSession(client, sess1, 'test-turn-boundary');
      expect(released).toBe(2);

      const { data: rows } = await client
        .from('tasks')
        .select('id, status, claimed_by_session_id')
        .in('id', [p1, p2]);
      for (const row of rows ?? []) {
        expect(row.status).toBe('pending');
        expect(row.claimed_by_session_id).toBeNull();
      }
      // Idempotent: nothing left to release.
      expect(await releaseGraphClaimsForSession(client, sess1, 'again')).toBe(0);
    } finally {
      await client.from('tasks').delete().in('id', [p1, p2]);
      await client.from('task_groups').delete().eq('id', g7);
    }
  });

  it('concurrency: parallel graph mutations and executor operations never deadlock (r2 lock order)', async () => {
    const g8 = randomUUID();
    const nodes = [randomUUID(), randomUUID(), randomUUID()];
    const cGate = randomUUID();
    await client
      .from('task_groups')
      .insert([{ id: g8, user_id: USER, title: 'exec-itest concurrency' }]);
    await client.from('tasks').insert([
      ...nodes.map((id, i) => ({
        id,
        user_id: USER,
        task_group_id: g8,
        title: `c${i}`,
        task_type: 'work',
      })),
      {
        id: cGate,
        user_id: USER,
        task_group_id: g8,
        title: 'c gate',
        task_type: 'verification',
        gate_state: 'not_ready',
        assignee_identity_id: ident,
      },
    ] as never);
    await groups.convertToGraph({
      userId: USER,
      taskGroupId: g8,
      expectedVersion: 0,
      systemActor: true,
    });

    try {
      const edgeSets = [
        [{ from: nodes[0], to: cGate }],
        [
          { from: nodes[0], to: cGate },
          { from: nodes[1], to: cGate },
        ],
        [{ from: nodes[1], to: cGate }],
      ];
      const applyLoop = async (rounds: number) => {
        for (let i = 0; i < rounds; i += 1) {
          const { data: row } = await client
            .from('task_groups')
            .select('graph_version')
            .eq('id', g8)
            .single();
          // version-conflict refusals under contention are expected and
          // structured — only thrown errors (deadlocks) fail this test.
          await groups.applyTaskGraph({
            userId: USER,
            taskGroupId: g8,
            expectedVersion: (row!.graph_version as number) ?? 0,
            edges: edgeSets[i % edgeSets.length],
            systemActor: true,
          });
        }
      };
      const claimLoop = async (taskId: string, sessionId: string, rounds: number) => {
        for (let i = 0; i < rounds; i += 1) {
          const claim = await groups.claimGraphTask({ userId: USER, taskId, sessionId });
          if (claim.success) {
            await groups.releaseGraphClaim({
              userId: USER,
              taskId,
              claimToken: claim.claimToken as string,
              sessionId,
            });
          }
        }
      };
      const sweepLoop = async (rounds: number) => {
        for (let i = 0; i < rounds; i += 1) {
          await groups.sweepTaskGraph({ userId: USER, taskGroupId: g8 });
        }
      };

      const outcomes = await Promise.allSettled([
        applyLoop(12),
        claimLoop(nodes[0], sess1, 12),
        claimLoop(nodes[1], sess2, 12),
        sweepLoop(12),
      ]);
      const failures = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
      expect(
        failures.map((f) => String(f.reason)),
        'no operation may throw under contention (deadlocks surface here)'
      ).toEqual([]);
    } finally {
      await client
        .from('tasks')
        .delete()
        .in('id', [...nodes, cGate]);
      await client.from('task_groups').delete().eq('id', g8);
    }
  });

  // ── Failure, dwell, retry, reclaim ───────────────────────────────────

  it('a failed work node surfaces a dependency failure and blocks downstream forever', async () => {
    const claim = await groups.claimGraphTask({ userId: USER, taskId: a, sessionId: sess1 });
    const failed = await groups.completeGraphTask({
      userId: USER,
      taskId: a,
      sessionId: sess1,
      claimToken: claim.claimToken as string,
      outcome: 'failed',
      reason: 'flaky env',
    });
    expect(failed.success).toBe(true);
    const evaluation = evalOf(failed);
    expect(evaluation.readyWork).toEqual([]);
    expect(evaluation.dependencyFailures.map((f) => f.id)).toEqual([b]);
    expect(evaluation.dependencyFailures[0].sources[0]).toMatchObject({ id: a, state: 'failed' });

    const blockedClaim = await groups.claimGraphTask({ userId: USER, taskId: b, sessionId: sess1 });
    expect(blockedClaim).toMatchObject({ success: false, reason: 'not-ready' });
  });

  it('cutting the failed edge via the serialized mutation is the unblock path', async () => {
    const cut = await groups.applyTaskGraph({
      userId: USER,
      taskGroupId: g2,
      expectedVersion: 2,
      edges: [{ from: b, to: dwellGate }],
      systemActor: true,
    });
    expect(cut.success).toBe(true);

    const sweep = await groups.sweepTaskGraph({ userId: USER, taskGroupId: g2 });
    expect(readyIds(evalOf(sweep as Record<string, unknown>))).toEqual([b]);
  });

  it('a dwell gate schedules instead of opening, and the sweep opens it at eligible_at', async () => {
    const claim = await groups.claimGraphTask({ userId: USER, taskId: b, sessionId: sess1 });
    const done = await groups.completeGraphTask({
      userId: USER,
      taskId: b,
      sessionId: sess1,
      claimToken: claim.claimToken as string,
      outcome: 'completed',
    });
    const evaluation = evalOf(done);
    expect(evaluation.openedGates).toEqual([]);
    expect(evaluation.scheduledGates.map((g) => g.id)).toEqual([dwellGate]);

    const { data: gateRow } = await client
      .from('tasks')
      .select('gate_state, dwell_started_at, eligible_at')
      .eq('id', dwellGate)
      .single();
    expect(gateRow?.gate_state).toBe('not_ready');
    expect(gateRow?.dwell_started_at).toBeTruthy();

    // Timing is server-owned and FENCED (round-1 P1): forcing the window
    // over from outside the executor must refuse.
    const { error: forceError } = await client
      .from('tasks')
      .update({ eligible_at: new Date(Date.now() - 1000).toISOString() } as never)
      .eq('id', dwellGate);
    expect(forceError?.message).toMatch(/executor-owned/);

    // So the test waits out the real window; the sweep opens the gate.
    await sleep(TEST_DWELL_SECONDS * 1000 + 500);
    const sweep = await groups.sweepTaskGraph({ userId: USER, taskGroupId: g2 });
    expect(evalOf(sweep as Record<string, unknown>).openedGates.map((g) => g.id)).toEqual([
      dwellGate,
    ]);
  });

  it('failed verdict by the claim holder, retry with fresh window, stale verdict bounces', async () => {
    const claim = await groups.claimGraphTask({
      userId: USER,
      taskId: dwellGate,
      sessionId: sess1,
    });
    expect(claim.success).toBe(true);
    const attempt = claim.attempt as number;
    const version = claim.gateVersion as number;

    const failed = await groups.recordGateVerdict({
      userId: USER,
      taskId: dwellGate,
      verdict: 'failed',
      expectedAttempt: attempt,
      expectedGateVersion: version,
      actorIdentityId: ident!,
      sessionId: sess1,
      claimToken: claim.claimToken as string,
      reason: 'checks red',
    });
    expect(failed.success).toBe(true);

    const retried = await groups.retryGate({
      userId: USER,
      taskId: dwellGate,
      expectedAttempt: attempt,
      actorIdentityId: ident!,
      reason: 'remediated',
    });
    expect(retried).toMatchObject({ success: true, attempt: attempt + 1 });
    // Fresh dwell window: scheduled again, not open.
    expect(evalOf(retried).scheduledGates.map((g) => g.id)).toEqual([dwellGate]);

    const stale = await groups.recordGateVerdict({
      userId: USER,
      taskId: dwellGate,
      verdict: 'passed',
      expectedAttempt: attempt,
      expectedGateVersion: version,
      actorIdentityId: ident!,
      evidence: { kind: 'note' },
    });
    expect(stale.success).toBe(false);
  });

  it('skipped work never satisfies downstream — unblocking requires a graph mutation (v1 policy)', async () => {
    const g3 = randomUUID();
    const s1 = randomUUID();
    const s2 = randomUUID();
    await client.from('task_groups').insert([{ id: g3, user_id: USER, title: 'exec-itest skip' }]);
    await client.from('tasks').insert([
      { id: s1, user_id: USER, task_group_id: g3, title: 's1', task_type: 'work' },
      { id: s2, user_id: USER, task_group_id: g3, title: 's2', task_type: 'work' },
    ] as never);
    await groups.convertToGraph({
      userId: USER,
      taskGroupId: g3,
      expectedVersion: 0,
      systemActor: true,
    });
    await groups.applyTaskGraph({
      userId: USER,
      taskGroupId: g3,
      expectedVersion: 1,
      edges: [{ from: s1, to: s2 }],
      systemActor: true,
    });

    try {
      const claim = await groups.claimGraphTask({ userId: USER, taskId: s1, sessionId: sess1 });
      const skippedDone = await groups.completeGraphTask({
        userId: USER,
        taskId: s1,
        sessionId: sess1,
        claimToken: claim.claimToken as string,
        outcome: 'skipped',
        reason: 'not needed',
      });
      expect(skippedDone.success).toBe(true);
      const evaluation = evalOf(skippedDone);
      expect(evaluation.readyWork).toEqual([]);
      expect(evaluation.dependencyFailures.map((f) => f.id)).toEqual([s2]);
      expect(evaluation.dependencyFailures[0].sources[0]).toMatchObject({
        id: s1,
        state: 'skipped',
      });

      const blocked = await groups.claimGraphTask({ userId: USER, taskId: s2, sessionId: sess1 });
      expect(blocked).toMatchObject({ success: false, reason: 'not-ready' });
    } finally {
      await client.from('tasks').delete().in('id', [s1, s2]);
      await client.from('task_groups').delete().eq('id', g3);
    }
  });

  it('reclaim CASes on the token and returns the gate to the pool; sweep lists live claims', async () => {
    // The retry left a fresh dwell window — wait it out, sweep opens.
    await sleep(TEST_DWELL_SECONDS * 1000 + 500);
    await groups.sweepTaskGraph({ userId: USER, taskGroupId: g2 });

    const claim = await groups.claimGraphTask({
      userId: USER,
      taskId: dwellGate,
      sessionId: sess1,
    });
    expect(claim.success).toBe(true);

    const sweep = await groups.sweepTaskGraph({ userId: USER, taskGroupId: g2 });
    const claims = sweep.claims as Array<{ taskId: string; sessionId: string }>;
    expect(claims.map((c) => c.taskId)).toEqual([dwellGate]);

    const wrongToken = await groups.releaseGraphClaim({
      userId: USER,
      taskId: dwellGate,
      claimToken: randomUUID(),
      reclaim: true,
    });
    expect(wrongToken).toMatchObject({ success: false, reason: 'claim-mismatch' });

    const reclaimed = await groups.releaseGraphClaim({
      userId: USER,
      taskId: dwellGate,
      claimToken: claim.claimToken as string,
      reclaim: true,
      reason: 'holder ended',
    });
    expect(reclaimed).toMatchObject({ success: true, reclaimed: true });

    const { data: gateRow } = await client
      .from('tasks')
      .select('gate_state, claimed_by_session_id')
      .eq('id', dwellGate)
      .single();
    expect(gateRow?.gate_state).toBe('open');
    expect(gateRow?.claimed_by_session_id).toBeNull();
  });
});
