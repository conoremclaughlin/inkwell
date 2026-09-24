/**
 * loadThreadDescriptor against the real database.
 *
 * The descriptor is written into the prompt of whoever is being triggered, and
 * `trigger_agent` accepts an arbitrary threadKey without joining the target to
 * that thread. Scoped by user and key alone, the loader therefore handed a
 * thread's title and summary to an SB that `get_thread_messages` refuses as
 * "not a participant" (Lumen, #641 review).
 *
 * These run against the real tables because the defect was in the query: a fake
 * client would have returned whatever I told it to, including for the outsider.
 * The membership test is an INNER JOIN, so only Postgres can show that it holds
 * — and that the read does not quietly join the outsider to the thread.
 *
 * Post-cutover (spec inkmail-thread-scope §1, §3) a thread is one row per
 * (workspace, key) and a participant is a principal, so the recipient is named
 * by canonical id: the member is the fixture's `echo`, the outsider a second SB
 * identity in the same workspace that holds no participant row on the thread.
 *
 * Run via: yarn workspace @inklabs/api test:integration:db
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture, ensureSuiteIdentity } from '../../test/integration-fixtures';
import { loadThreadDescriptor } from './thread-descriptor';

const OUTSIDER = `not-a-participant-${Date.now()}`;

const TITLE = 'Legibility commission — thread titles';
const SUMMARY = 'Reply routing shipped; titles in review.';

describe('loadThreadDescriptor (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabase: any;
  let workspaceId: string;
  let memberSbId: string;
  let outsiderSbId: string | null = null;
  let threadKey: string;
  let threadId: string;

  beforeAll(async () => {
    const dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    workspaceId = fixture.workspaceId;
    memberSbId = fixture.echoSbId;
    outsiderSbId = await ensureSuiteIdentity(dataComposer, fixture, OUTSIDER);

    threadKey = `thread:descriptor-access-${Date.now()}`;
    const { data, error } = await supabase
      .from('inbox_threads')
      .insert({
        thread_key: threadKey,
        workspace_id: workspaceId,
        created_by_kind: 'sb',
        created_by_sb_id: memberSbId,
        status: 'open',
        title: TITLE,
        summary: SUMMARY,
        summary_updated_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error) throw new Error(`thread insert: ${error.message}`);
    threadId = data.id as string;

    const { error: participantError } = await supabase
      .from('inbox_thread_participants')
      .insert([
        { thread_id: threadId, workspace_id: workspaceId, sb_id: memberSbId, user_id: null },
      ]);
    if (participantError) throw new Error(`participant insert: ${participantError.message}`);
  });

  afterAll(async () => {
    if (threadId) {
      await supabase.from('inbox_thread_messages').delete().eq('thread_id', threadId);
      await supabase.from('inbox_thread_participants').delete().eq('thread_id', threadId);
      await supabase.from('inbox_thread_read_status').delete().eq('thread_id', threadId);
      await supabase.from('inbox_threads').delete().eq('id', threadId);
    }
    // After the participant rows — of which the outsider must have none, which
    // is what the second test measures.
    if (outsiderSbId) {
      await supabase.from('agent_identities').delete().eq('id', outsiderSbId);
    }
  });

  it('gives a participant the description, dated', async () => {
    // The control. Without it, a loader that returned null for everyone would
    // pass the access test below while delivering nothing to anyone.
    const descriptor = await loadThreadDescriptor(supabase, workspaceId, threadKey, memberSbId);
    expect(descriptor).not.toBeNull();
    expect(descriptor?.title).toBe(TITLE);
    expect(descriptor?.summary).toBe(SUMMARY);
    // created_at has to survive the query, or an unedited title reaches the
    // prompt with no age on it — the second half of Lumen's review.
    expect(descriptor?.createdAt).toBeTruthy();
  });

  it('gives a non-participant nothing, and does not join them to the thread', async () => {
    const descriptor = await loadThreadDescriptor(supabase, workspaceId, threadKey, outsiderSbId);
    expect(descriptor).toBeNull();

    // A read that repaired its own precondition would pass the assertion above
    // on the first call and leak on every call after it.
    const { data: joined } = await supabase
      .from('inbox_thread_participants')
      .select('sb_id')
      .eq('thread_id', threadId)
      .eq('sb_id', outsiderSbId);
    expect(joined ?? []).toEqual([]);
  });

  it('gives nothing when the recipient or the workspace is missing', async () => {
    expect(await loadThreadDescriptor(supabase, workspaceId, threadKey, null)).toBeNull();
    // No workspace, no thread to describe: never a description from somebody
    // else's workspace under the same key.
    expect(await loadThreadDescriptor(supabase, null, threadKey, memberSbId)).toBeNull();
  });

  it('gives nothing for a thread that does not exist', async () => {
    expect(
      await loadThreadDescriptor(supabase, workspaceId, `thread:absent-${Date.now()}`, memberSbId)
    ).toBeNull();
  });
});
