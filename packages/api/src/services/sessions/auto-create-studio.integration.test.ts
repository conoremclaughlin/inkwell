/**
 * Auto-Create Main Studio Integration Tests
 *
 * Tests that start_session with studioId="main" + repoRoot auto-creates
 * a studio row and writes a real UUID to the session's studio_id.
 * Simulates the hook→start_session flow against the real database.
 *
 * Requires: running PCP server (default http://localhost:3001)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { handleStartSession, startSessionSchema } from '../../mcp/tools/memory-handlers';
import {
  ensureEchoIntegrationFixture,
  INTEGRATION_TEST_USER_ID,
  INTEGRATION_TEST_AGENT_ID,
  INTEGRATION_TEST_USER_EMAIL,
} from '../../test/integration-fixtures';

const TEST_REPO_ROOT = `/tmp/pcp-test-repo-${Date.now()}`;

describe('Auto-Create Main Studio Integration', () => {
  let dataComposer: DataComposer;
  const createdSessionIds: string[] = [];
  const createdStudioIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    await ensureEchoIntegrationFixture(dataComposer);
  });

  afterAll(async () => {
    const supabase = dataComposer.getClient();

    if (createdSessionIds.length > 0) {
      await supabase
        .from('sessions')
        .update({ ended_at: new Date().toISOString() })
        .in('id', createdSessionIds);
    }

    if (createdStudioIds.length > 0) {
      await supabase.from('studios').delete().in('id', createdStudioIds);
    }
  });

  it('auto-creates a studio row when studioId="main" and repoRoot is provided', async () => {
    const result = await handleStartSession(
      {
        email: INTEGRATION_TEST_USER_EMAIL,
        agentId: INTEGRATION_TEST_AGENT_ID,
        studioId: 'main',
        repoRoot: TEST_REPO_ROOT,
      },
      dataComposer
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);

    const sessionId = parsed.session.id;
    createdSessionIds.push(sessionId);

    // The session should have a real UUID studio_id, not NULL
    const studioId = parsed.session.studioId;
    expect(studioId).toBeTruthy();
    expect(studioId).not.toBe('main');
    // UUID format check
    expect(studioId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    createdStudioIds.push(studioId);

    // Verify the studio row exists in the database
    const { data: studio } = await dataComposer
      .getClient()
      .from('studios')
      .select('id, repo_root, worktree_path, agent_id, slug, status, metadata')
      .eq('id', studioId)
      .single();

    expect(studio).not.toBeNull();
    expect(studio!.repo_root).toBe(TEST_REPO_ROOT);
    expect(studio!.worktree_path).toBe(TEST_REPO_ROOT);
    expect(studio!.agent_id).toBe(INTEGRATION_TEST_AGENT_ID);
    expect(studio!.status).toBe('active');
    expect((studio!.metadata as Record<string, unknown>)?.autoCreated).toBe(true);
  });

  it('reuses existing studio on second start_session call (idempotent)', async () => {
    // Call start_session again with the same repoRoot
    const result = await handleStartSession(
      {
        email: INTEGRATION_TEST_USER_EMAIL,
        agentId: INTEGRATION_TEST_AGENT_ID,
        studioId: 'main',
        repoRoot: TEST_REPO_ROOT,
      },
      dataComposer
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);

    const sessionId = parsed.session.id;
    if (!createdSessionIds.includes(sessionId)) {
      createdSessionIds.push(sessionId);
    }

    // Should reuse the same studio from the first test
    const studioId = parsed.session.studioId;
    expect(studioId).toBe(createdStudioIds[0]);

    // Verify only one studio row exists for this repo root + agent
    const { data: studios } = await dataComposer
      .getClient()
      .from('studios')
      .select('id')
      .eq('repo_root', TEST_REPO_ROOT)
      .eq('agent_id', INTEGRATION_TEST_AGENT_ID)
      .eq('user_id', INTEGRATION_TEST_USER_ID);

    expect(studios).toHaveLength(1);
  });

  it('falls back to NULL studio when repoRoot is not provided', async () => {
    const result = await handleStartSession(
      {
        email: INTEGRATION_TEST_USER_EMAIL,
        agentId: INTEGRATION_TEST_AGENT_ID,
        studioId: 'main',
        // No repoRoot — can't auto-create
        forceNew: true,
      },
      dataComposer
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);

    const sessionId = parsed.session.id;
    createdSessionIds.push(sessionId);

    // Without repoRoot, studio_id should be null/undefined (legacy behavior)
    expect(parsed.session.studioId).toBeFalsy();
  });

  it('auto-creates separate studios for different repo roots', async () => {
    const otherRepoRoot = `${TEST_REPO_ROOT}-other`;

    const result = await handleStartSession(
      {
        email: INTEGRATION_TEST_USER_EMAIL,
        agentId: INTEGRATION_TEST_AGENT_ID,
        studioId: 'main',
        repoRoot: otherRepoRoot,
        forceNew: true,
      },
      dataComposer
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);

    const sessionId = parsed.session.id;
    createdSessionIds.push(sessionId);

    const studioId = parsed.session.studioId;
    expect(studioId).toBeTruthy();
    // Different repo root should get a different studio row
    expect(studioId).not.toBe(createdStudioIds[0]);
    createdStudioIds.push(studioId);

    // Verify the second studio has the correct repo root
    const { data: studio } = await dataComposer
      .getClient()
      .from('studios')
      .select('repo_root')
      .eq('id', studioId)
      .single();

    expect(studio!.repo_root).toBe(otherRepoRoot);
  });
});
