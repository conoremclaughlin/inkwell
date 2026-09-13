/**
 * An SB acts with its OWNER's membership, and a thread page's carriers are
 * the workspace's (spec inkmail-thread-scope §1, §3) — against the real
 * post-cutover schema. The unit suites prove the rules over a fake; only
 * the database can show that a viewer's SB is refused at the real
 * handlers, that a revoked owner's SB reads nothing, and that a same-key
 * session from another workspace stays off this workspace's thread page
 * (Lumen, #621 P1 / P2).
 *
 * Run via: yarn test:integration (or yarn test:integration:db:local)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { getDataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';
import { handleCloseThread, handleGetThreadMessages } from './thread-handlers';
import { handleSendToInbox } from './inbox-handlers';
import router from '../../routes/admin';

const RUN = Math.random().toString(36).slice(2, 8);
const VIEWER_SB = `viewer-sb-${RUN}`;

type Handler = (req: Request, res: Response) => Promise<void>;
function getThreadsHandler(): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entry: any) => entry.route?.path === '/threads' && entry.route?.methods?.get
  );
  if (!layer) throw new Error('GET /threads not found in router stack');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe("SB callers act with their owner's membership; carriers follow the workspace (integration)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabase: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dataComposer: any;
  let ownerUserId: string;
  let workspaceId: string;
  let echoSbId: string;
  // A second person: a viewer in the fixture workspace, owner of their own.
  const viewerUserId = randomUUID();
  let viewerPersonalWorkspaceId: string;
  let viewerSbId: string;
  let viewerHomeSbId: string;
  let threadId: string | undefined;
  const threadKey = `test:caller-membership-${Date.now()}`;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    ownerUserId = fixture.userId;
    workspaceId = fixture.workspaceId;
    echoSbId = fixture.echoSbId;

    // The database provisions the viewer's personal workspace on insert.
    const { error: userErr } = await supabase
      .from('users')
      .insert({ id: viewerUserId, email: `viewer-${RUN}@integration.test` });
    if (userErr) throw new Error(`Failed to create viewer user: ${userErr.message}`);
    const { data: personal } = await supabase
      .from('workspaces')
      .select('id')
      .eq('user_id', viewerUserId)
      .eq('slug', 'personal')
      .maybeSingle();
    if (!personal?.id) throw new Error('viewer personal workspace was not provisioned');
    viewerPersonalWorkspaceId = personal.id as string;

    const { error: memberErr } = await supabase
      .from('workspace_members')
      .insert({ workspace_id: workspaceId, user_id: viewerUserId, role: 'viewer' });
    if (memberErr) throw new Error(`Failed to add viewer membership: ${memberErr.message}`);

    const identity = async (ws: string, agentId: string) => {
      const { data, error } = await supabase
        .from('agent_identities')
        .insert({
          user_id: viewerUserId,
          workspace_id: ws,
          agent_id: agentId,
          name: agentId,
          role: 'assistant',
        })
        .select('id')
        .single();
      if (error) throw new Error(`Failed to create identity ${agentId}: ${error.message}`);
      return data.id as string;
    };
    viewerSbId = await identity(workspaceId, VIEWER_SB);
    // A different slug at home: the same slug in two of the viewer's
    // workspaces would (rightly) fail the unbound caller closed as ambiguous.
    viewerHomeSbId = await identity(viewerPersonalWorkspaceId, `${VIEWER_SB}-home`);

    const { data: thread, error: threadErr } = await supabase
      .from('inbox_threads')
      .insert({
        thread_key: threadKey,
        workspace_id: workspaceId,
        created_by_kind: 'sb',
        created_by_sb_id: echoSbId,
        title: 'caller membership',
        status: 'open',
      })
      .select('id')
      .single();
    if (threadErr) throw new Error(`Failed to create thread: ${threadErr.message}`);
    threadId = thread.id as string;
    const { error: partErr } = await supabase.from('inbox_thread_participants').insert([
      { thread_id: threadId, workspace_id: workspaceId, sb_id: echoSbId },
      { thread_id: threadId, workspace_id: workspaceId, sb_id: viewerSbId },
    ]);
    if (partErr) throw new Error(`Failed to add participants: ${partErr.message}`);
    const { error: msgErr } = await supabase.from('inbox_thread_messages').insert({
      thread_id: threadId,
      sender_kind: 'sb',
      sender_sb_id: echoSbId,
      sender_agent_id: 'echo',
      content: 'hello viewer',
      message_type: 'message',
    });
    if (msgErr) throw new Error(`Failed to insert message: ${msgErr.message}`);

    // Two same-key sessions: one in this workspace, one in the viewer's own.
    for (const row of [
      {
        user_id: ownerUserId,
        agent_id: 'echo',
        sb_id: echoSbId,
        thread_key: threadKey,
        status: 'active',
      },
      {
        user_id: viewerUserId,
        agent_id: `${VIEWER_SB}-home`,
        sb_id: viewerHomeSbId,
        thread_key: threadKey,
        status: 'active',
      },
    ]) {
      const { data, error } = await supabase.from('sessions').insert(row).select('id').single();
      if (error) throw new Error(`Failed to insert session: ${error.message}`);
      sessionIds.push(data.id as string);
    }
  });

  afterAll(async () => {
    if (sessionIds.length) await supabase.from('sessions').delete().in('id', sessionIds);
    if (threadId) {
      await supabase.from('inbox_thread_read_status').delete().eq('thread_id', threadId);
      await supabase.from('inbox_thread_messages').delete().eq('thread_id', threadId);
      await supabase.from('inbox_thread_participants').delete().eq('thread_id', threadId);
      await supabase.from('inbox_threads').delete().eq('id', threadId);
    }
    await supabase.from('agent_identities').delete().eq('user_id', viewerUserId);
    await supabase.from('workspace_members').delete().eq('user_id', viewerUserId);
    await supabase.from('users').delete().eq('id', viewerUserId);
  });

  it("a viewer's SB reads the thread and is refused every write — close, send", async () => {
    const read = await handleGetThreadMessages(
      { userId: viewerUserId, agentId: VIEWER_SB, threadKey },
      dataComposer
    );
    const readPayload = JSON.parse((read.content[0] as { text: string }).text);
    expect(readPayload.success).not.toBe(false);

    await expect(
      handleCloseThread({ userId: viewerUserId, agentId: VIEWER_SB, threadKey }, dataComposer)
    ).rejects.toThrow('Your role in this workspace (viewer) cannot close a thread');
    await expect(
      handleSendToInbox(
        {
          userId: viewerUserId,
          senderAgentId: VIEWER_SB,
          recipientAgentId: 'echo',
          threadKey,
          content: 'a viewer writing',
          trigger: false,
        },
        dataComposer
      )
    ).rejects.toThrow('Your role in this workspace (viewer) cannot send to a thread');
    // Without a sender name the token's own user is writing; the write is
    // theirs and their role gates it (Lumen, #624).
    await expect(
      handleSendToInbox(
        {
          userId: viewerUserId,
          recipientAgentId: VIEWER_SB,
          threadKey,
          content: 'as system',
          trigger: false,
        },
        dataComposer
      )
    ).rejects.toThrow('Your role in this workspace (viewer) cannot send to a thread');
    const { data: after } = await supabase
      .from('inbox_thread_messages')
      .select('id')
      .eq('thread_id', threadId);
    expect(after).toHaveLength(1);
  });

  it("the workspace's thread page carries this workspace's session, not the same-key one from the viewer's own", async () => {
    const res: Record<string, unknown> = { _status: 200, _json: null };
    res.status = (code: number) => ((res._status = code), res);
    res.json = (payload: unknown) => ((res._json = payload), res);
    await getThreadsHandler()(
      {
        query: {},
        params: {},
        headers: {},
        cookies: {},
        pcpUserId: ownerUserId,
        pcpWorkspaceId: workspaceId,
        pcpWorkspaceRole: 'owner',
      } as unknown as Request,
      res as unknown as Response
    );
    expect(res._status).toBe(200);
    const body = res._json as {
      spines: Array<{ key: string; sessions: Array<{ id: string }> }>;
    };
    const spine = body.spines.find((sp) => sp.key === threadKey);
    expect(spine).toBeDefined();
    const onKey = spine!.sessions.map((sess) => sess.id);
    expect(onKey).toContain(sessionIds[0]);
    expect(onKey).not.toContain(sessionIds[1]);
  });

  it("an SB whose owner's membership ended reads nothing", async () => {
    await supabase
      .from('workspace_members')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('user_id', viewerUserId);
    await expect(
      handleGetThreadMessages({ userId: viewerUserId, agentId: VIEWER_SB, threadKey }, dataComposer)
    ).rejects.toThrow(`${VIEWER_SB}'s owner cannot act in this workspace: not a member`);
  });
});
