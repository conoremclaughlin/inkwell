/**
 * Bootstrap hands an identity the shared documents of its own workspace
 * (real Supabase).
 *
 * Bootstrap used to read values, process and the person's page from the
 * person's oldest personal workspace whatever workspace the identity lived
 * in, while context-builder read the identity's own. So an identity placed
 * in a second workspace of its own was still handed the first one's process.
 * These seed a second workspace for the suite's person, with an identity in
 * it, and read what bootstrap gives that identity and the suite's echo, which
 * lives in the personal workspace.
 *
 * Focus is the other per-person document bootstrap carried across: it points
 * at a project, and a project belongs to one workspace.
 *
 * Run via: yarn workspace @inklabs/api test:integration:db
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import {
  ensureEchoIntegrationFixture,
  type EchoIntegrationFixture,
} from '../../test/integration-fixtures';
import { clearPinnedAgent, runWithRequestContext } from '../../utils/request-context';
import { handleBootstrap } from './memory-handlers';

interface BootstrapView {
  identityFiles: { values: string | null; process: string | null; user: string | null } | null;
  activeContext: {
    projects: Array<{ id: string }>;
    focus: { projectId: string | null; summary: string } | null;
  };
}

function parse(raw: { content: Array<{ text: string }> }): BootstrapView {
  return JSON.parse(raw.content[0].text) as BootstrapView;
}

describe('Bootstrap constitution scope (integration)', () => {
  let dataComposer: DataComposer;
  let fixture: EchoIntegrationFixture;
  let echoSbId: string;
  // An empty identity base path, so no ~/.ink file on the machine running the
  // suite can stand in for a document the database does not hold.
  let emptyBasePath: string;

  const suffix = randomUUID().slice(0, 8);
  const spaceSlug = `constitution-scope-${suffix}`;
  const spaceSbSlug = `scope-${suffix}`;
  let spaceId: string;
  let spaceSbId: string;
  let projectId: string;
  let focusId: string | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = () => dataComposer.getClient() as any;

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    fixture = await ensureEchoIntegrationFixture(dataComposer);
    emptyBasePath = await mkdtemp(path.join(os.tmpdir(), 'bootstrap-scope-'));

    const { data: echo, error: echoError } = await db()
      .from('agent_identities')
      .select('id')
      .eq('user_id', fixture.userId)
      .eq('agent_id', 'echo')
      .eq('workspace_id', fixture.workspaceId)
      .single();
    if (echoError || !echo) throw new Error(`echo identity: ${echoError?.message}`);
    echoSbId = echo.id;

    // Created now, so the personal workspace stays the person's oldest.
    const { data: space, error: spaceError } = await db()
      .from('workspaces')
      .insert({
        user_id: fixture.userId,
        name: 'Constitution scope space',
        slug: spaceSlug,
        type: 'personal',
        shared_values: `SPACE-VALUES-${suffix}`,
        process: null,
      })
      .select('id')
      .single();
    if (spaceError || !space) throw new Error(`space insert: ${spaceError?.message}`);
    spaceId = space.id;
    await db()
      .from('workspace_members')
      .insert({ workspace_id: spaceId, user_id: fixture.userId, role: 'owner' });
    await db()
      .from('user_identity')
      .insert({
        user_id: fixture.userId,
        workspace_id: spaceId,
        user_profile_md: `SPACE-ABOUT-${suffix}`,
      });

    const { data: sb, error: sbError } = await db()
      .from('agent_identities')
      .insert({
        user_id: fixture.userId,
        workspace_id: spaceId,
        agent_id: spaceSbSlug,
        name: spaceSbSlug,
        role: 'Integration suite identity',
        metadata: { fixture: true, suite: true },
        backend: 'claude',
      })
      .select('id')
      .single();
    if (sbError || !sb) throw new Error(`space identity insert: ${sbError?.message}`);
    spaceSbId = sb.id;

    const { data: project, error: projectError } = await db()
      .from('projects')
      .insert({
        user_id: fixture.userId,
        workspace_id: fixture.workspaceId,
        name: `Constitution scope project ${suffix}`,
        status: 'active',
      })
      .select('id')
      .single();
    if (projectError || !project) throw new Error(`project insert: ${projectError?.message}`);
    projectId = project.id;
  });

  afterEach(async () => {
    clearPinnedAgent();
    if (focusId) {
      await db().from('session_focus').delete().eq('id', focusId);
      focusId = null;
    }
  });

  afterAll(async () => {
    await db().from('agent_identities').delete().eq('id', spaceSbId);
    await db().from('user_identity').delete().eq('workspace_id', spaceId);
    await db().from('workspace_members').delete().eq('workspace_id', spaceId);
    await db().from('workspaces').delete().eq('id', spaceId);
    await db().from('projects').delete().eq('id', projectId);
    await rm(emptyBasePath, { recursive: true, force: true });
  });

  /** Bootstrap as a server-spawned turn: the token names the identity. */
  async function bootstrapAs(sbSlug: string, sbId: string): Promise<BootstrapView> {
    return parse(
      await runWithRequestContext({ userId: fixture.userId, sbSlug, sbId }, () =>
        handleBootstrap(
          {
            userId: fixture.userId,
            sbSlug,
            includeRecentMemories: false,
            identityBasePath: emptyBasePath,
          },
          dataComposer
        )
      )
    );
  }

  async function personalDocs(): Promise<{ values: string | null; process: string | null }> {
    const { data } = await db()
      .from('workspaces')
      .select('shared_values, process')
      .eq('id', fixture.workspaceId)
      .single();
    return { values: data?.shared_values ?? null, process: data?.process ?? null };
  }

  it("gives an identity in a second workspace that workspace's values, no process, and its own page", async () => {
    const view = await bootstrapAs(spaceSbSlug, spaceSbId);

    expect(view.identityFiles?.values).toBe(`SPACE-VALUES-${suffix}`);
    expect(view.identityFiles?.process ?? null).toBeNull();
    expect(view.identityFiles?.user).toBe(`SPACE-ABOUT-${suffix}`);
  });

  it('still gives an identity in the oldest personal workspace that workspace’s documents', async () => {
    const view = await bootstrapAs('echo', echoSbId);
    const expected = await personalDocs();

    expect(view.identityFiles?.values ?? null).toBe(expected.values);
    expect(view.identityFiles?.process ?? null).toBe(expected.process);
    expect(view.identityFiles?.user ?? null).not.toBe(`SPACE-ABOUT-${suffix}`);
  });

  it("shows the person's focus only in the workspace its project belongs to", async () => {
    const { data: focus, error } = await db()
      .from('session_focus')
      .insert({
        user_id: fixture.userId,
        project_id: projectId,
        focus_summary: `FOCUS-${suffix}`,
        updated_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .select('id')
      .single();
    if (error || !focus) throw new Error(`focus insert: ${error?.message}`);
    focusId = focus.id;

    const inPersonal = await bootstrapAs('echo', echoSbId);
    expect(inPersonal.activeContext.focus?.summary).toBe(`FOCUS-${suffix}`);

    const inSpace = await bootstrapAs(spaceSbSlug, spaceSbId);
    expect(inSpace.activeContext.focus).toBeNull();
    expect(inSpace.activeContext.projects).toEqual([]);
  });
});
