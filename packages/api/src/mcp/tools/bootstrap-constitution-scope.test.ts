/**
 * Which workspace's shared documents bootstrap hands an identity, against a
 * filter-evaluating fake database (no network, no real DB).
 *
 * Lumen's review of #781 found two ways an identity was still handed another
 * workspace's documents after bootstrap adopted context-builder's rule: a
 * same-named identity in a second workspace made the slug lookup fail and the
 * rule fall back to the oldest personal workspace, and a workspace with no
 * process took the unscoped ~/.ink copy. These pin both, plus the cases on
 * either side of them. The probe this follows is Lumen's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataComposer } from '../../data/composer';
import { FakePostgrest } from '../../test/fake-postgrest';
import {
  clearPinnedAgent,
  clearSessionContext,
  runWithRequestContext,
} from '../../utils/request-context';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../skills/cloud-service', () => ({
  getCloudSkillsService: () => ({ loadUserSkills: async () => [] }),
}));

import { handleBootstrap } from './memory-handlers';

const USER = '11111111-1111-4111-8111-111111111111';
const PERSONAL = '22222222-2222-4222-8222-222222222222';
const SPACE = '33333333-3333-4333-8333-333333333333';
const SB = '44444444-4444-4444-8444-444444444444';
const PEER = '55555555-5555-4555-8555-555555555555';

let db: FakePostgrest;
let dc: DataComposer;
let base: string;

interface Docs {
  values: string | null;
  process: string | null;
  user: string | null;
  soul: string | null;
}

beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network in this test');
    })
  );
  base = await mkdtemp(join(tmpdir(), 'bootstrap-scope-'));
  db = new FakePostgrest();
  db.seed('users', { id: USER, timezone: 'America/Los_Angeles' });
  db.seed('workspaces', {
    id: PERSONAL,
    user_id: USER,
    type: 'personal',
    slug: 'personal',
    archived_at: null,
    created_at: '2026-01-01T00:00:00Z',
    shared_values: 'PERSONAL-VALUES',
    process: 'PERSONAL-PROCESS',
  });
  db.seed('workspaces', {
    id: SPACE,
    user_id: USER,
    type: 'personal',
    slug: 'space',
    archived_at: null,
    created_at: '2026-10-01T00:00:00Z',
    shared_values: 'SPACE-VALUES',
    process: null,
  });
  for (const id of [PERSONAL, SPACE]) {
    db.seed('workspace_members', { workspace_id: id, user_id: USER, role: 'owner' });
  }
  db.seed('agent_identities', {
    id: SB,
    user_id: USER,
    workspace_id: SPACE,
    agent_id: 'probe',
    name: 'Probe',
    role: 'Synthetic fixture',
    soul: 'SPACE-SOUL',
  });
  db.seed('user_identity', {
    user_id: USER,
    workspace_id: PERSONAL,
    user_profile_md: 'PERSONAL-ABOUT',
  });
  db.seed('user_identity', { user_id: USER, workspace_id: SPACE, user_profile_md: 'SPACE-ABOUT' });
  dc = {
    getClient: () => db,
    repositories: {
      users: { findById: async () => db.rows('users')[0] },
      projects: { findAllByWorkspace: async () => [] },
      sessionFocus: { findLatestByUser: async () => null },
      memory: { getActiveSessions: async () => [] },
    },
  } as unknown as DataComposer;
});

afterEach(async () => {
  clearPinnedAgent();
  clearSessionContext();
  vi.unstubAllGlobals();
  await rm(base, { recursive: true, force: true });
});

async function bootstrap(context: { sbId?: string; sbSlug?: string }, sbSlug = 'probe') {
  const result = await runWithRequestContext({ userId: USER, ...context }, () =>
    handleBootstrap(
      { userId: USER, sbSlug, identityBasePath: base, includeRecentMemories: false },
      dc
    )
  );
  return JSON.parse(result.content[0].text) as { identityFiles: Docs };
}

async function writeSharedFiles(): Promise<void> {
  await mkdir(join(base, 'shared'));
  await writeFile(join(base, 'shared', 'VALUES.md'), 'UNSCOPED-FILE-VALUES');
  await writeFile(join(base, 'shared', 'PROCESS.md'), 'UNSCOPED-FILE-PROCESS');
  await writeFile(join(base, 'shared', 'USER.md'), 'UNSCOPED-FILE-USER');
}

describe('bootstrap shared documents', () => {
  it("control: a bound identity gets its own workspace's documents", async () => {
    const { identityFiles } = await bootstrap({ sbId: SB, sbSlug: 'probe' });
    expect(identityFiles).toMatchObject({
      values: 'SPACE-VALUES',
      process: null,
      user: 'SPACE-ABOUT',
      soul: 'SPACE-SOUL',
    });
  });

  it('a bound identity keeps its own workspace when another workspace has the same slug', async () => {
    db.seed('agent_identities', {
      id: PEER,
      user_id: USER,
      workspace_id: PERSONAL,
      agent_id: 'probe',
      name: 'Peer',
      soul: 'PEER-SOUL',
    });

    const { identityFiles } = await bootstrap({ sbId: SB, sbSlug: 'probe' });

    expect(identityFiles).toMatchObject({
      values: 'SPACE-VALUES',
      process: null,
      user: 'SPACE-ABOUT',
      soul: 'SPACE-SOUL',
    });
  });

  it('an unbound slug that names identities in two workspaces is given neither', async () => {
    db.seed('agent_identities', {
      id: PEER,
      user_id: USER,
      workspace_id: PERSONAL,
      agent_id: 'probe',
      name: 'Peer',
      soul: 'PEER-SOUL',
    });
    await writeSharedFiles();

    const { identityFiles } = await bootstrap({});

    expect(identityFiles.values).toBeNull();
    expect(identityFiles.process).toBeNull();
    expect(identityFiles.user).toBeNull();
    expect(identityFiles.soul).not.toBe('PEER-SOUL');
  });

  it('a workspace without a process is not filled from the unscoped ~/.ink copies', async () => {
    await writeSharedFiles();

    const { identityFiles } = await bootstrap({ sbId: SB, sbSlug: 'probe' });

    expect(identityFiles.process).toBeNull();
    expect(identityFiles.values).toBe('SPACE-VALUES');
    expect(identityFiles.user).toBe('SPACE-ABOUT');
  });

  it('a workspace with no documents at all is given none, from the files or anywhere else', async () => {
    const space = db.rows('workspaces').find((row) => row.id === SPACE)!;
    space.shared_values = null;
    const about = db.rows('user_identity').find((row) => row.workspace_id === SPACE)!;
    about.user_profile_md = null;
    db.seed('user_identity', {
      user_id: USER,
      workspace_id: null,
      user_profile_md: 'UNSCOPED-ROW-USER',
      shared_values_md: 'UNSCOPED-ROW-VALUES',
      process_md: 'UNSCOPED-ROW-PROCESS',
    });
    await writeSharedFiles();

    const { identityFiles } = await bootstrap({ sbId: SB, sbSlug: 'probe' });

    expect(identityFiles.values).toBeNull();
    expect(identityFiles.process).toBeNull();
    expect(identityFiles.user).toBeNull();
  });

  it('carries the SB’s own values and relationships in its identity document, not the shared values', async () => {
    const sb = db.rows('agent_identities').find((row) => row.id === SB)!;
    sb.description = 'PROBE-DESCRIPTION';
    sb.values = ['OWN-VALUE'];
    sb.relationships = { wren: 'OWN-RELATIONSHIP' };

    const { identityFiles } = await bootstrap({ sbId: SB, sbSlug: 'probe' });
    const self = (identityFiles as Docs & { self: string | null }).self;

    expect(self).toBe(
      'PROBE-DESCRIPTION\n\n## My values\n\n- OWN-VALUE\n\n## My relationships\n\n- **wren:** OWN-RELATIONSHIP'
    );
    expect(identityFiles.values).toBe('SPACE-VALUES');
  });

  it("refuses a token bound to one identity when bootstrap names another's slug", async () => {
    await expect(bootstrap({ sbId: SB }, 'someone-else')).rejects.toThrow(
      /Agent identity mismatch/
    );
  });
});
