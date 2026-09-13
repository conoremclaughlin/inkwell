import type { DataComposer } from '../data/composer';

export const INTEGRATION_TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
export const INTEGRATION_TEST_USER_EMAIL = 'integration-test@example.com';
export const INTEGRATION_TEST_AGENT_ID = 'echo';

export interface EchoIntegrationFixture {
  userId: string;
  email: string;
  /** The fixture user's personal workspace — where `echo` lives and threads land. */
  workspaceId: string;
  /** agent_identities.id of `echo` in that workspace. */
  echoSbId: string;
}

/**
 * Ensures the canonical integration-test user, their personal workspace, and
 * the `echo` identity IN that workspace exist. This keeps integration tests
 * deterministic even when seed state differs.
 *
 * Since the thread-scope cutover (spec inkmail-thread-scope §1, §3) threads
 * are workspace rows and every thread principal is an identity in exactly
 * one workspace, so a workspace-less `echo` cannot take part in a thread.
 * The database provisions the personal workspace on user insert; a legacy
 * workspace-less `echo` row is adopted into it rather than duplicated.
 */
export async function ensureEchoIntegrationFixture(
  dataComposer: DataComposer
): Promise<EchoIntegrationFixture> {
  const supabase = dataComposer.getClient();

  const { data: existingUser, error: userLookupError } = await supabase
    .from('users')
    .select('id, email')
    .eq('id', INTEGRATION_TEST_USER_ID)
    .maybeSingle();

  if (userLookupError) {
    throw new Error(`Failed to query integration test user: ${userLookupError.message}`);
  }

  if (!existingUser) {
    const { error: insertUserError } = await supabase.from('users').insert({
      id: INTEGRATION_TEST_USER_ID,
      email: INTEGRATION_TEST_USER_EMAIL,
      username: 'integration-test-user',
      first_name: 'Integration',
      last_name: 'Test',
      timezone: 'UTC',
      preferences: {},
    });

    if (insertUserError) {
      throw new Error(`Failed to create integration test user: ${insertUserError.message}`);
    }
  }

  // Personal workspace: provisioned by the users AFTER INSERT trigger; the
  // fallback covers a database whose fixture user predates that trigger.
  const { data: personal, error: workspaceLookupError } = await supabase
    .from('workspaces')
    .select('id')
    .eq('user_id', INTEGRATION_TEST_USER_ID)
    .eq('type', 'personal')
    .eq('slug', 'personal')
    .is('archived_at', null)
    .maybeSingle();
  if (workspaceLookupError) {
    throw new Error(
      `Failed to query the fixture personal workspace: ${workspaceLookupError.message}`
    );
  }
  let workspaceId = personal?.id as string | undefined;
  if (!workspaceId) {
    const { data: created, error: createWorkspaceError } = await supabase
      .from('workspaces')
      .insert({
        user_id: INTEGRATION_TEST_USER_ID,
        name: 'Personal',
        slug: 'personal',
        type: 'personal',
      })
      .select('id')
      .single();
    if (createWorkspaceError || !created) {
      throw new Error(
        `Failed to create the fixture personal workspace: ${createWorkspaceError?.message}`
      );
    }
    workspaceId = created.id as string;
    const { error: memberError } = await supabase
      .from('workspace_members')
      .upsert(
        { workspace_id: workspaceId, user_id: INTEGRATION_TEST_USER_ID, role: 'owner' },
        { onConflict: 'workspace_id,user_id' }
      );
    if (memberError) {
      throw new Error(`Failed to add the fixture user to their workspace: ${memberError.message}`);
    }
  }

  const { data: existingEchoIdentity, error: identityLookupError } = await supabase
    .from('agent_identities')
    .select('id')
    .eq('user_id', INTEGRATION_TEST_USER_ID)
    .eq('agent_id', INTEGRATION_TEST_AGENT_ID)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (identityLookupError) {
    throw new Error(
      `Failed to query integration fixture agent identity: ${identityLookupError.message}`
    );
  }

  let echoSbId = existingEchoIdentity?.id as string | undefined;
  if (!echoSbId) {
    // A legacy workspace-less echo (pre-cutover seed) is adopted into the
    // personal workspace rather than duplicated.
    const { data: orphan } = await supabase
      .from('agent_identities')
      .select('id')
      .eq('user_id', INTEGRATION_TEST_USER_ID)
      .eq('agent_id', INTEGRATION_TEST_AGENT_ID)
      .is('workspace_id', null)
      .maybeSingle();
    if (orphan?.id) {
      const { error: adoptError } = await supabase
        .from('agent_identities')
        .update({ workspace_id: workspaceId })
        .eq('id', orphan.id);
      if (adoptError) {
        throw new Error(
          `Failed to place the fixture identity in its workspace: ${adoptError.message}`
        );
      }
      echoSbId = orphan.id as string;
    }
  }
  if (!echoSbId) {
    const { data: inserted, error: insertIdentityError } = await supabase
      .from('agent_identities')
      .insert({
        user_id: INTEGRATION_TEST_USER_ID,
        workspace_id: workspaceId,
        agent_id: INTEGRATION_TEST_AGENT_ID,
        name: 'Echo',
        role: 'Integration test fixture agent',
        description: 'Fixture identity used by integration tests',
        values: [],
        relationships: {},
        capabilities: [],
        metadata: { fixture: true },
        backend: 'claude',
      })
      .select('id')
      .single();

    if (insertIdentityError || !inserted) {
      throw new Error(
        `Failed to create integration fixture agent identity: ${insertIdentityError?.message}`
      );
    }
    echoSbId = inserted.id as string;
  }

  return {
    userId: INTEGRATION_TEST_USER_ID,
    email: existingUser?.email || INTEGRATION_TEST_USER_EMAIL,
    workspaceId,
    echoSbId,
  };
}

/**
 * A suite-owned SB identity in the fixture workspace, for suites that
 * address more than `echo`. Returns the identity id; the caller deletes it in
 * afterAll (after its participant rows — the participant FK is deferred).
 */
export async function ensureSuiteIdentity(
  dataComposer: DataComposer,
  fixture: EchoIntegrationFixture,
  agentId: string
): Promise<string> {
  const supabase = dataComposer.getClient();
  const { data: existing } = await supabase
    .from('agent_identities')
    .select('id')
    .eq('user_id', fixture.userId)
    .eq('agent_id', agentId)
    .eq('workspace_id', fixture.workspaceId)
    .maybeSingle();
  if (existing?.id) return existing.id as string;
  const { data, error } = await supabase
    .from('agent_identities')
    .insert({
      user_id: fixture.userId,
      workspace_id: fixture.workspaceId,
      agent_id: agentId,
      name: agentId,
      role: 'Integration suite identity',
      metadata: { fixture: true, suite: true },
      backend: 'claude',
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Failed to create suite identity ${agentId}: ${error?.message}`);
  }
  return data.id as string;
}
