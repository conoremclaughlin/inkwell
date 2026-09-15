/**
 * Workflow Graph Executor — Live LLM Test
 *
 * End-to-end with a real LLM (Opus 5 via Claude Code — Conor, 2026-08-21:
 * live tests run on opus to protect tokens) executing a graph-mode task
 * group through the real MCP tools on a running Inkwell server:
 *
 *   get_task_graph → claim_task → complete_task(claimToken) → push →
 *   gate opens → claim gate → record_gate_verdict(passed, evidence) →
 *   downstream → group complete
 *
 * This is the tier that proves the executor is USABLE by an agent, not
 * just correct under direct RPC calls (the DB-integration suite): the
 * structured refusals must be legible enough that a model drives the
 * whole lifecycle from tool responses alone.
 *
 * Fixture posture: the gate is HUMAN-assigned and the group has no owner
 * SB, so the main server's reconciliation sweep never dispatches inbox
 * triggers at real agents while the test group is live — the LLM session
 * claims the executable gate instead (claim-holder verdict authority).
 *
 * Requires:
 * - INK_LIVE_TESTS=1
 * - claude CLI installed with valid credentials
 * - Inkwell server running (default localhost:3001, override via PCP_SERVER_URL)
 * - Valid access token in ~/.ink/auth.json
 * - LOCAL Supabase credentials (.env.local) — mutates DB rows; a remote
 *   SUPABASE_URL is refused unless INK_ALLOW_REMOTE_INTEGRATION_DB=1.
 *
 * INTENTIONAL: consumes REAL LLM tokens; excluded from CI by config
 * (collected only by vitest.live.config.ts) AND the INK_LIVE_TESTS gate.
 *
 * Run:
 *   INK_LIVE_TESTS=1 \
 *     yarn workspace @inklabs/api test:live src/services/graph-executor.live.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { execFileSync, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { homedir, tmpdir } from 'os';
import { randomUUID } from 'crypto';
import type { Database } from '../data/supabase/types';
import { TaskGroupsRepository } from '../data/repositories/task-groups.repository';

// ============================================================================
// Environment + prerequisite gates (same posture as strategy-approval-gate)
// ============================================================================

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

const configPath = resolve(homedir(), '.ink/config.json');
const inkConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {};
const TEST_USER_ID: string | undefined = inkConfig.userId;

const authPath = resolve(homedir(), '.ink/auth.json');
const accessToken: string | null = existsSync(authPath)
  ? JSON.parse(readFileSync(authPath, 'utf-8')).access_token
  : null;

const INKWELL_URL = process.env.PCP_SERVER_URL || 'http://localhost:3001';

/** Live tests run on Opus, never the session's own frontier model. */
const LIVE_TEST_MODEL = 'claude-opus-5';

function claudeAvailable(): boolean {
  const result = spawnSync('which', ['claude'], { stdio: 'ignore', timeout: 5_000 });
  return result.status === 0;
}

function claudeCredentialsAvailable(): boolean {
  const credFile = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(credFile)) return true;
  if (process.platform === 'darwin') {
    try {
      execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function inkwellReachable(): boolean {
  try {
    execFileSync('curl', ['-sf', '-o', '/dev/null', `${INKWELL_URL}/health`], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function supabaseTargetAllowed(): boolean {
  if (process.env.INK_ALLOW_REMOTE_INTEGRATION_DB === '1') return true;
  if (!SUPABASE_URL) return false;
  try {
    return LOCALHOST_HOSTS.has(new URL(SUPABASE_URL).hostname);
  } catch {
    return false;
  }
}
if (process.env.INK_LIVE_TESTS === '1' && SUPABASE_URL && !supabaseTargetAllowed()) {
  process.stderr.write(
    '[graph-executor.live] Refusing non-local SUPABASE_URL. This suite mutates DB rows. ' +
      'Set INK_ALLOW_REMOTE_INTEGRATION_DB=1 if you intentionally want a remote target.\n'
  );
}

const canRun =
  process.env.INK_LIVE_TESTS === '1' &&
  !!SUPABASE_URL &&
  !!SUPABASE_KEY &&
  supabaseTargetAllowed() &&
  !!TEST_USER_ID &&
  !!accessToken &&
  claudeAvailable() &&
  claudeCredentialsAvailable() &&
  inkwellReachable();

// ============================================================================
// Suite: worker session drives the graph lifecycle end-to-end
// ============================================================================

describe.skipIf(!canRun)('Workflow graph executor — worker session (LLM live)', () => {
  let client: SupabaseClient<Database>;
  let groups: TaskGroupsRepository;
  let tmpDir: string;

  const groupId = randomUUID();
  const w1 = randomUUID();
  const w2 = randomUUID();
  const gate = randomUUID();
  const w3 = randomUUID();
  let sessionId: string;

  beforeAll(async () => {
    client = createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    groups = new TaskGroupsRepository(client);

    const { data: sess, error: sErr } = await client
      .from('sessions')
      .insert({ user_id: TEST_USER_ID! } as never)
      .select('id')
      .single();
    if (sErr) throw new Error(`fixture session: ${sErr.message}`);
    sessionId = (sess as { id: string }).id;

    // No sb_id and a HUMAN-assigned gate: the main server's sweep has no
    // agent to dispatch to, so the live group never triggers real SBs.
    const { error: gErr } = await client.from('task_groups').insert({
      id: groupId,
      user_id: TEST_USER_ID!,
      title: `__llm_graph_executor_live_${Date.now()}`,
      description: 'Live LLM graph executor test — safe to delete',
      priority: 'low',
      tags: ['__test'],
    } as never);
    if (gErr) throw new Error(`fixture group: ${gErr.message}`);

    const { error: tErr } = await client.from('tasks').insert([
      {
        id: w1,
        user_id: TEST_USER_ID!,
        task_group_id: groupId,
        title: 'Record the project motto',
        description: 'No real work — just drive the graph tools correctly.',
        task_type: 'work',
        priority: 'low',
        created_by: 'live-test',
      },
      {
        id: w2,
        user_id: TEST_USER_ID!,
        task_group_id: groupId,
        title: 'Confirm the motto was recorded',
        task_type: 'work',
        priority: 'low',
        created_by: 'live-test',
      },
      {
        id: gate,
        user_id: TEST_USER_ID!,
        task_group_id: groupId,
        title: 'Verify both steps completed',
        task_type: 'verification',
        gate_state: 'not_ready',
        assignee_user_id: TEST_USER_ID!,
        priority: 'low',
        created_by: 'live-test',
      },
      {
        id: w3,
        user_id: TEST_USER_ID!,
        task_group_id: groupId,
        title: 'Announce completion',
        task_type: 'work',
        priority: 'low',
        created_by: 'live-test',
      },
    ] as never);
    if (tErr) throw new Error(`fixture tasks: ${tErr.message}`);

    const conv = await groups.convertToGraph({
      userId: TEST_USER_ID!,
      taskGroupId: groupId,
      expectedVersion: 0,
      systemActor: true,
    });
    if (conv.success !== true) throw new Error(`fixture convert: ${JSON.stringify(conv)}`);
    const applied = await groups.applyTaskGraph({
      userId: TEST_USER_ID!,
      taskGroupId: groupId,
      expectedVersion: 1,
      edges: [
        { from: w1, to: w2 },
        { from: w2, to: gate },
        { from: gate, to: w3 },
      ],
      systemActor: true,
    });
    if (applied.success !== true) throw new Error(`fixture edges: ${JSON.stringify(applied)}`);

    tmpDir = join(tmpdir(), `graph-executor-live-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          inkwell: {
            type: 'http',
            url: `${INKWELL_URL}/mcp`,
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        },
      })
    );
  }, 30_000);

  afterAll(async () => {
    if (client) {
      await client.from('activity_stream').delete().eq('task_group_id', groupId);
      await client.from('tasks').delete().in('id', [w1, w2, gate, w3]);
      await client.from('task_groups').delete().eq('id', groupId);
      if (sessionId) await client.from('sessions').delete().eq('id', sessionId);
    }
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  }, 10_000);

  it('Opus drives claim → complete → gate verdict → downstream to group completion via MCP', async () => {
    const { ClaudeRunner } = await import('./sessions/claude-runner');
    const runner = new ClaudeRunner();

    const result = await runner.run(
      `You are executing graph-mode task group ${groupId} as session ${sessionId}. ` +
        `Protocol — use ONLY these MCP tools, no code, no files:\n` +
        `1. mcp__inkwell__get_task_graph(taskGroupId: "${groupId}") to see nodes, edges, and gate state.\n` +
        `2. For each READY work node (status pending, every incoming edge's source completed/passed): ` +
        `mcp__inkwell__claim_task(taskId, sessionId: "${sessionId}"), then ` +
        `mcp__inkwell__complete_task(taskId, claimToken: <from claim_task>, sessionId: "${sessionId}", summary: <one line>).\n` +
        `3. When the verification gate is OPEN (gateState "open"), claim it the same way, then ` +
        `mcp__inkwell__record_gate_verdict(taskId: <gate id>, verdict: "passed", ` +
        `expectedAttempt and expectedGateVersion from get_task_graph AFTER claiming, ` +
        `sessionId: "${sessionId}", claimToken: <from claim_task>, ` +
        `evidence: {"kind": "live-test", "ref": "both upstream nodes completed"}).\n` +
        `4. Keep going until get_task_graph shows every node completed/passed. ` +
        `Tool responses are structured — if one refuses (not-ready, claim-mismatch, version-conflict), ` +
        `re-read the graph and correct course. Stop when the group is complete.`,
      {
        config: {
          workingDirectory: tmpDir,
          mcpConfigPath: join(tmpDir, '.mcp.json'),
          model: LIVE_TEST_MODEL,
        },
      }
    );

    expect(result.success).toBe(true);

    // The graph reached the terminal state through the executor, not around it.
    const { data: rows } = await client
      .from('tasks')
      .select('id, status, outcome, gate_state, claimed_by_session_id')
      .in('id', [w1, w2, gate, w3]);
    const byId = new Map((rows ?? []).map((r) => [r.id, r]));
    expect(byId.get(w1)).toMatchObject({ status: 'completed', outcome: 'completed' });
    expect(byId.get(w2)).toMatchObject({ status: 'completed', outcome: 'completed' });
    expect(byId.get(gate)).toMatchObject({ status: 'completed', gate_state: 'passed' });
    expect(byId.get(w3)).toMatchObject({ status: 'completed', outcome: 'completed' });
    for (const row of rows ?? []) expect(row.claimed_by_session_id).toBeNull();

    // Group finalized (by the completing dispatch or the sweep — either
    // finalizer is the same machinery).
    const { data: group } = await client
      .from('task_groups')
      .select('status, execution_phase')
      .eq('id', groupId)
      .single();
    expect(group?.status === 'completed' || group?.execution_phase === 'completed').toBe(true);

    // The event log tells the whole story: claims for three work nodes and
    // the gate, an opened gate, a passed verdict carrying evidence.
    const { data: events } = await client
      .from('task_gate_events')
      .select('event, task_id, evidence')
      .in('task_id', [w1, w2, gate, w3])
      .order('created_at');
    const kinds = (events ?? []).map((e) => e.event);
    expect(kinds.filter((k) => k === 'claimed').length).toBeGreaterThanOrEqual(4);
    expect(kinds).toContain('opened');
    expect(kinds).toContain('passed');
    const passedEvent = (events ?? []).find((e) => e.event === 'passed');
    expect(passedEvent?.evidence).toBeTruthy();
  }, 300_000);
});
