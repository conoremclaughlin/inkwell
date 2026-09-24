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
 * Run via: yarn workspace @inklabs/api test:integration:db
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';
import { loadThreadDescriptor } from './thread-descriptor';

const MEMBER = 'echo';
const OUTSIDER = 'not-a-participant';

const TITLE = 'Legibility commission — thread titles';
const SUMMARY = 'Reply routing shipped; titles in review.';

describe('loadThreadDescriptor (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabase: any;
  let userId: string;
  let threadKey: string;
  let threadId: string;

  beforeAll(async () => {
    const dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;

    threadKey = `thread:descriptor-access-${Date.now()}`;
    const { data, error } = await supabase
      .from('inbox_threads')
      .insert({
        thread_key: threadKey,
        user_id: userId,
        created_by_agent_id: MEMBER,
        status: 'open',
        title: TITLE,
        summary: SUMMARY,
        summary_updated_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error) throw new Error(`thread insert: ${error.message}`);
    threadId = data.id as string;

    await supabase
      .from('inbox_thread_participants')
      .insert([{ thread_id: threadId, agent_id: MEMBER }]);
  });

  afterAll(async () => {
    if (!threadId) return;
    await supabase.from('inbox_thread_messages').delete().eq('thread_id', threadId);
    await supabase.from('inbox_thread_participants').delete().eq('thread_id', threadId);
    await supabase.from('inbox_thread_read_status').delete().eq('thread_id', threadId);
    await supabase.from('inbox_threads').delete().eq('id', threadId);
  });

  it('gives a participant the description, dated', async () => {
    // The control. Without it, a loader that returned null for everyone would
    // pass the access test below while delivering nothing to anyone.
    const descriptor = await loadThreadDescriptor(supabase, userId, threadKey, MEMBER);
    expect(descriptor).not.toBeNull();
    expect(descriptor?.title).toBe(TITLE);
    expect(descriptor?.summary).toBe(SUMMARY);
    // created_at has to survive the query, or an unedited title reaches the
    // prompt with no age on it — the second half of Lumen's review.
    expect(descriptor?.createdAt).toBeTruthy();
  });

  it('gives a non-participant nothing, and does not join them to the thread', async () => {
    const descriptor = await loadThreadDescriptor(supabase, userId, threadKey, OUTSIDER);
    expect(descriptor).toBeNull();

    // A read that repaired its own precondition would pass the assertion above
    // on the first call and leak on every call after it.
    const { data: joined } = await supabase
      .from('inbox_thread_participants')
      .select('agent_id')
      .eq('thread_id', threadId)
      .eq('agent_id', OUTSIDER);
    expect(joined ?? []).toEqual([]);
  });

  it('gives nothing when the recipient slug is missing', async () => {
    expect(await loadThreadDescriptor(supabase, userId, threadKey, '')).toBeNull();
  });

  it('gives nothing for a thread that does not exist', async () => {
    expect(
      await loadThreadDescriptor(supabase, userId, `thread:absent-${Date.now()}`, MEMBER)
    ).toBeNull();
  });
});
