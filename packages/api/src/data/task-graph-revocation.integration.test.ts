/**
 * Workflow graph — revocation, supersession and authority holds (real DB)
 *
 * Spec: ink://specs/workflow-graph-revocation v10 (v7 approved by Lumen,
 * 5ca4f973), amending workflow-graph v10. Everything under test lives in
 * plpgsql and is invisible to a mock by construction: the descendant closure
 * a withdrawal holds, the per-cause release, the claim fence and its bounce
 * reason, the CAS on attempt / version / request revision, the author and
 * binding refusals on a verdict, and the group-completion invariant. Cases
 * are numbered as in the amendment's acceptance list.
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
const d = SUPABASE_URL && SUPABASE_KEY ? describe : describe.skip;
const USER = INTEGRATION_TEST_USER_ID;

type Principal = { kind: 'sb' | 'user'; id: string };

interface NodeSpec {
  key: string;
  type: 'work' | 'gate';
  /** Gate assignee (identity id). Defaults to the reviewer. */
  assignee?: string;
  /** Binding hash of the candidate the gate decides; NULL for ordinary review gates. */
  binding?: string;
  authors?: Principal[];
  notBefore?: number;
}

interface Evaluation {
  readyWork: Array<{ id: string }>;
  openedGates: Array<{ id: string; attempt: number }>;
  openGates: Array<{ id: string }>;
  scheduledGates: Array<{ id: string; eligibleAt: string }>;
  heldNodes: Array<{
    id: string;
    holds: Array<{ id: string; kind: string; sourceGateId: string }>;
  }>;
  groupComplete: boolean;
  counts: { held: number };
}

const evalOf = (r: Record<string, unknown>) => r.evaluation as unknown as Evaluation;
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id).sort();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d('workflow graph revocation, supersession and holds (real DB)', () => {
  let client: SupabaseClient<Database>;
  let groups: TaskGroupsRepository;
  let reviewer: string;
  let author: string;
  let stranger: string;
  let sess1: string;
  let sess2: string;
  const identityIds: string[] = [];
  const sessionIds: string[] = [];
  const groupIds: string[] = [];
  const taskIds: string[] = [];

  async function newIdentity(label: string): Promise<string> {
    const { data: ws } = await client
      .from('workspaces')
      .select('id')
      .eq('user_id', USER)
      .eq('type', 'personal')
      .is('archived_at', null)
      .limit(1)
      .maybeSingle();
    const slug = `rev-itest-${label}-${randomUUID().slice(0, 8)}`;
    const { data, error } = await client
      .from('agent_identities')
      .insert({
        user_id: USER,
        workspace_id: ws?.id ?? null,
        agent_id: slug,
        name: slug,
        role: 'Revocation suite identity',
        metadata: { fixture: true, suite: true },
        backend: 'claude',
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`fixture identity ${label}: ${error?.message}`);
    identityIds.push(data.id);
    return data.id;
  }

  /** A graph-mode group: born linear, converted, edges applied — as the DB requires. */
  async function buildGraph(
    title: string,
    nodes: NodeSpec[],
    edges: Array<[string, string]>
  ): Promise<{ group: string; id: Record<string, string> }> {
    const group = randomUUID();
    groupIds.push(group);
    const id: Record<string, string> = {};
    for (const n of nodes) id[n.key] = randomUUID();
    const { error: gErr } = await client
      .from('task_groups')
      .insert({ id: group, user_id: USER, title: `rev-itest ${title}` });
    if (gErr) throw new Error(`fixture group: ${gErr.message}`);
    const rows = nodes.map((n) =>
      n.type === 'work'
        ? { id: id[n.key], user_id: USER, task_group_id: group, title: n.key, task_type: 'work' }
        : {
            id: id[n.key],
            user_id: USER,
            task_group_id: group,
            title: n.key,
            task_type: 'verification',
            gate_state: 'not_ready',
            assignee_identity_id: n.assignee ?? reviewer,
            verification: n.notBefore ? { notBeforeSeconds: n.notBefore } : null,
            gate_binding: n.binding ? { tuple: n.binding } : null,
            gate_binding_hash: n.binding ?? null,
            gate_authors: n.authors ?? null,
          }
    );
    const { error: tErr } = await client.from('tasks').insert(rows as never);
    if (tErr) throw new Error(`fixture tasks: ${tErr.message}`);
    taskIds.push(...Object.values(id));
    const conv = await groups.convertToGraph({
      userId: USER,
      taskGroupId: group,
      expectedVersion: 0,
      systemActor: true,
    });
    if (conv.success !== true) throw new Error(`fixture convert: ${JSON.stringify(conv)}`);
    const applied = await groups.applyTaskGraph({
      userId: USER,
      taskGroupId: group,
      expectedVersion: 1,
      edges: edges.map(([from, to]) => ({ from: id[from], to: id[to] })),
      systemActor: true,
    });
    if (applied.success !== true) throw new Error(`fixture edges: ${JSON.stringify(applied)}`);
    return { group, id };
  }

  async function gate(taskId: string) {
    const { data, error } = await client
      .from('tasks')
      .select(
        'gate_state, gate_attempt, gate_version, gate_request_revision, gate_binding_hash, gate_authors, status, outcome_reason, claimed_by_session_id, claim_token, dwell_started_at, eligible_at, gate_opened_at'
      )
      .eq('id', taskId)
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  async function openHolds(taskId: string) {
    const { data, error } = await client
      .from('task_authority_holds')
      .select('id, kind, source_gate_id, source_attempt, binding_hash, cause_event_id, released_at')
      .eq('task_id', taskId)
      .is('released_at', null)
      .order('placed_at');
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async function events(taskId: string) {
    const { data, error } = await client
      .from('task_gate_events')
      .select(
        'id, event, reason, attempt, gate_version, binding_hash, claim_token, resolves_event_id'
      )
      .eq('task_id', taskId)
      .order('created_at')
      .order('id');
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async function unresolved(taskId: string, bindingHash: string | null) {
    const { data, error } = await client.rpc('graph_unresolved_withdrawals', {
      p_task_id: taskId,
      p_binding_hash: bindingHash,
    });
    if (error) throw new Error(error.message);
    return (data ?? []) as string[];
  }

  const sweep = (group: string) => groups.sweepTaskGraph({ userId: USER, taskGroupId: group });

  /** Verdict by the named actor at the gate's CURRENT attempt and version. */
  async function verdict(
    taskId: string,
    actor: string,
    v: 'passed' | 'failed',
    extra: { bindingHash?: string; sessionId?: string; claimToken?: string } = {}
  ) {
    const row = await gate(taskId);
    return groups.recordGateVerdict({
      userId: USER,
      taskId,
      verdict: v,
      expectedAttempt: row.gate_attempt,
      expectedGateVersion: row.gate_version,
      actorIdentityId: actor,
      evidence: v === 'passed' ? { checked: true } : undefined,
      reason: v === 'failed' ? 'not this one' : undefined,
      ...extra,
    });
  }

  async function revoke(
    taskId: string,
    actor: { identity?: string; user?: string },
    reason = 'withdrawn'
  ) {
    const row = await gate(taskId);
    return groups.revokeGate({
      userId: USER,
      taskId,
      expectedAttempt: row.gate_attempt,
      expectedGateVersion: row.gate_version,
      actorIdentityId: actor.identity,
      actorUserId: actor.user,
      reason,
    });
  }

  async function claimAndComplete(taskId: string, session: string) {
    const claim = await groups.claimGraphTask({ userId: USER, taskId, sessionId: session });
    if (claim.success !== true) throw new Error(`claim: ${JSON.stringify(claim)}`);
    const done = await groups.completeGraphTask({
      userId: USER,
      taskId,
      sessionId: session,
      claimToken: claim.claimToken as string,
      outcome: 'completed',
    });
    if (done.success !== true) throw new Error(`complete: ${JSON.stringify(done)}`);
    return done;
  }

  beforeAll(async () => {
    client = createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    groups = new TaskGroupsRepository(client);
    reviewer = await newIdentity('reviewer');
    author = await newIdentity('author');
    stranger = await newIdentity('stranger');
    const { data: sessions, error } = await client
      .from('sessions')
      .insert([{ user_id: USER }, { user_id: USER }])
      .select('id');
    if (error) throw new Error(`fixture sessions: ${error.message}`);
    sess1 = sessions![0].id;
    sess2 = sessions![1].id;
    sessionIds.push(sess1, sess2);
  });

  afterAll(async () => {
    if (!client) return;
    // Operations reference tasks without cascade; holds and events cascade
    // with the tasks; sessions and identities go last.
    if (groupIds.length) {
      await client.from('publication_operations').delete().in('task_group_id', groupIds);
    }
    if (taskIds.length) await client.from('tasks').delete().in('id', taskIds);
    if (groupIds.length) await client.from('task_groups').delete().in('id', groupIds);
    if (sessionIds.length) await client.from('sessions').delete().in('id', sessionIds);
    if (identityIds.length) await client.from('agent_identities').delete().in('id', identityIds);
  });

  // ── Case 7: the completed-intermediate chain ────────────────────────────

  it('case 7: revoking a pass holds G → W(completed) → H(passed) → M(claimed); a re-pass on the same binding releases it', async () => {
    const { group, id } = await buildGraph(
      'case 7',
      [
        { key: 'G', type: 'gate', binding: 'A', authors: [{ kind: 'sb', id: author }] },
        { key: 'W', type: 'work' },
        { key: 'H', type: 'gate' },
        { key: 'M', type: 'work' },
      ],
      [
        ['G', 'W'],
        ['W', 'H'],
        ['H', 'M'],
      ]
    );
    await sweep(group);
    expect((await verdict(id.G, reviewer, 'passed', { bindingHash: 'A' })).success).toBe(true);
    await claimAndComplete(id.W, sess1);
    expect((await verdict(id.H, reviewer, 'passed')).success).toBe(true);
    const claimM = await groups.claimGraphTask({ userId: USER, taskId: id.M, sessionId: sess1 });
    expect(claimM.success).toBe(true);
    const tokenM = claimM.claimToken as string;

    // The withdrawal, by the verdict actor.
    const r = await revoke(id.G, { identity: reviewer }, 'the fixture names a real person');
    expect(r.success).toBe(true);
    expect(r.authority).toBe('verdict-actor');
    expect(r.afterConsumption).toBe(false);
    expect(r.attempt).toBe(2);
    const ev = evalOf(r);
    // G itself is decided again: attempt 2 opened at once (zero dwell).
    expect(ev.openedGates.map((g) => g.id)).toContain(id.G);
    expect(ev.openedGates.find((g) => g.id === id.G)?.attempt).toBe(2);
    // The closure is held: W (completed), H (passed), M (was claimed).
    expect(ids(ev.heldNodes)).toEqual(ids([{ id: id.W }, { id: id.H }, { id: id.M }]));
    expect(ev.readyWork.map((n) => n.id)).not.toContain(id.M);
    expect(ev.groupComplete).toBe(false);
    for (const node of [id.W, id.H, id.M]) {
      const holds = await openHolds(node);
      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({
        kind: 'authority-withdrawn',
        source_gate_id: id.G,
        source_attempt: 1,
        binding_hash: 'A',
        cause_event_id: r.eventId,
      });
    }
    // Completed facts are immutable under the hold.
    expect((await gate(id.H)).gate_state).toBe('passed');
    expect((await gate(id.W)).status).toBe('completed');
    // M's claim was released with the cause; its token is fenced and the
    // holder's late completion bounces with that cause, not a bare mismatch.
    const m = await gate(id.M);
    expect(m.claimed_by_session_id).toBeNull();
    expect(m.status).toBe('pending');
    const late = await groups.completeGraphTask({
      userId: USER,
      taskId: id.M,
      sessionId: sess1,
      claimToken: tokenM,
      outcome: 'completed',
    });
    expect(late).toMatchObject({ success: false, reason: 'upstream-revoked' });
    expect(
      await groups.claimGraphTask({ userId: USER, taskId: id.M, sessionId: sess2 })
    ).toMatchObject({
      success: false,
      reason: 'held',
    });
    // The withdrawal is unresolved for binding A and for nothing else.
    expect(await unresolved(id.G, 'A')).toHaveLength(1);
    expect(await unresolved(id.G, 'B')).toHaveLength(0);

    // Re-pass on the same binding: every hold this withdrawal placed lifts.
    const again = await verdict(id.G, reviewer, 'passed', { bindingHash: 'A' });
    expect(again.success).toBe(true);
    expect(again.attempt).toBe(2);
    expect((again.releasedHolds as unknown[]).length).toBe(3);
    for (const node of [id.W, id.H, id.M]) expect(await openHolds(node)).toHaveLength(0);
    expect(await unresolved(id.G, 'A')).toHaveLength(0);
    expect(evalOf(again).readyWork.map((n) => n.id)).toContain(id.M);
    expect(
      await groups.claimGraphTask({ userId: USER, taskId: id.M, sessionId: sess2 })
    ).toMatchObject({
      success: true,
    });

    // The trail, on M. Events written in one transaction share created_at,
    // so the comparison is on the multiset; the cross-transaction order is
    // pinned by the first and last entries.
    const trail = (await events(id.M)).map((e) => `${e.event}:${e.reason ?? ''}`);
    expect([...trail].sort()).toEqual(
      [
        'claimed:',
        'claim_released:upstream-revoked',
        'hold_placed:authority-withdrawn',
        'hold_released:authority-withdrawn',
        'claimed:',
      ].sort()
    );
    expect(trail[0]).toBe('claimed:');
    expect(trail[trail.length - 1]).toBe('claimed:');
    const gEvents = await events(id.G);
    const revoked = gEvents.find((e) => e.event === 'revoked');
    expect(revoked).toMatchObject({
      attempt: 1,
      binding_hash: 'A',
      reason: 'the fixture names a real person',
    });
    expect(gEvents.filter((e) => e.event === 'passed').map((e) => e.binding_hash)).toEqual([
      'A',
      'A',
    ]);
  });

  it('case 7 minimal: G → P(completed) → C(pending) — C does not become ready through P while held', async () => {
    const { group, id } = await buildGraph(
      'case 7 minimal',
      [
        { key: 'G', type: 'gate', binding: 'A' },
        { key: 'P', type: 'work' },
        { key: 'C', type: 'work' },
      ],
      [
        ['G', 'P'],
        ['P', 'C'],
      ]
    );
    await sweep(group);
    expect((await verdict(id.G, reviewer, 'passed')).success).toBe(true);
    await claimAndComplete(id.P, sess1);
    expect(evalOf(await sweep(group)).readyWork.map((n) => n.id)).toEqual([id.C]);

    const r = await revoke(id.G, { identity: reviewer });
    expect(r.success).toBe(true);
    // P is still completed — SATISFIES would say C is ready. The hold says no.
    expect((await gate(id.P)).status).toBe('completed');
    expect(evalOf(r).readyWork).toEqual([]);
    expect(ids(evalOf(r).heldNodes)).toEqual(ids([{ id: id.P }, { id: id.C }]));
    expect(
      await groups.claimGraphTask({ userId: USER, taskId: id.C, sessionId: sess1 })
    ).toMatchObject({
      success: false,
      reason: 'held',
    });
  });

  // ── Case 17: two causes, one node — both orders ─────────────────────────

  for (const order of [
    ['G1', 'G2'],
    ['G2', 'G1'],
  ] as const) {
    it(`case 17: G1, G2 → W → H → M; revoke both; re-pass ${order[0]} then ${order[1]} — M frees only when every cause is discharged`, async () => {
      const { group, id } = await buildGraph(
        `case 17 ${order.join('-')}`,
        [
          { key: 'G1', type: 'gate', binding: 'A1' },
          { key: 'G2', type: 'gate', binding: 'A2' },
          { key: 'W', type: 'work' },
          { key: 'H', type: 'gate' },
          { key: 'M', type: 'work' },
        ],
        [
          ['G1', 'W'],
          ['G2', 'W'],
          ['W', 'H'],
          ['H', 'M'],
        ]
      );
      await sweep(group);
      expect((await verdict(id.G1, reviewer, 'passed')).success).toBe(true);
      expect((await verdict(id.G2, reviewer, 'passed')).success).toBe(true);
      await claimAndComplete(id.W, sess1);
      expect((await verdict(id.H, reviewer, 'passed')).success).toBe(true);
      expect(evalOf(await sweep(group)).readyWork.map((n) => n.id)).toEqual([id.M]);

      expect((await revoke(id.G1, { identity: reviewer })).success).toBe(true);
      expect((await revoke(id.G2, { identity: reviewer })).success).toBe(true);
      expect(await openHolds(id.M)).toHaveLength(2);

      const first = await verdict(id[order[0]], reviewer, 'passed');
      expect(first.success).toBe(true);
      const remaining = await openHolds(id.M);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].source_gate_id).toBe(id[order[1]]);
      expect(evalOf(first).readyWork.map((n) => n.id)).not.toContain(id.M);
      expect(
        await groups.claimGraphTask({ userId: USER, taskId: id.M, sessionId: sess1 })
      ).toMatchObject({
        success: false,
        reason: 'held',
      });

      const second = await verdict(id[order[1]], reviewer, 'passed');
      expect(second.success).toBe(true);
      expect(await openHolds(id.M)).toHaveLength(0);
      expect(evalOf(second).readyWork.map((n) => n.id)).toEqual([id.M]);
    });
  }

  // ── Case 10: nonzero dwell on the fresh attempt ─────────────────────────

  it('case 10: revoking a dwelling gate schedules the new attempt at eligible_at and opens it there, not at once', async () => {
    const DWELL = 2;
    const { group, id } = await buildGraph(
      'case 10',
      [
        { key: 'G', type: 'gate', notBefore: DWELL },
        { key: 'W', type: 'work' },
      ],
      [['G', 'W']]
    );
    let ev = evalOf(await sweep(group));
    expect(ev.scheduledGates.map((g) => g.id)).toEqual([id.G]);
    await sleep(DWELL * 1000 + 300);
    ev = evalOf(await sweep(group));
    expect(ev.openedGates.map((g) => g.id)).toEqual([id.G]);
    expect((await verdict(id.G, reviewer, 'passed')).success).toBe(true);

    const r = await revoke(id.G, { identity: reviewer });
    expect(r.success).toBe(true);
    expect(evalOf(r).openedGates).toEqual([]);
    expect(evalOf(r).scheduledGates.map((g) => g.id)).toEqual([id.G]);
    const row = await gate(id.G);
    expect(row.gate_state).toBe('not_ready');
    expect(row.gate_attempt).toBe(2);
    // Both stamps are the server's clock: the window is exactly the dwell,
    // measured on one clock rather than against this process's.
    const eligible = new Date(row.eligible_at as string).getTime();
    const dwellStarted = new Date(row.dwell_started_at as string).getTime();
    expect(eligible - dwellStarted).toBe(DWELL * 1000);
    expect(evalOf(await sweep(group)).openedGates).toEqual([]);
    await sleep(DWELL * 1000 + 300);
    ev = evalOf(await sweep(group));
    expect(ev.openedGates.map((g) => g.id)).toEqual([id.G]);
    expect(ev.openedGates[0].attempt).toBe(2);
  });

  // ── Cases 14 and 5: supersession while the review is open ───────────────

  it('cases 14 + 5: supersession from in_progress releases the reviewer, bounces the late verdict, and the new attempt decides the new binding with the new author set', async () => {
    const { group, id } = await buildGraph(
      'case 14',
      [
        { key: 'G', type: 'gate', binding: 'A', authors: [{ kind: 'sb', id: author }] },
        { key: 'W', type: 'work' },
      ],
      [['G', 'W']]
    );
    await sweep(group);
    const claim = await groups.claimGraphTask({ userId: USER, taskId: id.G, sessionId: sess1 });
    expect(claim.success).toBe(true);
    const staleAttempt = claim.attempt as number;
    const staleVersion = claim.gateVersion as number;
    const staleToken = claim.claimToken as string;

    // Guards: the request revision is part of the CAS; an unchanged binding is refused.
    expect(
      await groups.supersedeGate({
        userId: USER,
        taskId: id.G,
        expectedAttempt: staleAttempt,
        expectedGateVersion: staleVersion,
        expectedRequestRevision: 7,
        binding: { tuple: 'B' },
        bindingHash: 'B',
        actorIdentityId: author,
      })
    ).toMatchObject({ success: false, reason: 'revision-conflict', currentRequestRevision: 0 });
    expect(
      await groups.supersedeGate({
        userId: USER,
        taskId: id.G,
        expectedAttempt: staleAttempt,
        expectedGateVersion: staleVersion,
        expectedRequestRevision: 0,
        binding: { tuple: 'A' },
        bindingHash: 'A',
        actorIdentityId: author,
      })
    ).toMatchObject({ success: false, reason: 'binding-unchanged' });

    // The author's changed candidate supersedes the request.
    const s = await groups.supersedeGate({
      userId: USER,
      taskId: id.G,
      expectedAttempt: staleAttempt,
      expectedGateVersion: staleVersion,
      expectedRequestRevision: 0,
      binding: { tuple: 'B' },
      bindingHash: 'B',
      authors: [{ kind: 'sb', id: stranger }],
      actorIdentityId: author,
      reason: 'amended the commit',
    });
    expect(s).toMatchObject({
      success: true,
      attempt: 2,
      requestRevision: 1,
      revokedEventId: null,
    });
    const row = await gate(id.G);
    expect(row).toMatchObject({
      gate_binding_hash: 'B',
      gate_request_revision: 1,
      gate_attempt: 2,
      claimed_by_session_id: null,
    });
    expect(row.gate_authors).toEqual([{ kind: 'sb', id: stranger }]);
    // Reopened at once over the new binding.
    expect(evalOf(s).openedGates.map((g) => g.id)).toEqual([id.G]);
    const released = (await events(id.G)).find((e) => e.event === 'claim_released');
    expect(released).toMatchObject({ reason: 'superseded', claim_token: staleToken });

    // The reviewer's late verdict for attempt 1 bounces without mutation.
    const late = await groups.recordGateVerdict({
      userId: USER,
      taskId: id.G,
      verdict: 'passed',
      expectedAttempt: staleAttempt,
      expectedGateVersion: staleVersion,
      actorIdentityId: reviewer,
      sessionId: sess1,
      claimToken: staleToken,
      evidence: { checked: true },
    });
    expect(late.success).toBe(false);
    expect(['attempt-conflict', 'superseded']).toContain(late.reason);
    expect((await gate(id.G)).gate_state).toBe('open');

    // Case 5: evidence about A never decides B; an author never decides at all.
    expect(await verdict(id.G, reviewer, 'passed', { bindingHash: 'A' })).toMatchObject({
      success: false,
      reason: 'binding-mismatch',
      currentBindingHash: 'B',
    });
    expect(await verdict(id.G, stranger, 'passed', { bindingHash: 'B' })).toMatchObject({
      success: false,
      reason: 'actor-is-author',
    });
    const passed = await verdict(id.G, reviewer, 'passed', { bindingHash: 'B' });
    expect(passed).toMatchObject({ success: true, attempt: 2 });
    expect((await events(id.G)).find((e) => e.event === 'passed')?.binding_hash).toBe('B');
    expect(await unresolved(id.G, 'A')).toHaveLength(0);
  });

  it('supersession from passed revokes the old binding first: holds on the closure, the old withdrawal unresolved for that binding only', async () => {
    const { group, id } = await buildGraph(
      'supersede passed',
      [
        { key: 'G', type: 'gate', binding: 'A' },
        { key: 'W', type: 'work' },
      ],
      [['G', 'W']]
    );
    await sweep(group);
    expect((await verdict(id.G, reviewer, 'passed')).success).toBe(true);
    const claim = await groups.claimGraphTask({ userId: USER, taskId: id.W, sessionId: sess1 });
    expect(claim.success).toBe(true);

    const row = await gate(id.G);
    const s = await groups.supersedeGate({
      userId: USER,
      taskId: id.G,
      expectedAttempt: row.gate_attempt,
      expectedGateVersion: row.gate_version,
      expectedRequestRevision: 0,
      binding: { tuple: 'B' },
      bindingHash: 'B',
      systemActor: true,
      reason: 'verified request change',
    });
    expect(s.success).toBe(true);
    expect(s.revokedEventId).toBeTruthy();
    expect((s.holds as unknown[]).length).toBe(1);
    const holds = await openHolds(id.W);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      binding_hash: 'A',
      source_attempt: 1,
      cause_event_id: s.revokedEventId,
    });
    expect((await gate(id.W)).claimed_by_session_id).toBeNull();
    expect(await unresolved(id.G, 'A')).toHaveLength(1);
    expect(await unresolved(id.G, 'B')).toHaveLength(0);
    const kinds = (await events(id.G)).map((e) => e.event);
    expect([...kinds].sort()).toEqual(['opened', 'opened', 'passed', 'revoked', 'superseded']);
  });

  // ── After consumption ───────────────────────────────────────────────────

  it('after consumption: supersede refuses already-published; revoke fails the attempt (revoked-after-publication), holds the closure, invalidates a prepared operation, and retry stays reachable', async () => {
    const { group, id } = await buildGraph(
      'consumed',
      [
        { key: 'G', type: 'gate', binding: 'A' },
        { key: 'P', type: 'work' },
        { key: 'C', type: 'work' },
      ],
      [
        ['G', 'P'],
        ['P', 'C'],
      ]
    );
    await sweep(group);
    const passed = await verdict(id.G, reviewer, 'passed');
    expect(passed.success).toBe(true);
    const consumedOp = randomUUID();
    const preparedOp = randomUUID();
    const { error: opErr } = await client.from('publication_operations').insert([
      {
        id: consumedOp,
        user_id: USER,
        task_group_id: group,
        gate_task_id: id.G,
        gate_attempt: 1,
        publish_task_id: id.P,
        binding: { tuple: 'A' },
        policy_ref: { source: 'fixture' },
        authority: 'clearance',
        authority_event_id: passed.eventId as string,
        authorizer_identity_id: reviewer,
        intent_hash: 'fixture-consumed',
      },
      {
        id: preparedOp,
        user_id: USER,
        task_group_id: group,
        gate_task_id: id.G,
        gate_attempt: 1,
        publish_task_id: id.P,
        binding: { tuple: 'A' },
        policy_ref: { source: 'fixture' },
        authority: 'clearance',
        authority_event_id: passed.eventId as string,
        authorizer_identity_id: reviewer,
        intent_hash: 'fixture-prepared',
      },
    ]);
    if (opErr) throw new Error(`fixture operations: ${opErr.message}`);
    const now = new Date().toISOString();
    const { error: evErr } = await client.from('publication_operation_events').insert([
      { operation_id: consumedOp, seq: 1, phase: 'prepared', source: 'online', observed_at: now },
      {
        operation_id: consumedOp,
        seq: 2,
        phase: 'consumed',
        source: 'online',
        observed_at: now,
        connectivity: 'online',
        server_state_verified: true,
        server_watermark: { gateVersion: 2 },
      },
      { operation_id: preparedOp, seq: 1, phase: 'prepared', source: 'online', observed_at: now },
    ]);
    if (evErr) throw new Error(`fixture operation events: ${evErr.message}`);

    const row = await gate(id.G);
    expect(
      await groups.supersedeGate({
        userId: USER,
        taskId: id.G,
        expectedAttempt: row.gate_attempt,
        expectedGateVersion: row.gate_version,
        expectedRequestRevision: 0,
        binding: { tuple: 'B' },
        bindingHash: 'B',
        systemActor: true,
      })
    ).toMatchObject({ success: false, reason: 'already-published' });

    const r = await revoke(id.G, { identity: reviewer }, 'found a secret in the message');
    expect(r).toMatchObject({ success: true, afterConsumption: true, attempt: 1 });
    expect(await gate(id.G)).toMatchObject({
      gate_state: 'failed',
      gate_attempt: 1,
      status: 'blocked',
      outcome_reason: 'revoked-after-publication',
    });
    expect(ids(evalOf(r).heldNodes)).toEqual(ids([{ id: id.P }, { id: id.C }]));
    // The prepared record is invalidated; the consumed one is left as history.
    const { data: opEvents } = await client
      .from('publication_operation_events')
      .select('operation_id, phase')
      .in('operation_id', [consumedOp, preparedOp]);
    const phases = (id: string) =>
      (opEvents ?? [])
        .filter((e) => e.operation_id === id)
        .map((e) => e.phase)
        .sort();
    expect(phases(preparedOp)).toEqual(['invalidated', 'prepared']);
    expect(phases(consumedOp)).toEqual(['consumed', 'prepared']);
    // Retryable as any failed gate; the withdrawal stays unresolved for A.
    const retried = await groups.retryGate({
      userId: USER,
      taskId: id.G,
      expectedAttempt: 1,
      actorIdentityId: reviewer,
      reason: 'post-hoc review',
    });
    expect(retried).toMatchObject({ success: true, attempt: 2 });
    expect(await unresolved(id.G, 'A')).toHaveLength(1);
    expect(await openHolds(id.P)).toHaveLength(1);
  });

  // ── Authority ───────────────────────────────────────────────────────────

  it('revocation authority is enumerated: a stranger refuses; author, assignee-as-verdict-actor and owner succeed; reason and CAS are required', async () => {
    const { group, id } = await buildGraph(
      'authority',
      [
        { key: 'G', type: 'gate', binding: 'A', authors: [{ kind: 'sb', id: author }] },
        { key: 'W', type: 'work' },
      ],
      [['G', 'W']]
    );
    await sweep(group);
    expect((await verdict(id.G, reviewer, 'passed')).success).toBe(true);
    expect(await revoke(id.G, { identity: stranger })).toMatchObject({
      success: false,
      reason: 'not-authorized',
    });
    expect(await revoke(id.G, { identity: author }, '')).toMatchObject({
      success: false,
      reason: 'reason-required',
    });
    const row = await gate(id.G);
    expect(
      await groups.revokeGate({
        userId: USER,
        taskId: id.G,
        expectedAttempt: row.gate_attempt,
        expectedGateVersion: row.gate_version + 5,
        actorIdentityId: author,
        reason: 'stale',
      })
    ).toMatchObject({ success: false, reason: 'version-conflict' });
    expect(await revoke(id.G, { identity: author })).toMatchObject({
      success: true,
      authority: 'author',
    });
    // Not passed any more: a second revoke refuses.
    expect(await revoke(id.G, { identity: author })).toMatchObject({
      success: false,
      reason: 'not-passed',
    });

    expect((await verdict(id.G, reviewer, 'passed')).success).toBe(true);
    expect(await revoke(id.G, { user: USER })).toMatchObject({ success: true, authority: 'owner' });
    expect((await gate(id.G)).gate_attempt).toBe(3);
  });

  it('lift_withdrawal: owner only; names the event; releases only the holds that withdrawal placed; a second lift refuses already-resolved', async () => {
    const { group, id } = await buildGraph(
      'lift',
      [
        { key: 'G', type: 'gate', binding: 'A' },
        { key: 'W', type: 'work' },
      ],
      [['G', 'W']]
    );
    await sweep(group);
    expect((await verdict(id.G, reviewer, 'passed')).success).toBe(true);
    const r = await revoke(id.G, { identity: reviewer });
    expect(r.success).toBe(true);
    expect(await openHolds(id.W)).toHaveLength(1);

    expect(
      await groups.liftWithdrawal({
        userId: USER,
        taskId: id.G,
        withdrawalEventId: r.eventId as string,
        actorIdentityId: stranger,
        reason: 'no',
      })
    ).toMatchObject({ success: false, reason: 'not-authorized' });
    expect(
      await groups.liftWithdrawal({
        userId: USER,
        taskId: id.G,
        withdrawalEventId: r.eventId as string,
        actorUserId: USER,
        reason: '',
      })
    ).toMatchObject({ success: false, reason: 'reason-required' });
    const lifted = await groups.liftWithdrawal({
      userId: USER,
      taskId: id.G,
      withdrawalEventId: r.eventId as string,
      actorUserId: USER,
      reason: 'reviewed the object set by hand; nothing private',
    });
    expect(lifted).toMatchObject({ success: true, resolvesEventId: r.eventId });
    expect((lifted.releasedHolds as unknown[]).length).toBe(1);
    expect(await openHolds(id.W)).toHaveLength(0);
    expect(await unresolved(id.G, 'A')).toHaveLength(0);
    const lift = (await events(id.G)).find((e) => e.event === 'withdrawal_lifted');
    expect(lift).toMatchObject({ resolves_event_id: r.eventId, binding_hash: 'A' });
    expect(
      await groups.liftWithdrawal({
        userId: USER,
        taskId: id.G,
        withdrawalEventId: r.eventId as string,
        actorUserId: USER,
        reason: 'again',
      })
    ).toMatchObject({ success: false, reason: 'already-resolved' });
  });

  it('case 19 prelude: a failed verdict is an unresolved withdrawal for its binding across retry, until a pass on that binding', async () => {
    const { group, id } = await buildGraph(
      'case 19',
      [{ key: 'G', type: 'gate', binding: 'A' }],
      []
    );
    await sweep(group);
    expect((await verdict(id.G, reviewer, 'failed')).success).toBe(true);
    expect(await unresolved(id.G, 'A')).toHaveLength(1);
    expect(
      await groups.retryGate({
        userId: USER,
        taskId: id.G,
        expectedAttempt: 1,
        actorIdentityId: reviewer,
      })
    ).toMatchObject({ success: true, attempt: 2 });
    expect(await unresolved(id.G, 'A')).toHaveLength(1);
    expect((await verdict(id.G, reviewer, 'passed')).success).toBe(true);
    expect(await unresolved(id.G, 'A')).toHaveLength(0);
  });

  // ── Fences and invariants ───────────────────────────────────────────────

  it('the gate request columns are verification-only and executor-owned on graph tasks', async () => {
    const { id } = await buildGraph(
      'fence',
      [
        { key: 'G', type: 'gate', binding: 'A' },
        { key: 'W', type: 'work' },
      ],
      [['G', 'W']]
    );
    const direct = await client.from('tasks').update({ gate_binding_hash: 'B' }).eq('id', id.G);
    expect(direct.error?.message).toMatch(/executor-owned/);
    expect((await gate(id.G)).gate_binding_hash).toBe('A');
    const onWork = await client.from('tasks').insert({
      id: randomUUID(),
      user_id: USER,
      title: 'w',
      task_type: 'work',
      gate_binding_hash: 'A',
    } as never);
    expect(onWork.error?.message).toMatch(/gate_request_on_verification/);
  });

  it('a held gate is never opened by the evaluator, a held node is never claimable, and a held group never completes', async () => {
    const DWELL = 1;
    const { group, id } = await buildGraph(
      'held',
      [
        { key: 'G', type: 'gate' },
        { key: 'H', type: 'gate', notBefore: DWELL },
        { key: 'M', type: 'work' },
      ],
      [
        ['G', 'H'],
        ['H', 'M'],
      ]
    );
    await sweep(group);
    const passed = await verdict(id.G, reviewer, 'passed');
    expect(passed.success).toBe(true);
    expect(evalOf(passed).scheduledGates.map((g) => g.id)).toEqual([id.H]);
    // A fixture hold on the dwelling gate, caused by G's own pass event —
    // the table's contract, exercised directly.
    const { data: hold, error } = await client
      .from('task_authority_holds')
      .insert({
        task_id: id.H,
        kind: 'authority-withdrawn',
        cause_event_id: passed.eventId as string,
        source_gate_id: id.G,
        source_attempt: 1,
      })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    await sleep(DWELL * 1000 + 300);
    let ev = evalOf(await sweep(group));
    expect(ev.openedGates).toEqual([]);
    expect((await gate(id.H)).gate_state).toBe('not_ready');
    expect(ev.heldNodes.map((n) => n.id)).toEqual([id.H]);
    expect(ev.counts.held).toBe(1);
    // Held is refused before readiness is even considered.
    expect(
      await groups.claimGraphTask({ userId: USER, taskId: id.H, sessionId: sess1 })
    ).toMatchObject({
      success: false,
      reason: 'held',
    });
    await client
      .from('task_authority_holds')
      .update({ released_at: new Date().toISOString() })
      .eq('id', hold!.id);
    ev = evalOf(await sweep(group));
    expect(ev.openedGates.map((g) => g.id)).toEqual([id.H]);

    // Group completion: every node terminal, every gate passed, one hold left.
    const done = await buildGraph(
      'held completion',
      [
        { key: 'G', type: 'gate' },
        { key: 'P', type: 'work' },
      ],
      [['G', 'P']]
    );
    await sweep(done.group);
    const gp = await verdict(done.id.G, reviewer, 'passed');
    expect(gp.success).toBe(true);
    const completed = await claimAndComplete(done.id.P, sess1);
    expect(evalOf(completed).groupComplete).toBe(true);
    await client.from('task_authority_holds').insert({
      task_id: done.id.P,
      kind: 'observation-conflict',
      cause_event_id: gp.eventId as string,
      source_gate_id: done.id.G,
      source_attempt: 1,
    });
    expect(evalOf(await sweep(done.group)).groupComplete).toBe(false);
    const refused = await client
      .from('task_groups')
      .update({ status: 'completed' })
      .eq('id', done.group);
    expect(refused.error?.message).toMatch(/unreleased authority holds/);
    await client
      .from('task_authority_holds')
      .update({ released_at: new Date().toISOString() })
      .eq('task_id', done.id.P);
    const allowed = await client
      .from('task_groups')
      .update({ status: 'completed' })
      .eq('id', done.group);
    expect(allowed.error).toBeNull();
  });
});
