import { describe, it, expect } from 'vitest';
import { linkReaderForSb, linkReaderForUser, parseLinkTarget, specTwin } from './thread-links';
import { INKLING_CLIENT } from './inklings/inkling-service';

/** An agent_identities lookup answering with one row (or an error), counting reads. */
function identityClient(reply: { data?: unknown; error?: unknown }) {
  const calls = { count: 0 };
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => {
      calls.count += 1;
      return { data: reply.data ?? null, error: reply.error ?? null };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from: () => chain } as any, calls };
}

const SB = { sbId: 'sb-1', userId: 'user-1' };

describe('linkReaderForSb', () => {
  it("gives the workspace owner's own SB the full view", async () => {
    const { client } = identityClient({ data: { id: 'sb-1', user_id: 'user-1', metadata: {} } });
    expect(await linkReaderForSb(client, { ...SB, ownerRole: 'owner' })).toEqual({ kind: 'full' });
  });

  it('restricts an inkling even when its owner owns the workspace', async () => {
    const { client } = identityClient({
      data: { id: 'sb-1', user_id: 'user-1', metadata: { client: INKLING_CLIENT } },
    });
    expect(await linkReaderForSb(client, { ...SB, ownerRole: 'owner' })).toEqual({
      kind: 'participant',
      principal: { kind: 'sb', sbId: 'sb-1' },
      userId: 'user-1',
    });
  });

  // An identity that cannot be read is not shown as the team's.
  it('restricts when the identity cannot be classified', async () => {
    const { client } = identityClient({ error: { message: 'connection reset' } });
    expect((await linkReaderForSb(client, { ...SB, ownerRole: 'owner' })).kind).toBe('participant');
  });

  it("restricts a member's, admin's or viewer's SB without reading the identity", async () => {
    for (const ownerRole of ['member', 'admin', 'viewer']) {
      const { client, calls } = identityClient({ data: { id: 'sb-1', metadata: {} } });
      expect((await linkReaderForSb(client, { ...SB, ownerRole })).kind, ownerRole).toBe(
        'participant'
      );
      expect(calls.count, ownerRole).toBe(0);
    }
  });
});

describe('linkReaderForUser', () => {
  it('gives the owner the full view and restricts everyone else by their own participation', () => {
    expect(linkReaderForUser('owner', 'u')).toEqual({ kind: 'full' });
    expect(linkReaderForUser('member', 'u')).toEqual({
      kind: 'participant',
      principal: { kind: 'user', userId: 'u' },
      userId: 'u',
    });
  });
});

describe('parseLinkTarget', () => {
  it('reads an ink:// URI as an artifact', () => {
    expect(parseLinkTarget('ink://specs/live-agent-surfaces')).toEqual({
      kind: 'artifact',
      uri: 'ink://specs/live-agent-surfaces',
    });
  });

  it('reads a thread key as a thread, project-prefixed ones included', () => {
    expect(parseLinkTarget('pr:701')).toEqual({ kind: 'thread', threadKey: 'pr:701' });
    expect(parseLinkTarget('inktrade:pr:42')).toEqual({
      kind: 'thread',
      threadKey: 'inktrade:pr:42',
    });
  });

  it('trims surrounding whitespace before deciding', () => {
    expect(parseLinkTarget('  spec:thread-media \n')).toEqual({
      kind: 'thread',
      threadKey: 'spec:thread-media',
    });
  });

  it('refuses what is neither', () => {
    for (const bad of ['pr 701', '701', ':701', 'ink://', 'https://example.com/x', 'pr:']) {
      expect(parseLinkTarget(bad), bad).toHaveProperty('error');
    }
  });

  // https:// has the type:identifier shape. It is not a thread, and storing it
  // as one would make a dangling "no thread yet" key out of a web link.
  it('does not mistake a web URL for a thread key', () => {
    expect(parseLinkTarget('https://github.com/x/y/pull/1')).toHaveProperty('error');
  });
});

describe('specTwin', () => {
  it('pairs spec:<slug> with ink://specs/<slug>, both ways', () => {
    expect(specTwin({ kind: 'thread', threadKey: 'spec:live-agent-surfaces' })).toEqual({
      kind: 'artifact',
      uri: 'ink://specs/live-agent-surfaces',
    });
    expect(specTwin({ kind: 'artifact', uri: 'ink://specs/live-agent-surfaces' })).toEqual({
      kind: 'thread',
      threadKey: 'spec:live-agent-surfaces',
    });
  });

  it('has no twin for anything that is not a spec', () => {
    expect(specTwin({ kind: 'thread', threadKey: 'pr:701' })).toBeNull();
    expect(specTwin({ kind: 'artifact', uri: 'ink://ideas/future-vision' })).toBeNull();
  });

  // A project-prefixed spec lives in another repo; the library has no URI to
  // pair it with, so joining it to ink://specs/<slug> would merge two subjects.
  it('does not join a project-prefixed spec key or a nested spec URI', () => {
    expect(specTwin({ kind: 'thread', threadKey: 'inktrade:spec:valuation' })).toBeNull();
    expect(specTwin({ kind: 'thread', threadKey: 'spec:a:b' })).toBeNull();
    expect(specTwin({ kind: 'artifact', uri: 'ink://specs/a/b' })).toBeNull();
  });
});
