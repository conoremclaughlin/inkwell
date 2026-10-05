/**
 * launched_processes against a real database: a launch recorded by one
 * server, then a restart's sweep stopping it, and a second server instance
 * on another port never seeing it (task 2562f0f8).
 */
import { spawn, type ChildProcess } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
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
    const id = await store.record({
      sessionId,
      backend: 'claude-code',
      pid: child.pid!,
      pgid: null,
      startIdentity,
      bootId: BOOT,
      serverInstance: MAIN,
    });

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
});
