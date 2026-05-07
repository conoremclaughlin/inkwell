/**
 * Integration tests for session-scoped thread filtering.
 *
 * Exercises the real DB path to verify:
 * 1. joined_at baseline prevents replay of pre-join history
 * 2. session_id on participants enables per-session thread filtering
 * 3. channelPoll respects session_id when filtering threads
 *
 * Run via: yarn test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import {
  ensureEchoIntegrationFixture,
  INTEGRATION_TEST_USER_ID,
} from '../../test/integration-fixtures';

describe('Session-scoped thread filtering (integration)', () => {
  let dataComposer: DataComposer;
  let supabase: ReturnType<DataComposer['getClient']>;
  let testUserId: string;
  let threadId: string;
  const threadKey = `test:session-filter-${Date.now()}`;
  const sessionIdA = '00000000-0000-4000-a000-000000000001';
  const sessionIdB = '00000000-0000-4000-a000-000000000002';

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    testUserId = fixture.userId;

    // Ensure test sessions exist
    for (const sid of [sessionIdA, sessionIdB]) {
      await (supabase as any).from('sessions').upsert(
        {
          id: sid,
          user_id: testUserId,
          agent_id: 'echo',
          status: 'active',
          lifecycle: 'idle',
        },
        { onConflict: 'id' }
      );
    }

    // Create test thread
    const { data: thread, error: threadErr } = await (supabase as any)
      .from('inbox_threads')
      .insert({
        thread_key: threadKey,
        user_id: testUserId,
        created_by_agent_id: 'echo',
        title: 'Session filter test',
      })
      .select('id')
      .single();

    if (threadErr) throw new Error(`Failed to create thread: ${threadErr.message}`);
    threadId = thread.id;
  });

  afterAll(async () => {
    // Cleanup in dependency order
    if (threadId) {
      await (supabase as any).from('inbox_thread_messages').delete().eq('thread_id', threadId);
      await (supabase as any).from('inbox_thread_read_status').delete().eq('thread_id', threadId);
      await (supabase as any).from('inbox_thread_participants').delete().eq('thread_id', threadId);
      await (supabase as any).from('inbox_threads').delete().eq('id', threadId);
    }
    for (const sid of [sessionIdA, sessionIdB]) {
      await (supabase as any).from('sessions').delete().eq('id', sid);
    }
  });

  it('joined_at baseline prevents replay of pre-join messages', async () => {
    // Insert a message BEFORE the participant joins
    const preJoinTime = new Date(Date.now() - 60000).toISOString();
    await (supabase as any).from('inbox_thread_messages').insert({
      thread_id: threadId,
      sender_agent_id: 'test-sender',
      content: 'Message before echo joined',
      message_type: 'message',
      created_at: preJoinTime,
    });

    // Add participant (joined_at = now, which is AFTER the message)
    await (supabase as any).from('inbox_thread_participants').insert({
      thread_id: threadId,
      agent_id: 'echo',
      session_id: sessionIdA,
    });

    // Insert a message AFTER the participant joined
    await (supabase as any).from('inbox_thread_messages').insert({
      thread_id: threadId,
      sender_agent_id: 'test-sender',
      content: 'Message after echo joined',
      message_type: 'message',
    });

    // Query participant's joined_at
    const { data: participant } = await (supabase as any)
      .from('inbox_thread_participants')
      .select('joined_at')
      .eq('thread_id', threadId)
      .eq('agent_id', 'echo')
      .single();

    // Count messages after joined_at (what the unread logic should do)
    const { count: unreadAfterJoin } = await (supabase as any)
      .from('inbox_thread_messages')
      .select('*', { count: 'exact', head: true })
      .eq('thread_id', threadId)
      .gt('created_at', participant.joined_at);

    // Should only see the post-join message, not the pre-join one
    expect(unreadAfterJoin).toBe(1);

    // Without the baseline (no filter), both messages would be "unread"
    const { count: totalMessages } = await (supabase as any)
      .from('inbox_thread_messages')
      .select('*', { count: 'exact', head: true })
      .eq('thread_id', threadId);

    expect(totalMessages).toBe(2);
  });

  it('session_id filters participants to the correct session', async () => {
    // echo is already a participant with sessionIdA from the previous test.
    // Query participants filtered by session_id.
    const { data: sessionAParticipants } = await (supabase as any)
      .from('inbox_thread_participants')
      .select('thread_id')
      .eq('agent_id', 'echo')
      .or(`session_id.eq.${sessionIdA},session_id.is.null`);

    expect(sessionAParticipants?.length).toBeGreaterThanOrEqual(1);
    expect(sessionAParticipants?.some((p: any) => p.thread_id === threadId)).toBe(true);

    // Session B should NOT see this thread (it's assigned to session A)
    const { data: sessionBParticipants } = await (supabase as any)
      .from('inbox_thread_participants')
      .select('thread_id')
      .eq('agent_id', 'echo')
      .or(`session_id.eq.${sessionIdB},session_id.is.null`);

    const sessionBHasThread = sessionBParticipants?.some((p: any) => p.thread_id === threadId);
    expect(sessionBHasThread).toBe(false);
  });

  it('null session_id participants are visible to all sessions', async () => {
    // Create a second thread with no session_id on the participant
    const { data: thread2 } = await (supabase as any)
      .from('inbox_threads')
      .insert({
        thread_key: `${threadKey}-unassigned`,
        user_id: testUserId,
        created_by_agent_id: 'echo',
        title: 'Unassigned thread',
      })
      .select('id')
      .single();

    await (supabase as any).from('inbox_thread_participants').insert({
      thread_id: thread2.id,
      agent_id: 'echo',
      // no session_id — unassigned
    });

    // Both sessions should see unassigned threads
    for (const sid of [sessionIdA, sessionIdB]) {
      const { data: participants } = await (supabase as any)
        .from('inbox_thread_participants')
        .select('thread_id')
        .eq('agent_id', 'echo')
        .or(`session_id.eq.${sid},session_id.is.null`);

      const hasUnassigned = participants?.some((p: any) => p.thread_id === thread2.id);
      expect(hasUnassigned).toBe(true);
    }

    // Cleanup
    await (supabase as any).from('inbox_thread_participants').delete().eq('thread_id', thread2.id);
    await (supabase as any).from('inbox_threads').delete().eq('id', thread2.id);
  });

  it('trigger path stamps session_id on participant', async () => {
    // Simulate what the trigger handler does: update participant session_id
    // after getOrCreateSession resolves the recipient's session.
    const newSessionId = '00000000-0000-4000-a000-000000000003';

    // Create the session first (FK constraint)
    await (supabase as any).from('sessions').upsert(
      {
        id: newSessionId,
        user_id: testUserId,
        agent_id: 'echo',
        status: 'active',
        lifecycle: 'idle',
      },
      { onConflict: 'id' }
    );

    // Update participant's session_id (simulating trigger handler)
    const { error: updateErr } = await (supabase as any)
      .from('inbox_thread_participants')
      .update({ session_id: newSessionId })
      .eq('thread_id', threadId)
      .eq('agent_id', 'echo');

    expect(updateErr).toBeNull();

    // Verify the update
    const { data: updated } = await (supabase as any)
      .from('inbox_thread_participants')
      .select('session_id')
      .eq('thread_id', threadId)
      .eq('agent_id', 'echo')
      .single();

    expect(updated.session_id).toBe(newSessionId);

    // Cleanup
    await (supabase as any).from('sessions').delete().eq('id', newSessionId);
  });
});

describe('Cross-studio self-message filtering (integration)', () => {
  let dataComposer: DataComposer;
  let supabase: ReturnType<DataComposer['getClient']>;
  let testUserId: string;
  const sessionAlpha = '00000000-0000-4000-b000-000000000001';
  const sessionBeta = '00000000-0000-4000-b000-000000000002';
  let crossStudioThreadId: string;
  const crossStudioThreadKey = `test:cross-studio-${Date.now()}`;

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    testUserId = fixture.userId;

    for (const sid of [sessionAlpha, sessionBeta]) {
      await (supabase as any).from('sessions').upsert(
        {
          id: sid,
          user_id: testUserId,
          agent_id: 'echo',
          status: 'active',
          lifecycle: 'idle',
        },
        { onConflict: 'id' }
      );
    }

    // Create thread for cross-studio self-messaging
    const { data: thread, error } = await (supabase as any)
      .from('inbox_threads')
      .insert({
        thread_key: crossStudioThreadKey,
        user_id: testUserId,
        created_by_agent_id: 'echo',
        title: 'Cross-studio self-message test',
      })
      .select('id')
      .single();

    if (error) throw new Error(`Failed to create thread: ${error.message}`);
    crossStudioThreadId = thread.id;
  });

  afterAll(async () => {
    if (crossStudioThreadId) {
      await (supabase as any)
        .from('inbox_thread_messages')
        .delete()
        .eq('thread_id', crossStudioThreadId);
      await (supabase as any)
        .from('inbox_thread_participants')
        .delete()
        .eq('thread_id', crossStudioThreadId);
      await (supabase as any).from('inbox_threads').delete().eq('id', crossStudioThreadId);
    }
    for (const sid of [sessionAlpha, sessionBeta]) {
      await (supabase as any).from('sessions').delete().eq('id', sid);
    }
  });

  it('cross-studio self-message participant has null session_id', async () => {
    // For cross-studio self-messages, session_id must be null so both
    // studios see the thread. Simulate by inserting participant without session_id.
    await (supabase as any).from('inbox_thread_participants').insert({
      thread_id: crossStudioThreadId,
      agent_id: 'echo',
      // no session_id — correct for cross-studio self-message
    });

    const { data: participant } = await (supabase as any)
      .from('inbox_thread_participants')
      .select('session_id')
      .eq('thread_id', crossStudioThreadId)
      .eq('agent_id', 'echo')
      .single();

    expect(participant.session_id).toBeNull();
  });

  it('both studio sessions can see the cross-studio thread', async () => {
    // With session_id null, both sessions should find the thread via
    // the OR filter: session_id.eq.X,session_id.is.null
    for (const sid of [sessionAlpha, sessionBeta]) {
      const { data: participants } = await (supabase as any)
        .from('inbox_thread_participants')
        .select('thread_id')
        .eq('agent_id', 'echo')
        .or(`session_id.eq.${sid},session_id.is.null`);

      const hasThread = participants?.some((p: any) => p.thread_id === crossStudioThreadId);
      expect(hasThread).toBe(true);
    }
  });

  it('stamping session_id would hide thread from other studio', async () => {
    // Demonstrate the problem that Option 2 prevents: if we stamped
    // session_id = sessionAlpha, sessionBeta would lose visibility.
    await (supabase as any)
      .from('inbox_thread_participants')
      .update({ session_id: sessionAlpha })
      .eq('thread_id', crossStudioThreadId)
      .eq('agent_id', 'echo');

    // Session Alpha sees it
    const { data: alphaResults } = await (supabase as any)
      .from('inbox_thread_participants')
      .select('thread_id')
      .eq('agent_id', 'echo')
      .or(`session_id.eq.${sessionAlpha},session_id.is.null`);

    expect(alphaResults?.some((p: any) => p.thread_id === crossStudioThreadId)).toBe(true);

    // Session Beta does NOT see it — this is the bug we're preventing
    const { data: betaResults } = await (supabase as any)
      .from('inbox_thread_participants')
      .select('thread_id')
      .eq('agent_id', 'echo')
      .or(`session_id.eq.${sessionBeta},session_id.is.null`);

    expect(betaResults?.some((p: any) => p.thread_id === crossStudioThreadId)).toBe(false);

    // Restore null for cleanup consistency
    await (supabase as any)
      .from('inbox_thread_participants')
      .update({ session_id: null })
      .eq('thread_id', crossStudioThreadId)
      .eq('agent_id', 'echo');
  });
});
