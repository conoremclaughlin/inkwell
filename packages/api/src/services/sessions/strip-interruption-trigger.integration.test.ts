/**
 * strip_interruption_on_running — the DB-level clear-on-resume.
 *
 * The invariant "a running session is not interrupted" lives in a trigger
 * because sessions are written through at least two independent paths
 * (SessionRepository.update, the CLI hooks' memory.updateSession), and both
 * rebuild the metadata JSONB from a read snapshot — an application-level
 * clear can be resurrected by a concurrent read-modify-write replaying a
 * stale blob. None of that is visible to a mock: the behaviour under test IS
 * the database's, so this suite talks to the real schema.
 *
 * Requires .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY.
 * Skipped automatically when credentials are unavailable.
 */

import { describe, it, expect, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { INTEGRATION_TEST_USER_ID } from '../../test/integration-fixtures';
import type { Database } from '../../data/supabase/types';

const projectRoot = resolve(__dirname, '../../../../../');
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

d('strip_interruption_on_running trigger', () => {
  const client: SupabaseClient<Database> = createClient(SUPABASE_URL || '', SUPABASE_KEY || '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const createdIds: string[] = [];

  async function insertSession(row: {
    lifecycle: string;
    metadata: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    createdIds.push(id);
    const { error } = await client.from('sessions').insert({
      id,
      user_id: USER,
      agent_id: 'wren',
      lifecycle: row.lifecycle,
      status: 'active',
      metadata: row.metadata,
    } as never);
    expect(error).toBeNull();
    return id;
  }

  async function readSession(
    id: string
  ): Promise<{ lifecycle: string | null; metadata: Record<string, unknown> }> {
    const { data, error } = await client
      .from('sessions')
      .select('lifecycle, metadata')
      .eq('id', id)
      .single();
    expect(error).toBeNull();
    return data as never;
  }

  afterAll(async () => {
    if (createdIds.length > 0) {
      await client.from('sessions').delete().in('id', createdIds);
    }
  });

  it('a resume write sheds the interruption breadcrumbs', async () => {
    const id = await insertSession({
      lifecycle: 'interrupted',
      metadata: {
        interruptedAt: '2026-09-01T14:49:32.000Z',
        interruptedReason: 'server-shutdown',
        taskDescription: 'review pr:558',
      },
    });

    // The resume: any writer moving the row to running — the pre-turn write,
    // a CLI on-prompt hook — even one replaying the stale breadcrumbs from a
    // snapshot it read earlier, which is exactly why this is a trigger.
    const { error } = await client
      .from('sessions')
      .update({
        lifecycle: 'running',
        metadata: {
          interruptedAt: '2026-09-01T14:49:32.000Z',
          interruptedReason: 'server-shutdown',
          taskDescription: 'review pr:558',
        },
      } as never)
      .eq('id', id);
    expect(error).toBeNull();

    const after = await readSession(id);
    expect(after.lifecycle).toBe('running');
    expect(after.metadata).not.toHaveProperty('interruptedAt');
    expect(after.metadata).not.toHaveProperty('interruptedReason');
    // Only the breadcrumbs are stripped — nothing else is touched.
    expect(after.metadata.taskDescription).toBe('review pr:558');
  });

  it('a non-resume write leaves the breadcrumbs alone', async () => {
    const id = await insertSession({
      lifecycle: 'interrupted',
      metadata: { interruptedAt: '2026-09-01T14:49:32.000Z', interruptedReason: 'server-shutdown' },
    });

    // Bookkeeping while still interrupted (phase update, alias, whatever) —
    // the interruption record must survive anything that is not a resume.
    const { error } = await client
      .from('sessions')
      .update({
        metadata: {
          interruptedAt: '2026-09-01T14:49:32.000Z',
          interruptedReason: 'server-shutdown',
          currentPhase: 'waiting:review',
        },
      } as never)
      .eq('id', id);
    expect(error).toBeNull();

    const after = await readSession(id);
    expect(after.metadata.interruptedAt).toBe('2026-09-01T14:49:32.000Z');
    expect(after.metadata.interruptedReason).toBe('server-shutdown');
  });

  it('an insert born running cannot carry breadcrumbs either', async () => {
    const id = await insertSession({
      lifecycle: 'running',
      metadata: { interruptedAt: '2026-09-01T14:49:32.000Z', interruptedReason: 'server-shutdown' },
    });

    const after = await readSession(id);
    expect(after.metadata).not.toHaveProperty('interruptedAt');
    expect(after.metadata).not.toHaveProperty('interruptedReason');
  });
});
