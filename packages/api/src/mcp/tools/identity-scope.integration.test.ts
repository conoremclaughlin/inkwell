/**
 * save_identity keeps one row per SB — real database (Sep 10 incident shape).
 *
 * The unit suite proves the sequencing against mocks; this proves the thing a
 * mock cannot: that a save with NO workspaceId updates the SB's existing
 * workspace-scoped row (with and without a header-derived request scope) and
 * never inserts an unscoped twin, and that the read path then resolves it.
 * Requires a LOCAL Supabase in .env.local; skipped otherwise. Suite-owned
 * rows are deleted in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { getDataComposer, type DataComposer } from '../../data/composer';
import {
  ensureEchoIntegrationFixture,
  INTEGRATION_TEST_USER_ID,
} from '../../test/integration-fixtures';
import { runWithRequestContext } from '../../utils/request-context';
import { handleSaveIdentity, handleGetIdentity } from './identity-handlers';

const projectRoot = resolve(__dirname, '../../../../../');
const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  const parsed = dotenv.parse(readFileSync(envLocalPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
}
const canRun = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);

describe.skipIf(!canRun)('save_identity keeps one row per SB (real database)', () => {
  let dataComposer: DataComposer;
  let workspaceId: string;
  const sbSlug = `scope-test-${randomUUID().slice(0, 8)}`;

  const rowsFor = async () => {
    const { data, error } = await dataComposer
      .getClient()
      .from('agent_identities')
      .select('id, workspace_id, version, soul')
      .eq('user_id', INTEGRATION_TEST_USER_ID)
      .eq('agent_id', sbSlug);
    if (error) throw new Error(error.message);
    return data ?? [];
  };

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    await ensureEchoIntegrationFixture(dataComposer);
    const ws = await dataComposer
      .getClient()
      .from('workspaces')
      .insert({
        user_id: INTEGRATION_TEST_USER_ID,
        name: `scope-test ${sbSlug}`,
        slug: `scope-test-${sbSlug}`,
      })
      .select('id')
      .single();
    if (ws.error) throw new Error(`workspace fixture: ${ws.error.message}`);
    workspaceId = ws.data.id;
    const seeded = await dataComposer.getClient().from('agent_identities').insert({
      user_id: INTEGRATION_TEST_USER_ID,
      agent_id: sbSlug,
      workspace_id: workspaceId,
      name: 'Scope Test',
      role: 'fixture',
      soul: 'v1',
    });
    if (seeded.error) throw new Error(`identity fixture: ${seeded.error.message}`);
  });

  afterAll(async () => {
    const supabase = dataComposer.getClient();
    await supabase
      .from('agent_identities')
      .delete()
      .eq('user_id', INTEGRATION_TEST_USER_ID)
      .eq('agent_id', sbSlug);
    await supabase.from('workspaces').delete().eq('id', workspaceId);
  });

  it('no workspaceId, no request scope: updates the scoped row — no twin', async () => {
    const result = await handleSaveIdentity(
      {
        userId: INTEGRATION_TEST_USER_ID,
        sbSlug,
        name: 'Scope Test',
        role: 'fixture',
        soul: 'v2',
      },
      dataComposer
    );
    expect(JSON.parse(result.content[0].text).success).toBe(true);
    const rows = await rowsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe(workspaceId);
    expect(rows[0].soul).toBe('v2');
    expect(rows[0].version).toBe(2);
  });

  it('with a header-derived request scope: still the same single row', async () => {
    const result = await runWithRequestContext(
      { workspaceId, workspaceSource: 'header' } as never,
      () =>
        handleSaveIdentity(
          {
            userId: INTEGRATION_TEST_USER_ID,
            sbSlug,
            name: 'Scope Test',
            role: 'fixture',
            soul: 'v3',
          },
          dataComposer
        )
    );
    expect(JSON.parse(result.content[0].text).success).toBe(true);
    const rows = await rowsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0].soul).toBe('v3');
    expect(rows[0].version).toBe(3);
  });

  it('get_identity resolves with no workspaceId — the read that reported "not found" on Sep 10', async () => {
    const result = await handleGetIdentity(
      { userId: INTEGRATION_TEST_USER_ID, sbSlug, file: 'identity' },
      dataComposer
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.version).toBe(3);
  });
});
