/**
 * Project-pinned routing against a real database (task b5c71bc3).
 *
 * The unit suite pins the decision logic with recorded query chains; this
 * file proves the two things a chain cannot: that the database pins
 * `key_project` on the thread row the routing reads (thread-key-grammar v4,
 * `pin_thread_key_before_insert`), and that the real query shapes — the
 * project by (workspace_id, slug), the recipient's non-ephemeral studio by
 * (identity, repo_root) — answer against live rows.
 *
 * Plan-only resolution: nothing is provisioned, no lease is acquired, and the
 * session repository is a double, so the only rows written are this file's
 * own fixtures, all removed in afterAll.
 *
 * Runs under the DB integration project (isolated stack): yarn test:integration:db
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';
import { SessionService } from './session-service';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('Project-pinned threads route by the project repo (integration)', () => {
  let dataComposer: DataComposer;
  let supabase: any;
  let userId: string;
  let workspaceId: string;
  let echoSbId: string;
  let projectId: string;
  let threadId: string;
  let studioId: string;
  let projectRepoRoot: string;
  let otherRepoRoot: string;
  let otherStudioId: string;

  // A slug is `^[a-z0-9][a-z0-9-]*$`, at most 32 chars, unique per workspace.
  const slug = `pj${Date.now().toString(36)}`;
  const threadKey = `${slug}:pr:1`;

  const repository = {
    create: vi.fn(async (data: Record<string, unknown>) => ({
      id: '00000000-0000-4000-a000-00000000b5c7',
      ...data,
    })),
    update: vi.fn(async (id: string, updates: Record<string, unknown>) => ({ id, ...updates })),
    findById: vi.fn(async () => null),
    findByUserAndAgent: vi.fn(async () => null),
  };

  function service(): SessionService {
    return new SessionService(
      repository as any,
      { buildContext: vi.fn(), buildMinimalContext: vi.fn() } as any,
      {} as any,
      { addEntry: vi.fn() } as any,
      { defaultWorkingDirectory: '/nonexistent', mcpConfigPath: '/nonexistent/.mcp.json' },
      {} as any,
      supabase
    );
  }

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
    workspaceId = fixture.workspaceId;
    echoSbId = fixture.echoSbId;

    projectRepoRoot = await mkdtemp(path.join(tmpdir(), 'project-repo-'));
    otherRepoRoot = await mkdtemp(path.join(tmpdir(), 'other-repo-'));

    // The project exists but has no repo yet — the Inktrade row on 2026-09-24.
    const { data: project, error: projectErr } = await supabase
      .from('projects')
      .insert({ user_id: userId, workspace_id: workspaceId, name: `Project ${slug}`, slug })
      .select('id')
      .single();
    if (projectErr) throw new Error(`project insert failed: ${projectErr.message}`);
    projectId = project.id;

    // The thread is created AFTER the slug is registered, so the database
    // pins it to the project. Nothing here passes key_project: the trigger
    // is the authority, and the assertion below proves it ran.
    const { data: thread, error: threadErr } = await supabase
      .from('inbox_threads')
      .insert({
        thread_key: threadKey,
        workspace_id: workspaceId,
        created_by_kind: 'sb',
        created_by_sb_id: echoSbId,
        title: 'project-pinned routing probe',
      })
      .select('id, key_project, key_type, key_id')
      .single();
    if (threadErr) throw new Error(`thread insert failed: ${threadErr.message}`);
    threadId = thread.id;
    expect(thread.key_project).toBe(slug);
    expect(thread.key_type).toBe('pr');
    expect(thread.key_id).toBe('1');

    // The recipient's ONLY studio lives in another repo — exactly the state
    // that put an inktrade review into an inkwell checkout.
    const { data: other, error: otherErr } = await supabase
      .from('studios')
      .insert({
        user_id: userId,
        agent_id: 'echo',
        sb_id: echoSbId,
        repo_root: otherRepoRoot,
        worktree_path: `${otherRepoRoot}--echo`,
        branch: 'echo/studio/echo',
        base_branch: 'main',
        status: 'active',
        ephemeral: false,
        metadata: { integrationFixture: 'project-repo-routing' },
      })
      .select('id')
      .single();
    if (otherErr) throw new Error(`studio insert failed: ${otherErr.message}`);
    otherStudioId = other.id;
  });

  afterAll(async () => {
    if (studioId) await supabase.from('studios').delete().eq('id', studioId);
    if (otherStudioId) await supabase.from('studios').delete().eq('id', otherStudioId);
    if (threadId) {
      await supabase.from('inbox_thread_participants').delete().eq('thread_id', threadId);
      await supabase.from('inbox_threads').delete().eq('id', threadId);
    }
    if (projectId) await supabase.from('projects').delete().eq('id', projectId);
    await rm(projectRepoRoot, { recursive: true, force: true });
    await rm(otherRepoRoot, { recursive: true, force: true });
  });

  it('holds a thread whose pinned project has no repo_root, naming the project', async () => {
    repository.create.mockClear();
    await expect(
      service().getOrCreateSession(userId, 'echo', {
        threadKey,
        sbId: echoSbId,
        planOnly: true,
      })
    ).rejects.toMatchObject({
      code: 'ROUTING_REFUSED',
      threadKey,
      detail: { reason: 'project-without-repo', project: { slug, cause: 'unset' } },
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('routes to the recipient studio in the project repo once repo_root is set', async () => {
    const { error: setErr } = await supabase
      .from('projects')
      .update({ repo_root: projectRepoRoot })
      .eq('id', projectId);
    if (setErr) throw new Error(`repo_root update failed: ${setErr.message}`);

    const { data: studio, error: studioErr } = await supabase
      .from('studios')
      .insert({
        user_id: userId,
        agent_id: 'echo',
        sb_id: echoSbId,
        repo_root: projectRepoRoot,
        worktree_path: `${projectRepoRoot}--echo`,
        branch: 'echo/studio/echo',
        base_branch: 'main',
        status: 'active',
        ephemeral: false,
        metadata: { integrationFixture: 'project-repo-routing' },
      })
      .select('id')
      .single();
    if (studioErr) throw new Error(`studio insert failed: ${studioErr.message}`);
    studioId = studio.id;

    repository.create.mockClear();
    await service().getOrCreateSession(userId, 'echo', {
      threadKey,
      sbId: echoSbId,
      planOnly: true,
    });

    expect(repository.create).toHaveBeenCalledTimes(1);
    const created = repository.create.mock.calls[0][0] as Record<string, any>;
    expect(created.studioId).toBe(studioId);
    expect(created.studioId).not.toBe(otherStudioId);
    expect(created.metadata?.routing_decision?.tier).toBe('project-repo-reuse');
  });
});
