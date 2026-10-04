/**
 * Thread links against the real schema (thread:thread-links).
 *
 * The writer (link_thread, send_to_inbox links) and every reader
 * (list_thread_links, the get_thread_messages header, get_artifact's
 * linkedFromThreads) meet only in the database: the generated target_ref
 * column, its ON CONFLICT constraint, the composite workspace FK. A fake
 * client agrees with whatever model the handlers already hold, so these run
 * the real handlers against the real table.
 *
 * Run via: yarn test:integration:db:local src/mcp/tools/thread-links.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture, ensureSuiteIdentity } from '../../test/integration-fixtures';
import { findOrCreateThread, handleSendToInbox } from './inbox-handlers';
import { handleGetThreadMessages } from './thread-handlers';
import {
  handleLinkThread,
  handleListThreadLinks,
  handleUnlinkThread,
} from './thread-link-handlers';
import { handleCreateArtifact, handleGetArtifact, handleUpdateArtifact } from './artifact-handlers';
import type { SbPrincipal } from '../../services/principals';
import { INKLING_CLIENT } from '../../services/inklings/inkling-service';

const RUN = randomUUID().slice(0, 8);
const SPEC_SLUG = `tltest-${RUN}`;
const SPEC_URI = `ink://specs/${SPEC_SLUG}`;
const SPEC_KEY = `spec:${SPEC_SLUG}`;
const SPEC_URI_RENAMED = `ink://specs/${SPEC_SLUG}-renamed`;
const KEY_A = `test:tl-a-${RUN}`;
const KEY_B = `test:tl-b-${RUN}`;
const KEY_REFUSED = `test:tl-refused-${RUN}`;
const KEY_D = `test:tl-d-${RUN}`;
// A suite-owned SB: a participant of A and B, never of D. Its owner owns the
// workspace, so it reads links with the team's full view.
const OTHER = `echo-tl-${RUN}`;
// A suite-owned inkling: restricted to links between threads it is in. Made a
// participant of A only.
const INK = `echo-tl-ink-${RUN}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(raw: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(raw.content[0].text as string);
}

describe('thread links (DB integration)', () => {
  let dataComposer: DataComposer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any;
  let userId: string;
  let workspaceId: string;
  let echo: SbPrincipal;
  let otherSbId: string | null = null;
  let inkSbId: string | null = null;
  let artifactId: string;
  let threadB: { id: string };
  let threadD: { id: string };

  const base = () => ({ userId });

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    raw = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
    workspaceId = fixture.workspaceId;
    echo = { kind: 'sb', sbId: fixture.echoSbId, sbSlug: 'echo', userId, workspaceId };
    otherSbId = await ensureSuiteIdentity(dataComposer, fixture, OTHER);
    inkSbId = await ensureSuiteIdentity(dataComposer, fixture, INK);
    const { error: inkErr } = await raw
      .from('agent_identities')
      .update({ metadata: { fixture: true, suite: true, client: INKLING_CLIENT } })
      .eq('id', inkSbId);
    if (inkErr) throw new Error(`inkling identity: ${inkErr.message}`);

    const created = parse(
      await handleCreateArtifact(
        {
          userId,
          workspaceId,
          uri: SPEC_URI,
          title: 'Thread links test spec',
          content: '# spec',
          artifactType: 'spec',
          sbSlug: 'echo',
        },
        dataComposer
      )
    );
    expect(created.success).toBe(true);
    artifactId = created.artifact.id;

    const b = await findOrCreateThread(raw, {
      workspaceId,
      threadKey: KEY_B,
      creator: echo,
      title: 'Thread B',
      participants: [echo],
    });
    threadB = { id: b.id };
    const d = await findOrCreateThread(raw, {
      workspaceId,
      threadKey: KEY_D,
      creator: echo,
      title: 'Thread D',
      participants: [echo],
    });
    threadD = { id: d.id };
  });

  afterAll(async () => {
    if (!raw) return;
    const { data: threads } = await raw
      .from('inbox_threads')
      .select('id')
      .eq('workspace_id', workspaceId)
      .in('thread_key', [KEY_A, KEY_B, KEY_D, KEY_REFUSED]);
    const ids = ((threads ?? []) as Array<{ id: string }>).map((t) => t.id);
    if (ids.length > 0) {
      await raw.from('thread_links').delete().in('source_thread_id', ids);
      await raw.from('inbox_thread_read_status').delete().in('thread_id', ids);
      await raw.from('inbox_thread_messages').delete().in('thread_id', ids);
      await raw.from('inbox_thread_participants').delete().in('thread_id', ids);
      await raw.from('inbox_threads').delete().in('id', ids);
    }
    if (artifactId) await raw.from('artifact_uri_aliases').delete().eq('artifact_id', artifactId);
    await raw.from('artifacts').delete().in('uri', [SPEC_URI, SPEC_URI_RENAMED]);
    if (otherSbId) await raw.from('agent_identities').delete().eq('id', otherSbId);
    if (inkSbId) await raw.from('agent_identities').delete().eq('id', inkSbId);
  });

  it('a send with a bad link stores nothing, not even the thread', async () => {
    await expect(
      handleSendToInbox(
        {
          ...base(),
          senderSlug: 'echo',
          recipientSlug: OTHER,
          threadKey: KEY_REFUSED,
          content: 'refused',
          links: [`ink://specs/missing-${RUN}`],
          trigger: false,
        },
        dataComposer
      )
    ).rejects.toThrow(`No artifact at ink://specs/missing-${RUN}`);
    const { data } = await raw
      .from('inbox_threads')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('thread_key', KEY_REFUSED);
    expect(data).toEqual([]);
  });

  it('a send links its thread, and an unknown relatedArtifactUri is reported, not refused', async () => {
    const sent = parse(
      await handleSendToInbox(
        {
          ...base(),
          senderSlug: 'echo',
          recipientSlug: OTHER,
          threadKey: KEY_A,
          content: 'implements the spec',
          links: [SPEC_KEY, SPEC_KEY],
          relatedArtifactUri: `ink://specs/nope-${RUN}`,
          trigger: false,
        },
        dataComposer
      )
    );
    // The suite identity has no session handler, so session routing reports a
    // failure (success: false) for it. The message is stored regardless, and
    // the links are what this test measures.
    expect(sent.messageId, JSON.stringify(sent)).toBeTruthy();
    // Named twice, linked once.
    expect(sent.links.linked).toEqual([SPEC_KEY]);
    expect(sent.links.failed).toEqual([]);
    expect(sent.links.skipped).toEqual([
      { to: `ink://specs/nope-${RUN}`, reason: `No artifact at ink://specs/nope-${RUN}` },
    ]);

    const { data: rows } = await raw
      .from('thread_links')
      .select('target_kind, target_thread_key, origin, source_message_id, linked_by_kind')
      .eq('workspace_id', workspaceId)
      .eq('target_thread_key', SPEC_KEY);
    expect(rows).toEqual([
      {
        target_kind: 'thread',
        target_thread_key: SPEC_KEY,
        origin: 'send',
        source_message_id: sent.messageId,
        linked_by_kind: 'sb',
      },
    ]);
  });

  it('link_thread writes a link once and a re-link keeps what it does not mention', async () => {
    const first = parse(
      await handleLinkThread(
        {
          ...base(),
          sbSlug: 'echo',
          threadKey: KEY_B,
          to: SPEC_URI,
          relation: 'implements',
          note: 'B builds the spec',
        },
        dataComposer
      )
    );
    expect(first.success).toBe(true);
    expect(first.created).toBe(true);
    expect(first.link).toMatchObject({ kind: 'artifact', uri: SPEC_URI, relation: 'implements' });

    // No relation, no note: both stay as stored.
    const again = parse(
      await handleLinkThread(
        { ...base(), sbSlug: 'echo', threadKey: KEY_B, to: SPEC_URI },
        dataComposer
      )
    );
    expect(again.success).toBe(true);
    expect(again.created).toBe(false);
    expect(again.link).toMatchObject({ relation: 'implements', note: 'B builds the spec' });

    // null clears the note.
    const cleared = parse(
      await handleLinkThread(
        { ...base(), sbSlug: 'echo', threadKey: KEY_B, to: SPEC_URI, note: null },
        dataComposer
      )
    );
    expect(cleared.link).toMatchObject({ relation: 'implements', note: null });

    const { count } = await raw
      .from('thread_links')
      .select('id', { count: 'exact', head: true })
      .eq('source_thread_id', threadB.id);
    expect(count).toBe(1);
  });

  it('a send naming an existing link leaves the chosen relation alone', async () => {
    const sent = parse(
      await handleSendToInbox(
        {
          ...base(),
          senderSlug: 'echo',
          recipientSlug: OTHER,
          threadKey: KEY_B,
          content: 'mentions the spec again',
          links: [SPEC_URI],
          trigger: false,
        },
        dataComposer
      )
    );
    expect(sent.links.alreadyLinked).toEqual([SPEC_URI]);
    expect(sent.links.linked).toEqual([]);
    const { data } = await raw
      .from('thread_links')
      .select('relation, origin')
      .eq('source_thread_id', threadB.id)
      .single();
    expect(data).toEqual({ relation: 'implements', origin: 'explicit' });
  });

  it('the spec and its spec: thread read as one subject, each linker once', async () => {
    // A linked the thread key, B the artifact.
    const byUri = parse(
      await handleListThreadLinks({ ...base(), sbSlug: 'echo', uri: SPEC_URI }, dataComposer)
    );
    expect(byUri.success).toBe(true);
    expect(byUri.linkedFrom.map((l: { threadKey: string }) => l.threadKey).sort()).toEqual(
      [KEY_A, KEY_B].sort()
    );

    // The spec thread has no conversation, and still answers.
    const byKey = parse(
      await handleListThreadLinks({ ...base(), sbSlug: 'echo', threadKey: SPEC_KEY }, dataComposer)
    );
    expect(byKey.threadExists).toBe(false);
    expect(byKey.linksTo).toEqual([]);
    expect(byKey.linkedFrom.map((l: { threadKey: string }) => l.threadKey).sort()).toEqual(
      [KEY_A, KEY_B].sort()
    );

    const b = byKey.linkedFrom.find((l: { threadKey: string }) => l.threadKey === KEY_B);
    expect(b).toMatchObject({
      kind: 'thread',
      title: 'Thread B',
      status: 'open',
      linkedBy: 'echo',
    });
  });

  it('get_thread_messages and get_artifact carry the links', async () => {
    const read = parse(
      await handleGetThreadMessages(
        { ...base(), sbSlug: 'echo', threadKey: KEY_B, fullHistory: true, markRead: false },
        dataComposer
      )
    );
    expect(read.success).toBe(true);
    expect(read.linksError).toBeUndefined();
    expect(read.links.linksToCount).toBe(1);
    expect(read.links.linksTo[0]).toMatchObject({
      kind: 'artifact',
      uri: SPEC_URI,
      artifactId,
      title: 'Thread links test spec',
    });

    // A delivery poll skips the header.
    const poll = parse(
      await handleGetThreadMessages(
        { ...base(), sbSlug: 'echo', threadKey: KEY_B, channelPoll: true, markRead: false },
        dataComposer
      )
    );
    expect(poll.links).toBeUndefined();

    const artifact = parse(await handleGetArtifact({ ...base(), uri: SPEC_URI }, dataComposer));
    expect(artifact.success).toBe(true);
    expect(artifact.linkedFromThreadsError).toBeUndefined();
    expect(artifact.linkedFromThreadCount).toBe(2);
  });

  it('linking needs participation; reading does not', async () => {
    const refused = parse(
      await handleLinkThread(
        { ...base(), sbSlug: OTHER, threadKey: KEY_D, to: 'pr:1' },
        dataComposer
      )
    );
    expect(refused).toEqual({
      success: false,
      error: `Agent ${OTHER} is not a participant in thread ${KEY_D}`,
    });
    const linked = parse(
      await handleLinkThread(
        { ...base(), sbSlug: 'echo', threadKey: KEY_D, to: 'pr:1', relation: 'continues' },
        dataComposer
      )
    );
    expect(linked.success).toBe(true);
    // OTHER was never in D, and still sees what D links to.
    const read = parse(
      await handleListThreadLinks({ ...base(), sbSlug: OTHER, threadKey: KEY_D }, dataComposer)
    );
    expect(read.success).toBe(true);
    expect(read.linksTo).toEqual([
      expect.objectContaining({ kind: 'thread', threadKey: 'pr:1', relation: 'continues' }),
    ]);
    const { count } = await raw
      .from('thread_links')
      .select('id', { count: 'exact', head: true })
      .eq('source_thread_id', threadD.id);
    expect(count).toBe(1);
  });

  // Thread titles carry real content, so only the team reads every link
  // (Myra, thread:thread-links). An inkling sees links between threads it is
  // in, and nothing else, even though its owner owns the workspace.
  it('an inkling sees only links between threads it takes part in', async () => {
    const { data: a } = await raw
      .from('inbox_threads')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('thread_key', KEY_A)
      .single();
    const { error: joinErr } = await raw
      .from('inbox_thread_participants')
      .insert({ thread_id: a.id, workspace_id: workspaceId, sb_id: inkSbId });
    if (joinErr) throw new Error(`join A: ${joinErr.message}`);

    // The spec's backlinks: A (it is in A) but not B (it is not in B).
    const byUri = parse(
      await handleListThreadLinks({ ...base(), sbSlug: INK, uri: SPEC_URI }, dataComposer)
    );
    expect(byUri.linkedFrom.map((l: { threadKey: string }) => l.threadKey)).toEqual([KEY_A]);
    // The control: the team sees both.
    const team = parse(
      await handleListThreadLinks({ ...base(), sbSlug: 'echo', uri: SPEC_URI }, dataComposer)
    );
    expect(team.linkedFrom).toHaveLength(2);

    // D links to pr:1, and the inkling is not in D.
    const d = parse(
      await handleListThreadLinks({ ...base(), sbSlug: INK, threadKey: KEY_D }, dataComposer)
    );
    expect(d.linksTo).toEqual([]);

    // A links to the spec key, which has no thread the inkling could list.
    const read = parse(
      await handleGetThreadMessages(
        { ...base(), sbSlug: INK, threadKey: KEY_A, fullHistory: true, markRead: false },
        dataComposer
      )
    );
    expect(read.success).toBe(true);
    expect(read.links).toMatchObject({ linksTo: [], linksToCount: 0 });
    const teamRead = parse(
      await handleGetThreadMessages(
        { ...base(), sbSlug: 'echo', threadKey: KEY_A, fullHistory: true, markRead: false },
        dataComposer
      )
    );
    expect(teamRead.links.linksToCount).toBe(1);
  });

  it('refuses a self-link, a web URL and an unknown artifact without writing', async () => {
    for (const to of [KEY_B, 'https://github.com/example/repo/pull/1', `ink://specs/none-${RUN}`]) {
      const r = parse(
        await handleLinkThread({ ...base(), sbSlug: 'echo', threadKey: KEY_B, to }, dataComposer)
      );
      expect(r.success, to).toBe(false);
    }
    const { count } = await raw
      .from('thread_links')
      .select('id', { count: 'exact', head: true })
      .eq('source_thread_id', threadB.id);
    expect(count).toBe(1);
  });

  it('unlink removes the link once', async () => {
    const first = parse(
      await handleUnlinkThread(
        { ...base(), sbSlug: 'echo', threadKey: KEY_B, to: SPEC_URI },
        dataComposer
      )
    );
    expect(first).toMatchObject({ success: true, removed: SPEC_URI });
    const second = parse(
      await handleUnlinkThread(
        { ...base(), sbSlug: 'echo', threadKey: KEY_B, to: SPEC_URI },
        dataComposer
      )
    );
    expect(second.success).toBe(false);
  });

  // A Library rename leaves A's link stored under the old spec: key. The
  // renamed artifact still answers for it (Lumen, #737), through the alias
  // row the rename wrote.
  it('a renamed spec keeps the links made to its old spec: thread', async () => {
    const renamed = parse(
      await handleUpdateArtifact(
        {
          userId,
          workspaceId,
          uri: SPEC_URI,
          newUri: SPEC_URI_RENAMED,
          changeSummary: 'renamed for the thread-links suite',
          sbSlug: 'echo',
        },
        dataComposer
      )
    );
    expect(renamed.success).toBe(true);

    const artifact = parse(
      await handleGetArtifact({ ...base(), uri: SPEC_URI_RENAMED }, dataComposer)
    );
    expect(artifact.linkedFromThreadsError).toBeUndefined();
    expect(artifact.linkedFromThreads.map((l: { threadKey: string }) => l.threadKey)).toContain(
      KEY_A
    );

    const byNewKey = parse(
      await handleListThreadLinks(
        { ...base(), sbSlug: 'echo', threadKey: `spec:${SPEC_SLUG}-renamed` },
        dataComposer
      )
    );
    expect(byNewKey.linkedFrom.map((l: { threadKey: string }) => l.threadKey)).toContain(KEY_A);
  });
});
