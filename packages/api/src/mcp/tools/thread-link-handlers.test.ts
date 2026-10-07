/**
 * Thread link resolution across owners and renames (Lumen's #737 review).
 *
 * The fake client and the first three probes are Lumen's, from the review of
 * b3b9bbd7, adapted to the reader scope that landed after it (LinkReader): the
 * workspace owner's SBs read every link, anyone else only links between
 * threads it is in and artifacts that are its own user's.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleListThreadLinks, handleUnlinkThread } from './thread-link-handlers';
import { artifactBacklinks } from '../../services/thread-links';
import { threadLinkViewsFor } from './thread-link-views';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/user-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/user-resolver')>()),
  resolveUserOrThrow: vi.fn(async (args: { userId: string }) => ({
    user: { id: args.userId },
    resolvedBy: 'userId',
  })),
}));
vi.mock('../../utils/request-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/request-context')>()),
  getRequestContext: () => undefined,
  getSessionContext: () => undefined,
  getPinnedSlug: () => undefined,
}));

const USER_A = '00000000-0000-4000-8000-000000000001';
const USER_B = '00000000-0000-4000-8000-000000000002';
const WS = 'ws-review';
const FULL = { kind: 'full' } as const;
/** The team's view, in the fixture's workspace, as the workspace owner. */
const FULL_SCOPE = { workspaceId: WS, callerUserId: USER_A, reader: FULL };

/**
 * One workspace, two owners' SBs, both in thread pr:1, which links an
 * artifact. `roles` sets each user's workspace role; `artifactOwner` who owns
 * the artifact.
 */
function fixture(
  opts: {
    roles?: { a: string; b: string };
    artifactOwner?: string;
  } = {}
) {
  const roles = opts.roles ?? { a: 'member', b: 'member' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables: Record<string, any[]> = {
    agent_identities: [
      { id: 'sb-a', agent_id: 'alpha', user_id: USER_A, workspace_id: WS, metadata: {} },
      { id: 'sb-b', agent_id: 'beta', user_id: USER_B, workspace_id: WS, metadata: {} },
    ],
    workspace_members: [
      { workspace_id: WS, user_id: USER_A, role: roles.a },
      { workspace_id: WS, user_id: USER_B, role: roles.b },
    ],
    inbox_threads: [
      {
        id: 'source',
        thread_key: 'pr:1',
        workspace_id: WS,
        title: 'Synthetic source',
        status: 'open',
      },
    ],
    inbox_thread_participants: [
      { thread_id: 'source', sb_id: 'sb-a', user_id: null },
      { thread_id: 'source', sb_id: 'sb-b', user_id: null },
    ],
    artifacts: [
      {
        id: 'artifact',
        user_id: opts.artifactOwner ?? USER_A,
        workspace_id: WS,
        uri: 'ink://specs/example',
        title: 'Synthetic spec',
        artifact_type: 'spec',
      },
    ],
    artifact_uri_aliases: [],
    thread_links: [
      {
        id: 'edge',
        workspace_id: WS,
        source_thread_id: 'source',
        target_kind: 'artifact',
        target_artifact_id: 'artifact',
        target_thread_key: null,
        target_ref: 'artifact',
        relation: 'implements',
        note: null,
        origin: 'explicit',
        linked_by_kind: 'sb',
        linked_by_sb_id: 'sb-a',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    from(table: string) {
      if (!tables[table]) throw new Error(`Unexpected table ${table}`);
      let rows = [...tables[table]];
      let deleting = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = {};
      q.select = () => q;
      q.eq = (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] === val);
        return q;
      };
      q.in = (col: string, vals: unknown[]) => {
        rows = rows.filter((r) => vals.includes(r[col]));
        return q;
      };
      q.not = (col: string, _op: string, val: unknown) => {
        rows = rows.filter((r) => r[col] !== val);
        return q;
      };
      q.order = (col: string, o: { ascending: boolean }) => {
        rows.sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (o.ascending ? 1 : -1));
        return q;
      };
      q.delete = () => {
        deleting = true;
        return q;
      };
      const result = () => {
        if (deleting) tables[table] = tables[table].filter((r) => !rows.includes(r));
        return { data: rows, error: null };
      };
      q.maybeSingle = q.single = async () => ({ data: result().data[0] ?? null, error: null });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
      return q;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { tables, client, dc: { getClient: () => client } as any };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parsed = (r: any) => JSON.parse(r.content[0].text);

describe('thread link resolution across owners (Lumen, #737)', () => {
  it('control: the artifact owner can unlink the edge', async () => {
    const { dc, tables } = fixture();
    const removed = parsed(
      await handleUnlinkThread(
        { userId: USER_A, sbSlug: 'alpha', threadKey: 'pr:1', to: 'ink://specs/example' },
        dc
      )
    );
    expect(removed).toMatchObject({ success: true });
    expect(tables.thread_links).toHaveLength(0);
  });

  // The workspace owner's SB sees an artifact another user owns, so it must
  // be able to remove the link it sees. Resolving through the caller's own
  // artifacts refused this with "No artifact at …".
  it('a participant can unlink a link it can see to another owner’s artifact', async () => {
    const { dc, tables } = fixture({ roles: { a: 'owner', b: 'member' }, artifactOwner: USER_B });
    const outgoing = parsed(
      await handleListThreadLinks({ userId: USER_A, sbSlug: 'alpha', threadKey: 'pr:1' }, dc)
    );
    expect(outgoing.linksTo[0].uri).toBe('ink://specs/example');
    const removed = parsed(
      await handleUnlinkThread(
        { userId: USER_A, sbSlug: 'alpha', threadKey: 'pr:1', to: outgoing.linksTo[0].uri },
        dc
      )
    );
    expect(removed, JSON.stringify(removed)).toMatchObject({ success: true });
    expect(tables.thread_links).toHaveLength(0);
  });

  // Lumen's probe asked the reverse: a member's SB seeing and removing another
  // owner's artifact link. Under the reader scope it does not see it, and the
  // refusal to remove it reads exactly like a missing artifact: what a caller
  // cannot see, it cannot link or unlink, and it is not told it exists.
  it('a restricted reader neither sees nor removes another owner’s artifact link', async () => {
    const { dc, tables } = fixture();
    const outgoing = parsed(
      await handleListThreadLinks({ userId: USER_B, sbSlug: 'beta', threadKey: 'pr:1' }, dc)
    );
    expect(outgoing.linksTo).toEqual([]);
    const removed = parsed(
      await handleUnlinkThread(
        { userId: USER_B, sbSlug: 'beta', threadKey: 'pr:1', to: 'ink://specs/example' },
        dc
      )
    );
    expect(removed).toEqual({ success: false, error: 'No artifact at ink://specs/example' });
    expect(tables.thread_links).toHaveLength(1);
  });

  // Round 1 asked both SBs to get the same spec-twin backlinks. Under the
  // reader scope they differ by design, and round 2 caught this case still
  // asserting equality, i.e. asserting the bypass (Lumen). Both members are in
  // pr:1; only alpha's user owns the spec, so only alpha sees the link to it.
  it('spec-twin backlinks follow the reader: the spec’s owner sees them, another member does not', async () => {
    const { dc } = fixture();
    const alpha = parsed(
      await handleListThreadLinks(
        { userId: USER_A, sbSlug: 'alpha', threadKey: 'spec:example' },
        dc
      )
    );
    const beta = parsed(
      await handleListThreadLinks({ userId: USER_B, sbSlug: 'beta', threadKey: 'spec:example' }, dc)
    );
    expect(alpha.linkedFrom.map((l: { threadKey: string }) => l.threadKey)).toEqual(['pr:1']);
    expect(beta.linkedFrom).toEqual([]);
  });

  // A `spec:` key usually has no thread. Its end is visible to a restricted
  // reader that may see the spec it is the twin of, and only to that reader.
  it('a spec: key end is visible through its spec to the spec’s owner only', async () => {
    const { dc, tables } = fixture();
    tables.thread_links[0] = {
      ...tables.thread_links[0],
      target_kind: 'thread',
      target_thread_key: 'spec:example',
      target_artifact_id: null,
      target_ref: 'spec:example',
    };
    const alpha = parsed(
      await handleListThreadLinks({ userId: USER_A, sbSlug: 'alpha', threadKey: 'pr:1' }, dc)
    );
    expect(alpha.linksTo.map((l: { threadKey: string }) => l.threadKey)).toEqual(['spec:example']);
    const beta = parsed(
      await handleListThreadLinks({ userId: USER_B, sbSlug: 'beta', threadKey: 'pr:1' }, dc)
    );
    expect(beta.linksTo).toEqual([]);
  });

  // Seen through the spec, the end carries the spec's title and no status,
  // and reads the same whether a private spec conversation exists or not
  // (Lumen, #737 round 3).
  it('an end seen through the spec shows the spec, not the conversation, and not whether one exists', async () => {
    const view = async (withConversation: boolean) => {
      const { dc, tables } = fixture();
      tables.thread_links[0] = {
        ...tables.thread_links[0],
        target_kind: 'thread',
        target_thread_key: 'spec:example',
        target_artifact_id: null,
        target_ref: 'spec:example',
      };
      if (withConversation) {
        tables.inbox_threads.push({
          id: 'private-spec-thread',
          thread_key: 'spec:example',
          workspace_id: WS,
          title: 'Synthetic private conversation title',
          status: 'closed',
        });
      }
      const read = parsed(
        await handleListThreadLinks({ userId: USER_A, sbSlug: 'alpha', threadKey: 'pr:1' }, dc)
      );
      return read.linksTo;
    };
    const withConversation = await view(true);
    expect(withConversation).toEqual([
      expect.objectContaining({ threadKey: 'spec:example', title: 'Synthetic spec', via: 'spec' }),
    ]);
    expect(withConversation[0]).not.toHaveProperty('status');
    expect(await view(false)).toEqual(withConversation);
  });

  // The other pole: with the workspace owner's SB in the fixture, both team
  // and spec owner agree, and a member's SB that owns the spec sees it too.
  it('the team sees every spec-twin backlink', async () => {
    const { dc } = fixture({ roles: { a: 'owner', b: 'member' }, artifactOwner: USER_B });
    const alpha = parsed(
      await handleListThreadLinks(
        { userId: USER_A, sbSlug: 'alpha', threadKey: 'spec:example' },
        dc
      )
    );
    const beta = parsed(
      await handleListThreadLinks({ userId: USER_B, sbSlug: 'beta', threadKey: 'spec:example' }, dc)
    );
    expect(alpha.linkedFrom).toHaveLength(1);
    expect(beta.linkedFrom).toEqual(alpha.linkedFrom);
  });
});

describe('spec backlinks across a Library rename (Lumen, #737)', () => {
  function renamed() {
    const f = fixture();
    // pr:1 linked the spec's thread under its old name; the spec was renamed.
    f.tables.thread_links[0] = {
      ...f.tables.thread_links[0],
      target_kind: 'thread',
      target_thread_key: 'spec:old-example',
      target_artifact_id: null,
      target_ref: 'spec:old-example',
    };
    f.tables.artifact_uri_aliases.push({
      user_id: USER_A,
      alias_uri: 'ink://specs/old-example',
      artifact_id: 'artifact',
    });
    return f;
  }

  it('control: a current-name spec-thread link appears on its artifact', async () => {
    const { tables, client } = fixture();
    tables.thread_links[0] = {
      ...tables.thread_links[0],
      target_kind: 'thread',
      target_thread_key: 'spec:example',
      target_artifact_id: null,
      target_ref: 'spec:example',
    };
    expect(
      await artifactBacklinks(client, FULL_SCOPE, { id: 'artifact', uri: 'ink://specs/example' })
    ).toMatchObject({ count: 1 });
  });

  it('keeps the old spec thread’s links on the renamed artifact', async () => {
    const { client } = renamed();
    const oldThread = await threadLinkViewsFor(client, FULL_SCOPE, {
      threadKey: 'spec:old-example',
      threadId: null,
    });
    expect(oldThread.linkedFrom).toHaveLength(1);
    expect(
      await artifactBacklinks(client, FULL_SCOPE, { id: 'artifact', uri: 'ink://specs/example' })
    ).toMatchObject({ count: 1 });
  });

  it('and on the spec thread under its new name', async () => {
    const { client } = renamed();
    const current = await threadLinkViewsFor(client, FULL_SCOPE, {
      threadKey: 'spec:example',
      threadId: null,
    });
    expect(current.linkedFrom.map((l) => l.threadKey)).toEqual(['pr:1']);
  });
});

// Lumen's round-2 probes from the #737 review at 449ca43b, appended as
// written: two controls and three boundary checks.
describe('Lumen round 2 reader boundary probes', () => {
  it('control: a member sees the incoming link when participating at both thread ends', async () => {
    const { dc, tables } = fixture();
    tables.inbox_threads.push({
      id: 'visible',
      thread_key: 'thread:visible',
      workspace_id: WS,
      title: 'Synthetic visible target',
      status: 'open',
    });
    tables.inbox_thread_participants.push({ thread_id: 'visible', sb_id: 'sb-b', user_id: null });
    tables.thread_links[0] = {
      ...tables.thread_links[0],
      target_kind: 'thread',
      target_thread_key: 'thread:visible',
      target_artifact_id: null,
      target_ref: 'thread:visible',
    };
    const incoming = parsed(
      await handleListThreadLinks(
        { userId: USER_B, sbSlug: 'beta', threadKey: 'thread:visible' },
        dc
      )
    );
    expect(incoming.linkedFrom).toHaveLength(1);
  });

  it('control: a member sees an incoming link to its own artifact', async () => {
    const { dc } = fixture({ artifactOwner: USER_B });
    const incoming = parsed(
      await handleListThreadLinks(
        { userId: USER_B, sbSlug: 'beta', uri: 'ink://specs/example' },
        dc
      )
    );
    expect(incoming.linkedFrom).toHaveLength(1);
  });

  it('does not reveal an owner-private artifact link through its spec twin', async () => {
    const { dc, tables } = fixture();
    tables.thread_links[0].note = 'Synthetic restricted artifact link note';
    const byUri = parsed(
      await handleListThreadLinks(
        { userId: USER_B, sbSlug: 'beta', uri: 'ink://specs/example' },
        dc
      )
    );
    expect(byUri).toEqual({ success: false, error: 'No artifact at ink://specs/example' });
    const outgoing = parsed(
      await handleListThreadLinks({ userId: USER_B, sbSlug: 'beta', threadKey: 'pr:1' }, dc)
    );
    expect(outgoing.linksTo).toEqual([]);
    const twin = parsed(
      await handleListThreadLinks({ userId: USER_B, sbSlug: 'beta', threadKey: 'spec:example' }, dc)
    );
    expect(twin.linkedFrom).toEqual([]);
  });

  it('does not reveal a hidden thread link by reading its incoming direction', async () => {
    const { dc, tables } = fixture();
    tables.inbox_threads.push({
      id: 'hidden',
      thread_key: 'thread:hidden',
      workspace_id: WS,
      title: 'Synthetic hidden target',
      status: 'open',
    });
    tables.thread_links[0] = {
      ...tables.thread_links[0],
      target_kind: 'thread',
      target_thread_key: 'thread:hidden',
      target_artifact_id: null,
      target_ref: 'thread:hidden',
      note: 'Synthetic hidden thread link note',
    };
    const outgoing = parsed(
      await handleListThreadLinks({ userId: USER_B, sbSlug: 'beta', threadKey: 'pr:1' }, dc)
    );
    expect(outgoing.linksTo).toEqual([]);
    const incoming = parsed(
      await handleListThreadLinks(
        { userId: USER_B, sbSlug: 'beta', threadKey: 'thread:hidden' },
        dc
      )
    );
    expect(incoming.linkedFrom).toEqual([]);
  });

  it('uses the same legacy artifact scope for outgoing reads and resolution', async () => {
    const { dc, tables } = fixture({ roles: { a: 'owner', b: 'member' }, artifactOwner: USER_B });
    tables.artifacts[0].workspace_id = null;
    tables.thread_links[0].linked_by_sb_id = 'sb-b';
    const byUri = parsed(
      await handleListThreadLinks(
        { userId: USER_A, sbSlug: 'alpha', uri: 'ink://specs/example' },
        dc
      )
    );
    expect(byUri).toEqual({ success: false, error: 'No artifact at ink://specs/example' });
    const outgoing = parsed(
      await handleListThreadLinks({ userId: USER_A, sbSlug: 'alpha', threadKey: 'pr:1' }, dc)
    );
    expect(outgoing.linksTo).toEqual([]);
  });
});

// Lumen's round-3 probe from the #737 review at 141a3b22, appended as
// written: the twin conversation's metadata, and its participant control.
describe('Lumen round 3 spec twin metadata boundary', () => {
  function privateSpecThread() {
    const f = fixture();
    f.tables.inbox_threads.push({
      id: 'private-spec-thread',
      thread_key: 'spec:example',
      workspace_id: WS,
      title: 'Synthetic private conversation title',
      status: 'closed',
    });
    f.tables.thread_links[0] = {
      ...f.tables.thread_links[0],
      target_kind: 'thread',
      target_thread_key: 'spec:example',
      target_artifact_id: null,
      target_ref: 'spec:example',
    };
    return f;
  }

  it('does not grant a spec owner access to the twin conversation title', async () => {
    const { dc, tables } = privateSpecThread();
    expect(
      tables.inbox_thread_participants.some(
        (p) => p.thread_id === 'private-spec-thread' && p.sb_id === 'sb-a'
      )
    ).toBe(false);
    const read = parsed(
      await handleListThreadLinks({ userId: USER_A, sbSlug: 'alpha', threadKey: 'pr:1' }, dc)
    );
    expect(read.linksTo).toHaveLength(1); // Preserve the artifact-authorized edge.
    expect(read.linksTo[0].threadKey).toBe('spec:example');
    expect(read.linksTo[0].title).not.toBe('Synthetic private conversation title');
  });

  it('control: a participant can see the twin conversation title', async () => {
    const { dc, tables } = privateSpecThread();
    tables.inbox_thread_participants.push({
      thread_id: 'private-spec-thread',
      sb_id: 'sb-a',
      user_id: null,
    });
    const read = parsed(
      await handleListThreadLinks({ userId: USER_A, sbSlug: 'alpha', threadKey: 'pr:1' }, dc)
    );
    expect(read.linksTo[0].title).toBe('Synthetic private conversation title');
  });
});
