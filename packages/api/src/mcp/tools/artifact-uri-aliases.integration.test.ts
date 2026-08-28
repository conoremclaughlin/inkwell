/**
 * Artifact URI aliases — real-database round trips (spec:library).
 *
 * The unit suite proves the handler logic against mocks; this suite proves the
 * parts a mock cannot: the migration's integrity triggers (advisory-locked,
 * both directions, owner-bound) and the full rename → alias → resolve loop
 * through the real handlers with a real workspace scope.
 *
 * Requires .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY; skipped when
 * unavailable. All suite-owned rows are deleted in afterAll.
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
import { handleCreateArtifact, handleGetArtifact, handleUpdateArtifact } from './artifact-handlers';

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
const canRun = !!SUPABASE_URL && !!SUPABASE_KEY;

const RUN_ID = randomUUID().slice(0, 8);
const NS = `libtest-${RUN_ID}`;
const URI_BORN = `ink://${NS}/renamable`;
const URI_MOVED = `ink://${NS}/renamed-home`;

describe.skipIf(!canRun)('artifact URI aliases (DB integration)', () => {
  let client: ReturnType<DataComposer['getClient']>;
  let dataComposer: DataComposer;
  let workspaceId: string;
  let artifactId: string;

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    client = dataComposer.getClient();
    await ensureEchoIntegrationFixture(dataComposer);

    const { data: workspace, error } = await client
      .from('workspaces')
      .insert({
        user_id: INTEGRATION_TEST_USER_ID,
        name: `Library integration ${RUN_ID}`,
        slug: `library-it-${RUN_ID}`,
      })
      .select('id')
      .single();
    if (error) throw new Error(`workspace fixture failed: ${error.message}`);
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    if (!client) return;
    // Aliases and artifacts cascade with the workspace, but delete explicitly
    // so a mid-suite failure still leaves nothing behind.
    await client.from('artifact_uri_aliases').delete().like('alias_uri', `ink://${NS}/%`);
    await client.from('artifacts').delete().like('uri', `ink://${NS}/%`);
    if (workspaceId) await client.from('workspaces').delete().eq('id', workspaceId);
  });

  it('create → rename → the old URI resolves via alias with the canonical URI reported', async () => {
    const created = JSON.parse(
      (
        await handleCreateArtifact(
          {
            userId: INTEGRATION_TEST_USER_ID,
            workspaceId,
            uri: URI_BORN,
            title: 'Renamable',
            content: '# body',
            artifactType: 'note',
            agentId: 'echo',
          },
          dataComposer
        )
      ).content[0].text
    );
    expect(created.success).toBe(true);
    artifactId = created.artifact.id;

    const renamed = JSON.parse(
      (
        await handleUpdateArtifact(
          {
            userId: INTEGRATION_TEST_USER_ID,
            workspaceId,
            uri: URI_BORN,
            newUri: URI_MOVED,
            changeSummary: 'moved for the integration suite',
            agentId: 'echo',
          },
          dataComposer
        )
      ).content[0].text
    );
    expect(renamed.success).toBe(true);
    expect(renamed.renamedFrom).toBe(URI_BORN);
    expect(renamed.artifact.uri).toBe(URI_MOVED);

    // The alias row exists and inherited the target's workspace via trigger.
    const { data: alias } = await client
      .from('artifact_uri_aliases')
      .select('artifact_id, workspace_id')
      .eq('alias_uri', URI_BORN)
      .single();
    expect(alias?.artifact_id).toBe(artifactId);
    expect(alias?.workspace_id).toBe(workspaceId);

    // Old URI still reads, and tells the reader where the artifact lives now.
    const fetched = JSON.parse(
      (
        await handleGetArtifact(
          { userId: INTEGRATION_TEST_USER_ID, workspaceId, uri: URI_BORN },
          dataComposer
        )
      ).content[0].text
    );
    expect(fetched.success).toBe(true);
    expect(fetched.resolvedViaAlias).toBe(URI_BORN);
    expect(fetched.canonicalUri).toBe(URI_MOVED);

    // Version history recorded the rename.
    const { data: history } = await client
      .from('artifact_history')
      .select('change_summary')
      .eq('artifact_id', artifactId)
      .order('version', { ascending: false })
      .limit(1);
    expect(history?.[0]?.change_summary).toContain(`Renamed ${URI_BORN}`);
  });

  it('trigger: an alias may not shadow a live URI', async () => {
    const { error } = await client.from('artifact_uri_aliases').insert({
      user_id: INTEGRATION_TEST_USER_ID,
      artifact_id: artifactId,
      alias_uri: URI_MOVED, // currently the live canonical URI
    });
    expect(error?.message).toMatch(/collides with a live artifact URI/);
  });

  it('trigger + handler: a left-behind URI is reserved against new artifacts', async () => {
    // Handler-level friendly refusal
    await expect(
      handleCreateArtifact(
        {
          userId: INTEGRATION_TEST_USER_ID,
          workspaceId,
          uri: URI_BORN,
          title: 'Squatter',
          content: 'X',
          agentId: 'echo',
        },
        dataComposer
      )
    ).rejects.toThrow(/alias of an existing artifact/);

    // Raw insert hits the trigger backstop
    const { error } = await client.from('artifacts').insert({
      user_id: INTEGRATION_TEST_USER_ID,
      workspace_id: workspaceId,
      uri: URI_BORN,
      title: 'Squatter',
      content: 'X',
      artifact_type: 'note',
      version: 1,
    });
    expect(error?.message).toMatch(/collides with another artifact's alias/);
  });

  it('trigger: aliases are owner-bound to their target artifact', async () => {
    const strangerId = randomUUID();
    const { error: userError } = await client.from('users').insert({
      id: strangerId,
      email: `stranger-${RUN_ID}@example.com`,
      username: `stranger-${RUN_ID}`,
      timezone: 'UTC',
      preferences: {},
    });
    expect(userError).toBeNull();

    try {
      const { error } = await client.from('artifact_uri_aliases').insert({
        user_id: strangerId,
        artifact_id: artifactId,
        alias_uri: `ink://${NS}/stolen`,
      });
      expect(error?.message).toMatch(/does not match the target artifact/);
    } finally {
      await client.from('users').delete().eq('id', strangerId);
    }
  });

  it('trigger: an alias must point at an artifact that exists', async () => {
    const { error } = await client.from('artifact_uri_aliases').insert({
      user_id: INTEGRATION_TEST_USER_ID,
      artifact_id: randomUUID(),
      alias_uri: `ink://${NS}/dangling`,
    });
    expect(error?.message).toMatch(/does not exist/);
  });

  it('renaming back to the former URI deletes the redundant alias and re-aliases the other', async () => {
    const renamedBack = JSON.parse(
      (
        await handleUpdateArtifact(
          {
            userId: INTEGRATION_TEST_USER_ID,
            workspaceId,
            uri: URI_MOVED,
            newUri: URI_BORN,
            agentId: 'echo',
          },
          dataComposer
        )
      ).content[0].text
    );
    expect(renamedBack.success).toBe(true);
    expect(renamedBack.artifact.uri).toBe(URI_BORN);

    const { data: aliases } = await client
      .from('artifact_uri_aliases')
      .select('alias_uri')
      .eq('artifact_id', artifactId);
    const aliasUris = (aliases || []).map((a) => a.alias_uri);
    expect(aliasUris).toContain(URI_MOVED);
    expect(aliasUris).not.toContain(URI_BORN);
  });
});
