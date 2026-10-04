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

  it('gives both workspace SBs the same spec-twin backlinks', async () => {
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
      await artifactBacklinks(client, WS, { id: 'artifact', uri: 'ink://specs/example' }, FULL)
    ).toMatchObject({ count: 1 });
  });

  it('keeps the old spec thread’s links on the renamed artifact', async () => {
    const { client } = renamed();
    const oldThread = await threadLinkViewsFor(
      client,
      USER_A,
      WS,
      { threadKey: 'spec:old-example', threadId: null },
      FULL
    );
    expect(oldThread.linkedFrom).toHaveLength(1);
    expect(
      await artifactBacklinks(client, WS, { id: 'artifact', uri: 'ink://specs/example' }, FULL)
    ).toMatchObject({ count: 1 });
  });

  it('and on the spec thread under its new name', async () => {
    const { client } = renamed();
    const current = await threadLinkViewsFor(
      client,
      USER_A,
      WS,
      { threadKey: 'spec:example', threadId: null },
      FULL
    );
    expect(current.linkedFrom.map((l) => l.threadKey)).toEqual(['pr:1']);
  });
});
