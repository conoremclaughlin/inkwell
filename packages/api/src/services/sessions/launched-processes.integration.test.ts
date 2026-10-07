/**
 * launched_processes against a real database: a launch recorded by one
 * server, then a restart's sweep stopping it, and a second server instance
 * on another port never seeing it (task 2562f0f8).
 */
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildCleanEnv } from '@inklabs/shared';
import { getDataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';
import {
  processStartIdentity,
  stopSurvivingLaunches,
  supabaseLaunchStore,
} from './launched-processes';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const BOOT = `boot-${RUN}`;
const MAIN = `host-${RUN}:3001`;
const OTHER = `host-${RUN}:4001`;

describe('launched_processes', () => {
  let supabase: SupabaseClient;
  let userId: string;
  const sessionIds: string[] = [];
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    const composer = await getDataComposer();
    supabase = composer.getClient();
    userId = (await ensureEchoIntegrationFixture(composer)).userId;
  });

  afterAll(async () => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    if (sessionIds.length) await supabase.from('sessions').delete().in('id', sessionIds);
  });

  async function newSession(): Promise<string> {
    const { data, error } = await supabase
      .from('sessions')
      .insert({ user_id: userId, agent_id: 'launched-processes-suite', status: 'active' })
      .select('id')
      .single();
    if (error || !data) throw new Error(`session insert failed: ${error?.message}`);
    sessionIds.push(data.id as string);
    return data.id as string;
  }

  it('stops a recorded survivor after a restart, and only for the instance that launched it', async () => {
    const store = supabaseLaunchStore(supabase);
    const sessionId = await newSession();
    const child = spawn('sh', ['-c', 'sleep 30'], { stdio: 'ignore' });
    children.push(child);
    const startIdentity = await processStartIdentity(child.pid!);
    const id = await store.reserve({
      sessionId,
      backend: 'claude-code',
      bootId: BOOT,
      serverInstance: MAIN,
    });
    await store.attach(id, { pid: child.pid!, pgid: null, startIdentity });

    // Another server on another port sees nothing of it.
    expect(await stopSurvivingLaunches(store, { serverInstance: OTHER, bootId: BOOT })).toEqual({
      stopped: [],
      gone: [],
      uncertain: [],
      unstoppable: [],
    });
    expect(child.exitCode === null && child.signalCode === null).toBe(true);

    // The restarted server that launched it stops it, and records the exit.
    const outcome = await stopSurvivingLaunches(store, {
      serverInstance: MAIN,
      bootId: BOOT,
      graceMs: 500,
    });
    expect(outcome.stopped.map((r) => r.id)).toEqual([id]);
    await new Promise((resolve) =>
      child.exitCode !== null || child.signalCode !== null
        ? resolve(null)
        : child.once('exit', resolve)
    );
    const { data } = await supabase
      .from('launched_processes')
      .select('exited_at')
      .eq('id', id)
      .single();
    expect(data?.exited_at).not.toBeNull();
    expect(await store.listOpen(MAIN)).toEqual([]);
  });

  it('stops a launch whose pid never reached its row, found by the id in its environment', async () => {
    const store = supabaseLaunchStore(supabase);
    const sessionId = await newSession();
    // Reserved, then the server "went down" before the pid was written.
    const id = await store.reserve({
      sessionId,
      backend: 'codex-cli',
      bootId: BOOT,
      serverInstance: MAIN,
    });
    // Node, started as `codex`: the sweep signals only a process that is the backend.
    const dir = mkdtempSync(join(tmpdir(), 'launch-backend-'));
    const codex = join(dir, 'codex');
    symlinkSync(process.execPath, codex);
    const child = spawn(codex, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
      // Through buildCleanEnv, as a runner's env is: the tag goes first.
      env: buildCleanEnv({ PATH: process.env.PATH ?? '', INK_LAUNCH_ID: id }) as NodeJS.ProcessEnv,
    });
    children.push(child);
    expect((await store.listOpen(MAIN)).find((row) => row.id === id)?.pid).toBeNull();

    const outcome = await stopSurvivingLaunches(store, {
      serverInstance: MAIN,
      bootId: BOOT,
      graceMs: 500,
    });
    expect(outcome.stopped.map((r) => [r.id, r.pid])).toEqual([[id, child.pid]]);
    await new Promise((resolve) =>
      child.exitCode !== null || child.signalCode !== null
        ? resolve(null)
        : child.once('exit', resolve)
    );
    expect(await store.listOpen(MAIN)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
