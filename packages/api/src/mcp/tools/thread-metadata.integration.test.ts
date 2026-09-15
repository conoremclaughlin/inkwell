/**
 * Thread title/summary integration tests (real Supabase)
 *
 * A thread's title was set once, at creation, from the first message's subject,
 * and never touched again. Measured 2026-09-15 before the change:
 *
 *   112 of 582 threads (19.2%) had title IS NULL — nearly one in five showed a
 *   reader nothing but its routing key.
 *   spec:review-requests still read "... ink://specs/review-requests v1" while
 *   the artifact was at v10.
 *
 * These tests drive the REAL handlers against the REAL database, so the writer
 * and every reader must agree about the columns. Asserting each against my own
 * model of it would pass even if update_thread wrote a field no reader selects.
 *
 * Run via: yarn workspace @inklabs/api test:integration:db
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';
import {
  handleUpdateThread,
  handleGetThreadMessages,
  handleListThreads,
  THREAD_SUMMARY_MAX,
} from './thread-handlers';

const OWNER = 'echo';
const OUTSIDER = 'not-a-participant';

function parse<T>(raw: { content: Array<{ text: string }> }): T {
  return JSON.parse(raw.content[0].text) as T;
}

describe('Thread title and summary (integration)', () => {
  let dataComposer: DataComposer;
  let userId: string;
  const created: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
  });

  afterEach(async () => {
    if (created.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = dataComposer.getClient() as any;
    for (const key of created) {
      const { data: thread } = await raw
        .from('inbox_threads')
        .select('id')
        .eq('user_id', userId)
        .eq('thread_key', key)
        .maybeSingle();
      if (thread?.id) {
        await raw.from('inbox_thread_messages').delete().eq('thread_id', thread.id);
        await raw.from('inbox_thread_participants').delete().eq('thread_id', thread.id);
        await raw.from('inbox_thread_read_status').delete().eq('thread_id', thread.id);
        await raw.from('inbox_threads').delete().eq('id', thread.id);
      }
    }
    created.length = 0;
  });

  /** A thread in the state 19.2% of real threads are in: no title, no summary. */
  async function createUntitledThread(threadKey: string): Promise<string> {
    created.push(threadKey);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = dataComposer.getClient() as any;
    const { data, error } = await raw
      .from('inbox_threads')
      .insert({
        thread_key: threadKey,
        user_id: userId,
        created_by_agent_id: OWNER,
        status: 'open',
      })
      .select('id, title, summary')
      .single();
    if (error || !data) throw new Error(`thread insert: ${error?.message}`);

    // Precondition, asserted rather than assumed: this is the null-title case.
    expect(data.title).toBeNull();
    expect(data.summary).toBeNull();

    await raw.from('inbox_thread_participants').insert([{ thread_id: data.id, agent_id: OWNER }]);
    return data.id;
  }

  it('sets a title and summary on a thread that had neither, and every reader shows them', async () => {
    const threadKey = 'thread:test-meta-set';
    await createUntitledThread(threadKey);

    const updated = parse<{ success: boolean; updatedFields: string[] }>(
      await handleUpdateThread(
        {
          userId,
          threadKey,
          sbSlug: OWNER,
          title: 'Legibility commission — reply routing and thread titles',
          summary: 'Three pieces from Conor. Reply routing shipped in #638; titles in progress.',
        },
        dataComposer
      )
    );
    expect(updated.success).toBe(true);
    expect(updated.updatedFields).toEqual(['title', 'summary']);

    // Reader 1: the thread timeline.
    const fetched = parse<{
      title: string | null;
      summary: string | null;
      summaryUpdatedAt: string | null;
    }>(await handleGetThreadMessages({ userId, threadKey, sbSlug: OWNER }, dataComposer));
    expect(fetched.title).toBe('Legibility commission — reply routing and thread titles');
    expect(fetched.summary).toBe(
      'Three pieces from Conor. Reply routing shipped in #638; titles in progress.'
    );
    // The age travels with the text, or the summary reads as current forever.
    expect(fetched.summaryUpdatedAt).not.toBeNull();

    // Reader 2: the triage list. A value the writer stores but no reader
    // selects would pass a single-reader assertion and fail here.
    const listed = parse<{
      threads: Array<{ threadKey: string; title: string | null; summary: string | null }>;
    }>(await handleListThreads({ userId, sbSlug: OWNER, status: 'all', limit: 100 }, dataComposer));
    const row = listed.threads.find((t) => t.threadKey === threadKey);
    expect(row?.title).toBe('Legibility commission — reply routing and thread titles');
    expect(row?.summary).toBe(
      'Three pieces from Conor. Reply routing shipped in #638; titles in progress.'
    );
  });

  it('replaces a stale title — the surfaced value is the current one, not the creation-time one', async () => {
    const threadKey = 'thread:test-meta-stale';
    created.push(threadKey);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = dataComposer.getClient() as any;
    const { data } = await raw
      .from('inbox_threads')
      .insert({
        thread_key: threadKey,
        user_id: userId,
        created_by_agent_id: OWNER,
        status: 'open',
        // The spec:review-requests shape: a title asserting a stale version.
        title: 'New spec to brainstorm: Review Requests — ink://specs/review-requests v1',
      })
      .select('id')
      .single();
    await raw.from('inbox_thread_participants').insert([{ thread_id: data.id, agent_id: OWNER }]);

    await handleUpdateThread(
      {
        userId,
        threadKey,
        sbSlug: OWNER,
        title: 'Review Requests spec — v10, publication binding settled',
      },
      dataComposer
    );

    const fetched = parse<{ title: string | null }>(
      await handleGetThreadMessages({ userId, threadKey, sbSlug: OWNER }, dataComposer)
    );
    expect(fetched.title).toBe('Review Requests spec — v10, publication binding settled');
    expect(fetched.title).not.toMatch(/v1$/);
  });

  it('leaves the title alone when only the summary is given', async () => {
    const threadKey = 'thread:test-meta-partial';
    await createUntitledThread(threadKey);

    await handleUpdateThread({ userId, threadKey, sbSlug: OWNER, title: 'Kept' }, dataComposer);
    await handleUpdateThread(
      { userId, threadKey, sbSlug: OWNER, summary: 'Only the summary moved' },
      dataComposer
    );

    const fetched = parse<{ title: string | null; summary: string | null }>(
      await handleGetThreadMessages({ userId, threadKey, sbSlug: OWNER }, dataComposer)
    );
    // "Not provided" must not read as "cleared", or editing one field wipes the other.
    expect(fetched.title).toBe('Kept');
    expect(fetched.summary).toBe('Only the summary moved');
  });

  it('clears a field when null is passed explicitly', async () => {
    const threadKey = 'thread:test-meta-clear';
    await createUntitledThread(threadKey);

    await handleUpdateThread(
      { userId, threadKey, sbSlug: OWNER, title: 'Temporary', summary: 'Temporary' },
      dataComposer
    );
    await handleUpdateThread({ userId, threadKey, sbSlug: OWNER, summary: null }, dataComposer);

    const fetched = parse<{ title: string | null; summary: string | null }>(
      await handleGetThreadMessages({ userId, threadKey, sbSlug: OWNER }, dataComposer)
    );
    expect(fetched.title).toBe('Temporary');
    expect(fetched.summary).toBeNull();
  });

  it('says which attribution it achieved, and always records when', async () => {
    const threadKey = 'thread:test-meta-attribution';
    const threadId = await createUntitledThread(threadKey);

    const result = parse<{ attributedBy: string; updatedBy: string }>(
      await handleUpdateThread(
        { userId, threadKey, sbSlug: OWNER, summary: 'Attributed edit' },
        dataComposer
      )
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = dataComposer.getClient() as any;
    const { data } = await raw
      .from('inbox_threads')
      .select('summary_updated_by_sb_id, summary_updated_at')
      .eq('id', threadId)
      .single();

    // The timestamp is unconditional — it is what keeps a summary from being
    // read as current forever, and it does not depend on naming an author.
    expect(data.summary_updated_at).toBeTruthy();

    // The UUID is conditional, and the response says which case happened rather
    // than leaving a null column to be read as either. This fixture user
    // carries two `echo` identities (one workspace-less), so the slug genuinely
    // does not resolve to one identity here — the 'slug-only' branch is real,
    // not theoretical, which is why it is a stated outcome and not an error.
    expect(['identity', 'slug-only']).toContain(result.attributedBy);
    if (result.attributedBy === 'identity') {
      expect(data.summary_updated_by_sb_id).toBeTruthy();
    } else {
      expect(data.summary_updated_by_sb_id).toBeNull();
    }

    // Either way the edit is attributable in the timeline, by slug.
    expect(result.updatedBy).toBe(OWNER);
    const { data: sys } = await raw
      .from('inbox_thread_messages')
      .select('content, metadata')
      .eq('thread_id', threadId)
      .eq('message_type', 'system')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    expect(sys.content).toContain(OWNER);
    expect(sys.metadata.type).toBe('thread_metadata_updated');
    expect(sys.metadata.attributedBy).toBe(result.attributedBy);
  });

  it('refuses an over-length summary', async () => {
    const threadKey = 'thread:test-meta-toolong';
    await createUntitledThread(threadKey);

    await expect(
      handleUpdateThread(
        { userId, threadKey, sbSlug: OWNER, summary: 'x'.repeat(THREAD_SUMMARY_MAX + 1) },
        dataComposer
      )
    ).rejects.toThrow();

    // And accepts one exactly at the bound — without this the test would pass
    // against a handler that rejects every summary.
    const atBound = parse<{ success: boolean }>(
      await handleUpdateThread(
        { userId, threadKey, sbSlug: OWNER, summary: 'x'.repeat(THREAD_SUMMARY_MAX) },
        dataComposer
      )
    );
    expect(atBound.success).toBe(true);
  });

  it('refuses an edit from a non-participant', async () => {
    const threadKey = 'thread:test-meta-outsider';
    await createUntitledThread(threadKey);

    const result = parse<{ success: boolean; error?: string }>(
      await handleUpdateThread(
        { userId, threadKey, sbSlug: OUTSIDER, summary: 'I was never here' },
        dataComposer
      )
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a participant/);

    const fetched = parse<{ summary: string | null }>(
      await handleGetThreadMessages({ userId, threadKey, sbSlug: OWNER }, dataComposer)
    );
    expect(fetched.summary).toBeNull();
  });

  it('rejects a call that provides neither field rather than reporting a no-op success', async () => {
    const threadKey = 'thread:test-meta-empty';
    await createUntitledThread(threadKey);

    await expect(
      handleUpdateThread({ userId, threadKey, sbSlug: OWNER }, dataComposer)
    ).rejects.toThrow();
  });
});
