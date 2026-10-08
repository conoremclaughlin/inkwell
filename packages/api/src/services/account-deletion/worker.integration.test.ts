/**
 * The deletion worker end to end against a real database, with its file
 * roots in a temporary directory and the Supabase sign-in deletion stood in
 * for (ink://specs/account-deletion v6 §4).
 *
 * Run via: yarn test:integration:db:local src/services/account-deletion/worker.integration.test.ts
 *
 * Every person here is invented, at example.com.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataComposer } from '../../data/composer';
import { claudeProjectDirName } from './files';
import { accountGate } from './gate';
import { advanceDeletion, nextSweep, SWEEP_SIZE, type DeletionDeps } from './worker';

const run = randomUUID().slice(0, 8);
let base: string;
let roots: DeletionDeps['roots'];
const revoked: string[] = [];
const stopped: string[] = [];

async function client() {
  return (await getDataComposer()).getClient();
}

async function deps(): Promise<DeletionDeps> {
  return {
    db: await client(),
    deleteAuthUser: async (authUid) => {
      revoked.push(authUid);
      return 'deleted';
    },
    stopTurns: (sbIds) => stopped.push(...sbIds),
    serverInstance: () => 'test-host:1',
    roots,
    uploadsRoot: null,
    drainTimeoutMs: 50,
    now: Date.now,
  };
}

async function consumer(label: string, extra?: { identityMetadata?: Record<string, unknown> }) {
  const db = await client();
  const authUid = randomUUID();
  const { data: user, error } = await db
    .from('users')
    .insert({ email: `${label}-${run}@example.com`, auth_uid: authUid })
    .select('id')
    .single();
  if (error || !user) throw new Error(`user: ${error?.message}`);
  const { data: personal } = await db
    .from('workspaces')
    .select('id')
    .eq('user_id', user.id)
    .eq('type', 'personal')
    .single();
  const { data: inkling, error: idError } = await db
    .from('agent_identities')
    .insert({
      user_id: user.id,
      workspace_id: personal!.id,
      agent_id: `inkling-${label}-${run}`,
      name: 'Pip',
      role: 'Inkling',
      metadata: (extra?.identityMetadata ?? { client: 'inkling-mobile' }) as never,
    })
    .select('id')
    .single();
  if (idError || !inkling) throw new Error(`identity: ${idError?.message}`);
  const { error: reqError } = await db
    .from('account_deletion_requests')
    .insert({ user_id: user.id, auth_uid: authUid });
  if (reqError) throw new Error(`request: ${reqError.message}`);
  return { userId: user.id, sbId: inkling.id, authUid };
}

function plantFiles(sbId: string) {
  const folder = join(roots.inklings, sbId);
  mkdirSync(join(folder, '.ink', 'runtime', 'repl'), { recursive: true });
  writeFileSync(join(folder, '.ink', 'runtime', 'repl', 'session-1.jsonl'), '{}');
  mkdirSync(join(roots.inklings, '.tool-policy'), { recursive: true });
  writeFileSync(join(roots.inklings, '.tool-policy', `${sbId}.json`), '{}');
  const projects = join(roots.claudeProjects, claudeProjectDirName(folder));
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, 'transcript.jsonl'), '{}');
  return { folder, projects };
}

async function stepOf(userId: string) {
  const { data } = await (await client())
    .from('account_deletion_requests')
    .select('step, outcomes')
    .eq('user_id', userId)
    .single();
  return data as { step: string; outcomes: Record<string, unknown> };
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'acct-worker-')));
  roots = {
    inklings: join(base, 'inklings'),
    claudeProjects: join(base, 'claude-projects'),
    codexSessions: join(base, 'codex-sessions'),
  };
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true });
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('the deletion worker', () => {
  it('takes a consumer account from request to completed: sign-in, files and rows', async () => {
    const lia = await consumer('lia');
    const { folder, projects } = plantFiles(lia.sbId);

    const result = await advanceDeletion(await deps(), lia.userId);

    expect(result).toEqual({ step: 'completed' });
    expect(revoked).toContain(lia.authUid);
    expect(stopped).toContain(lia.sbId);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(projects)).toBe(false);
    expect(existsSync(join(roots.inklings, '.tool-policy', `${lia.sbId}.json`))).toBe(false);
    const db = await client();
    expect((await db.from('users').select('id').eq('id', lia.userId)).data).toEqual([]);
    expect((await stepOf(lia.userId)).step).toBe('completed');
    expect(accountGate.isClosed(lia.userId)).toBe(false);
  });

  it('holds an operator account before anything is revoked', async () => {
    const max = await consumer('max', { identityMetadata: {} });
    const before = revoked.length;

    const result = await advanceDeletion(await deps(), max.userId);

    expect(result.step).toBe('requested');
    expect(result.held).toMatch(/not an inkling/);
    expect(revoked.length).toBe(before);
    expect(accountGate.isClosed(max.userId)).toBe(false);
  });

  it('waits at the drain while work of the account is inside its gate, and finishes once it leaves', async () => {
    const neo = await consumer('neo');
    const lease = accountGate.enter(neo.userId);

    const held = await advanceDeletion(await deps(), neo.userId);
    expect(held).toMatchObject({
      step: 'auth_revoked',
      held: 'work of the account is still running',
    });
    // The work that entered before the close keeps its lease; new work is refused.
    expect(() => accountGate.enter(neo.userId)).toThrow();

    lease.release();
    expect(await advanceDeletion(await deps(), neo.userId)).toEqual({ step: 'completed' });
  });

  it('holds when a file of the inventory is a link, removing nothing', async () => {
    const oli = await consumer('oli');
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, join(roots.inklings, oli.sbId));

    const result = await advanceDeletion(await deps(), oli.userId);

    expect(result.step).toBe('drained');
    expect(result.held).toMatch(/inkling-folder held: a link/);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    const db = await client();
    expect((await db.from('users').select('id').eq('id', oli.userId)).data).toHaveLength(1);
  });
});

describe('the sweep against a real database', () => {
  it('reads past a full instant by (requested_at, user_id), with the filters PostgREST is sent (Lumen, #783 r2)', async () => {
    const db = await client();
    // One instant with more requests than a sweep takes, microseconds and
    // all, after anything another suite left pending.
    const at = '2100-01-01T00:00:00.123456+00:00';
    const ids = Array.from({ length: SWEEP_SIZE + 1 }, () => randomUUID());
    const { error } = await db
      .from('account_deletion_requests')
      .insert(ids.map((user_id) => ({ user_id, requested_at: at })));
    if (error) throw new Error(`requests: ${error.message}`);
    try {
      const sweepDeps: DeletionDeps = { ...(await deps()), sweep: { after: null } };
      const seen = new Set<string>();
      for (let i = 0; i < 50; i++) {
        for (const row of await nextSweep(sweepDeps)) seen.add(row.user_id);
        if (sweepDeps.sweep?.after === null) break;
      }
      expect(ids.filter((userId) => !seen.has(userId))).toEqual([]);
    } finally {
      await db.from('account_deletion_requests').delete().in('user_id', ids);
    }
  });
});
