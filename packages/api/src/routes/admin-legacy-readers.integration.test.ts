/**
 * The two §5 legacy readers/writers against the REAL post-cutover schema
 * (spec inkmail-thread-scope): the individuals inbox's group-thread section
 * and save_project. A table-backed mock can show which columns a query
 * names; only the database can show that they exist after the cutover, and
 * that a row without a workspace is refused.
 *
 * Run via: yarn test:integration (or yarn test:integration:db:local)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Request, Response } from 'express';
import { getDataComposer } from '../data/composer';
import { ensureEchoIntegrationFixture, ensureSuiteIdentity } from '../test/integration-fixtures';
import { handleSaveProject } from '../mcp/tools/context-handlers';
import router from './admin';

const AGENT = `echo-legacy-${Math.random().toString(36).slice(2, 8)}`;

type Handler = (req: Request, res: Response) => Promise<void>;
function getInboxHandler(): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entry: any) => entry.route?.path === '/individuals/:sbSlug/inbox' && entry.route?.methods?.get
  );
  if (!layer) throw new Error('GET /individuals/:sbSlug/inbox not found in router stack');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe('§5 legacy readers over the post-cutover schema (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabase: any;
  let userId: string;
  let workspaceId: string;
  let echoSbId: string;
  let agentSbId: string;
  let threadId: string | undefined;
  const threadKey = `test:legacy-readers-${Date.now()}`;
  const projectName = `legacy-readers-${Date.now()}`;

  beforeAll(async () => {
    const dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
    workspaceId = fixture.workspaceId;
    echoSbId = fixture.echoSbId;
    agentSbId = await ensureSuiteIdentity(dataComposer, fixture, AGENT);

    const { data: thread, error: threadErr } = await supabase
      .from('inbox_threads')
      .insert({
        thread_key: threadKey,
        workspace_id: workspaceId,
        created_by_kind: 'user',
        created_by_user_id: userId,
        title: 'legacy readers',
        status: 'open',
      })
      .select('id')
      .single();
    if (threadErr) throw new Error(`Failed to create thread: ${threadErr.message}`);
    threadId = thread.id as string;

    const { error: partErr } = await supabase.from('inbox_thread_participants').insert([
      { thread_id: threadId, workspace_id: workspaceId, sb_id: agentSbId },
      { thread_id: threadId, workspace_id: workspaceId, sb_id: echoSbId },
      { thread_id: threadId, workspace_id: workspaceId, user_id: userId },
    ]);
    if (partErr) throw new Error(`Failed to add participants: ${partErr.message}`);

    const { error: msgErr } = await supabase.from('inbox_thread_messages').insert([
      {
        thread_id: threadId,
        sender_kind: 'sb',
        sender_sb_id: echoSbId,
        sender_agent_id: 'echo',
        content: 'from echo',
        message_type: 'message',
        created_at: '2026-09-13T00:01:00Z',
      },
      {
        thread_id: threadId,
        sender_kind: 'user',
        sender_user_id: userId,
        content: 'from the person',
        message_type: 'message',
        created_at: '2026-09-13T00:02:00Z',
      },
    ]);
    if (msgErr) throw new Error(`Failed to insert messages: ${msgErr.message}`);

    const { error: readErr } = await supabase
      .from('inbox_thread_read_status')
      .upsert(
        { thread_id: threadId, sb_id: agentSbId, last_read_at: '2026-09-13T00:01:00Z' },
        { onConflict: 'thread_id,principal_key' }
      );
    if (readErr) throw new Error(`Failed to set read pointer: ${readErr.message}`);
  });

  afterAll(async () => {
    if (threadId) {
      await supabase.from('inbox_thread_read_status').delete().eq('thread_id', threadId);
      await supabase.from('inbox_thread_messages').delete().eq('thread_id', threadId);
      await supabase.from('inbox_thread_participants').delete().eq('thread_id', threadId);
      await supabase.from('inbox_threads').delete().eq('id', threadId);
    }
    await supabase
      .from('projects')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('name', projectName);
    if (agentSbId) await supabase.from('agent_identities').delete().eq('id', agentSbId);
  });

  it('the individuals inbox lists the group thread by identity, named for the viewer, with the pointer honoured', async () => {
    const res: Record<string, unknown> = { _status: 200, _json: null };
    res.status = (code: number) => ((res._status = code), res);
    res.json = (payload: unknown) => ((res._json = payload), res);
    await getInboxHandler()(
      {
        params: { sbSlug: AGENT },
        query: {},
        headers: {},
        cookies: {},
        inkUserId: userId,
        inkWorkspaceId: workspaceId,
        inkWorkspaceRole: 'owner',
      } as unknown as Request,
      res as unknown as Response
    );
    expect(res._status).toBe(200);
    const body = res._json as {
      stats: { groupThreadsUnavailable: boolean };
      groupThreads: Array<{
        threadKey: string;
        participants: string[];
        people: Array<{ userId: string; isOwn: boolean }>;
        unreadCount: number;
        messages: Array<{ senderKind: string; senderName: string; isOwn: boolean; status: string }>;
      }>;
    };
    expect(body.stats.groupThreadsUnavailable).toBe(false);
    const mine = body.groupThreads.find((t) => t.threadKey === threadKey);
    expect(mine).toBeDefined();
    expect([...mine!.participants].sort()).toEqual([AGENT, 'echo'].sort());
    expect(mine!.people).toEqual([{ userId, name: expect.any(String), isOwn: true }]);
    expect(mine!.messages.map((m) => [m.senderKind, m.isOwn, m.status])).toEqual([
      ['sb', false, 'read'],
      ['user', true, 'unread'],
    ]);
    expect(mine!.messages[0].senderName).toBe('echo');
    expect(mine!.unreadCount).toBe(1);
  });

  it('save_project writes a project INTO a workspace — the column the cutover made mandatory', async () => {
    const dataComposer = await getDataComposer();
    await handleSaveProject(
      { userId, name: projectName, description: 'post-cutover' },
      dataComposer
    );
    const { data: rows, error } = await supabase
      .from('projects')
      .select('workspace_id, user_id, name')
      .eq('name', projectName);
    expect(error).toBeNull();
    expect(rows).toEqual([{ workspace_id: workspaceId, user_id: userId, name: projectName }]);
  });
});
