/**
 * Kindle atomic redemption — Integration Tests (real DB)
 *
 * The atomicity claims live in the redeem_kindle_token Postgres function,
 * which unit mocks cannot see by construction (Lumen #528 r2 P1):
 *   1. a failure AFTER token consumption (identity FK violation) rolls the
 *      whole redemption back — the one-time token survives, no lineage row
 *      is stranded;
 *   2. two concurrent redemptions of one token — exactly one wins.
 *
 * Requires .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY.
 * Skipped automatically when credentials/DB are unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { INTEGRATION_TEST_USER_ID } from '../../test/integration-fixtures';

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
const available = !!(SUPABASE_URL && SUPABASE_KEY);

const USER = INTEGRATION_TEST_USER_ID;

describe.skipIf(!available)('redeem_kindle_token atomicity (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: SupabaseClient<any>;
  let workspaceId: string;
  const tokens: string[] = [];
  const lineageIds: string[] = [];

  beforeAll(async () => {
    client = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: ws, error } = await client
      .from('workspaces')
      .insert({
        user_id: USER,
        name: 'kindle-it-ws',
        slug: `kindle-it-${randomUUID().slice(0, 8)}`,
      })
      .select('id')
      .single();
    if (error) throw new Error(`workspace fixture failed: ${error.message}`);
    workspaceId = ws!.id;
  });

  afterAll(async () => {
    // Identities first (FK cascade would get them via workspace, but be explicit).
    await client.from('agent_identities').delete().eq('workspace_id', workspaceId);
    for (const id of lineageIds) await client.from('kindle_lineage').delete().eq('id', id);
    for (const t of tokens) await client.from('kindle_tokens').delete().eq('token', t);
    await client.from('workspaces').delete().eq('id', workspaceId);
  });

  async function makeToken(): Promise<{ token: string; id: string }> {
    const token = `it-${randomUUID().replace(/-/g, '')}`;
    tokens.push(token);
    const { data, error } = await client
      .from('kindle_tokens')
      .insert({ token, creator_user_id: USER, creator_agent_id: 'wren', value_seed: {} })
      .select('id')
      .single();
    if (error) throw new Error(`token fixture failed: ${error.message}`);
    return { token, id: data!.id };
  }

  const IDENTITY = {
    name: 'New SB',
    role: 'Nascent SB in onboarding',
    description: 'integration fixture',
    soul: '# soul',
    values: ['growth'],
    metadata: {},
  };

  function redeem(token: string, workspace: string) {
    return client.rpc('redeem_kindle_token', {
      p_token: token,
      p_new_user_id: USER,
      p_workspace_id: workspace,
      p_identity: IDENTITY,
    });
  }

  it('redeems atomically: token consumed, lineage + workspace-scoped identity created', async () => {
    const { token, id } = await makeToken();

    const { data: lineage, error } = await redeem(token, workspaceId);
    expect(error).toBeNull();
    expect(lineage).toBeTruthy();
    lineageIds.push((lineage as { id: string }).id);

    const { data: tokenRow } = await client
      .from('kindle_tokens')
      .select('status, used_by_user_id')
      .eq('token', token)
      .single();
    expect(tokenRow).toMatchObject({ status: 'used', used_by_user_id: USER });

    const { data: identity } = await client
      .from('agent_identities')
      .select('workspace_id')
      .eq('user_id', USER)
      .eq('agent_id', `kindle-${id}`)
      .single();
    expect(identity).toMatchObject({ workspace_id: workspaceId });
  });

  it('a failure AFTER token consumption rolls the whole redemption back', async () => {
    const { token } = await makeToken();

    // A non-existent workspace violates agent_identities' FK INSIDE the
    // transaction — after the token was conditionally consumed and the
    // lineage row inserted. All of it must come back.
    const { error } = await redeem(token, randomUUID());
    expect(error).toBeTruthy();

    const { data: tokenRow } = await client
      .from('kindle_tokens')
      .select('status, used_by_user_id')
      .eq('token', token)
      .single();
    // The one-time invite SURVIVES the failed redemption.
    expect(tokenRow).toMatchObject({ status: 'active', used_by_user_id: null });

    const { data: lineageRows } = await client
      .from('kindle_lineage')
      .select('id')
      .eq('child_user_id', USER)
      .like('child_agent_id', 'kindle-%')
      .gte('created_at', new Date(Date.now() - 60_000).toISOString());
    // No stranded lineage from THIS failed redemption: every recent row must
    // belong to a SUCCESSFUL redemption tracked by this suite.
    for (const row of lineageRows ?? []) {
      expect(lineageIds).toContain(row.id);
    }
  });

  it('a token row self-generates its token (original server default restored)', async () => {
    // Every production create-token call omits `token` and relies on the
    // original DEFAULT encode(gen_random_bytes(16),'hex') — its loss made
    // REST/MCP token creation fail unconditionally (Lumen #528 r3 P1-1).
    const { data, error } = await client
      .from('kindle_tokens')
      .insert({ creator_user_id: USER, creator_agent_id: 'wren' })
      .select('token, expires_at')
      .single();
    expect(error).toBeNull();
    expect(data!.token).toMatch(/^[0-9a-f]{32}$/);
    // The 7-day expiry default is back too.
    expect(new Date(data!.expires_at).getTime()).toBeGreaterThan(Date.now());
    tokens.push(data!.token);
  });

  it('completion is atomic and bound to the identity UUID', async () => {
    const { token, id } = await makeToken();
    const { data: lineage } = await redeem(token, workspaceId);
    const lineageId = (lineage as { id: string; child_sb_id: string }).id;
    lineageIds.push(lineageId);
    // Redemption bound the identity UUID (AGENTS.md: programmatic refs use
    // agent_identities.id, never the slug).
    expect((lineage as { child_sb_id: string }).child_sb_id).toBeTruthy();

    const chosen = `it-nova-${id.slice(0, 8)}`;
    const { data: completed, error } = await client.rpc('complete_kindle_onboarding', {
      p_kindle_id: lineageId,
      p_user_id: USER,
      p_chosen_name: chosen,
      p_final_agent_id: chosen,
      p_soul: '# final soul',
    });
    expect(error).toBeNull();
    expect(completed).toMatchObject({ onboarding_status: 'complete', child_agent_id: chosen });

    const { data: identity } = await client
      .from('agent_identities')
      .select('agent_id, name')
      .eq('id', (lineage as { child_sb_id: string }).child_sb_id)
      .single();
    expect(identity).toMatchObject({ agent_id: chosen, name: chosen });
  });

  it('a rename collision rolls back the WHOLE completion — no half-completed onboarding', async () => {
    const { token, id } = await makeToken();
    const { data: lineage } = await redeem(token, workspaceId);
    const lineageId = (lineage as { id: string }).id;
    lineageIds.push(lineageId);

    // Occupy the final slug in the same workspace so the rename collides.
    const taken = `it-taken-${id.slice(0, 8)}`;
    const { error: fixtureErr } = await client
      .from('agent_identities')
      .insert({
        user_id: USER,
        workspace_id: workspaceId,
        agent_id: taken,
        name: taken,
        role: 'fixture',
      });
    expect(fixtureErr).toBeNull();

    const { error } = await client.rpc('complete_kindle_onboarding', {
      p_kindle_id: lineageId,
      p_user_id: USER,
      p_chosen_name: taken,
      p_final_agent_id: taken,
      p_soul: null,
    });
    expect(error).toBeTruthy();

    // The rename rolled back WITH the lineage write: status untouched, and
    // the onboarding identity still carries its temp slug — retry works.
    const { data: after } = await client
      .from('kindle_lineage')
      .select('onboarding_status, child_agent_id')
      .eq('id', lineageId)
      .single();
    expect(after).toMatchObject({
      onboarding_status: 'values_interview',
      child_agent_id: `kindle-${id}`,
    });
  });

  it('another user cannot read or complete the lineage', async () => {
    const { token } = await makeToken();
    const { data: lineage } = await redeem(token, workspaceId);
    const lineageId = (lineage as { id: string }).id;
    lineageIds.push(lineageId);

    const { error } = await client.rpc('complete_kindle_onboarding', {
      p_kindle_id: lineageId,
      p_user_id: randomUUID(),
      p_chosen_name: 'thief',
      p_final_agent_id: 'thief',
      p_soul: null,
    });
    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/not found for this user/);
  });

  it('two concurrent redemptions of one token — exactly one wins', async () => {
    const { token } = await makeToken();

    const [a, b] = await Promise.all([redeem(token, workspaceId), redeem(token, workspaceId)]);
    const outcomes = [a, b];
    const wins = outcomes.filter((r) => !r.error);
    const losses = outcomes.filter((r) => r.error);

    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0].error!.message).toMatch(/not redeemable/);
    lineageIds.push((wins[0].data as { id: string }).id);

    // Exactly one lineage row exists for this token's temp agent.
    const { data: tokenRow } = await client
      .from('kindle_tokens')
      .select('id, status')
      .eq('token', token)
      .single();
    expect(tokenRow!.status).toBe('used');
    const { data: rows } = await client
      .from('kindle_lineage')
      .select('id')
      .eq('child_agent_id', `kindle-${tokenRow!.id}`);
    expect(rows).toHaveLength(1);
  });
});
