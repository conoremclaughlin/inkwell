/**
 * A spawned session's memories are its own canonical owner's, never a
 * same-slug peer's (ink://specs/remove-shared-memories §3.3).
 *
 * Lumen's #764 review case: getAgentIdentity falls back to a slug lookup and
 * picks one of several same-slug identities, which serves for prompt text. A
 * memory owner taken from that pick handed a peer's critical memory to a
 * legacy session with no sbId, and to one whose sbId named no identity.
 */

import { describe, expect, it, vi } from 'vitest';
import { ContextBuilder } from './context-builder';
import { makeFakeSupabase } from './fake-supabase';
import type { Session } from './types';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const USER = '11111111-1111-4111-8111-111111111111';
const ALPHA = '22222222-2222-4222-8222-222222222222';
const PEER = '33333333-3333-4333-8333-333333333333';
const NOBODY = '55555555-5555-4555-8555-555555555555';

const identity = (id: string, workspace: string, updated: string) => ({
  id,
  user_id: USER,
  agent_id: 'fixture-sb',
  workspace_id: workspace,
  name: 'Fixture',
  role: 'Test identity',
  updated_at: updated,
  values: [],
  capabilities: [],
  relationships: {},
});

const memory = (id: string, sbId: string, content: string) => ({
  id,
  user_id: USER,
  agent_id: 'fixture-sb',
  sb_id: sbId,
  contact_id: null,
  content,
  source: 'observation',
  salience: 'critical',
  topics: [],
  metadata: {},
  version: 1,
  created_at: '2026-10-07T00:00:00Z',
  expires_at: null,
});

function fixture(opts: { sbId?: string; peer?: boolean }) {
  const db = makeFakeSupabase({
    agent_identities: [
      identity(ALPHA, 'workspace-alpha', '2026-10-01T00:00:00Z'),
      // The peer is the newer row: the one a slug lookup picks.
      ...(opts.peer === false ? [] : [identity(PEER, 'workspace-peer', '2026-10-02T00:00:00Z')]),
    ],
    users: [{ id: USER, timezone: 'America/Los_Angeles', preferences: {} }],
    memories: [
      memory('44444444-4444-4444-8444-444444444444', PEER, 'PEER-ONLY-SYNTHETIC-MEMORY'),
      memory('66666666-6666-4666-8666-666666666666', ALPHA, 'ALPHA-OWN-SYNTHETIC-MEMORY'),
    ],
  });
  const session = {
    id: 'session-fixture',
    userId: USER,
    sbSlug: 'fixture-sb',
    sbId: opts.sbId,
    compactionCount: 0,
  } as Session;
  return { builder: new ContextBuilder(db), session };
}

async function contextText(opts: { sbId?: string; peer?: boolean }): Promise<string> {
  const { builder, session } = fixture(opts);
  const context = await builder.buildContext(USER, 'fixture-sb', session);
  return JSON.stringify({ recent: context.recentMemories, summary: context.knowledgeSummary });
}

describe('ContextBuilder — whose memories a session sees', () => {
  it("a canonical session sees its own memories and not the peer's", async () => {
    const text = await contextText({ sbId: ALPHA });
    expect(text).toContain('ALPHA-OWN-SYNTHETIC-MEMORY');
    expect(text).not.toContain('PEER-ONLY-SYNTHETIC-MEMORY');
  });

  it('a legacy session whose slug names two identities sees no memories', async () => {
    const text = await contextText({ sbId: undefined });
    expect(text).not.toContain('PEER-ONLY-SYNTHETIC-MEMORY');
    expect(text).not.toContain('ALPHA-OWN-SYNTHETIC-MEMORY');
  });

  it('a session whose sbId names no identity sees no memories, not the fallback’s', async () => {
    const text = await contextText({ sbId: NOBODY });
    expect(text).not.toContain('PEER-ONLY-SYNTHETIC-MEMORY');
    expect(text).not.toContain('ALPHA-OWN-SYNTHETIC-MEMORY');
  });

  it('a legacy session whose slug names exactly one identity still sees its own', async () => {
    const text = await contextText({ sbId: undefined, peer: false });
    expect(text).toContain('ALPHA-OWN-SYNTHETIC-MEMORY');
    expect(text).not.toContain('PEER-ONLY-SYNTHETIC-MEMORY');
  });
});
