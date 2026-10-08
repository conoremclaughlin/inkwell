/**
 * Limit B through the MCP workspace tools: a group created invite-only takes
 * nobody directly, and no metadata edit switches the mode either way. The
 * first two cases are Lumen's review regressions on invitations r1.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FakePostgrest } from '../../test/fake-postgrest';
import {
  WorkspacesRepository,
  keepingFixedMetadata,
} from '../../data/repositories/workspaces.repository';
import { handleAddWorkspaceMember, handleUpdateWorkspace } from './workspace-handlers';

const OWNER = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';

vi.mock('../../services/user-resolver', () => ({
  userIdentifierBaseSchema: z.object({ userId: z.string().optional() }),
  resolveUserOrThrow: vi.fn(async () => ({
    user: { id: '11111111-1111-4111-8111-111111111111' },
    resolvedBy: 'userId',
  })),
}));

type Row = Record<string, unknown>;

let db: FakePostgrest;
let repo: WorkspacesRepository;
let composer: never;
let added: ReturnType<typeof vi.spyOn>;

function seedGroup(slug: string, metadata: Row): string {
  const group = db.seed('workspaces', {
    user_id: OWNER,
    name: slug,
    slug,
    type: 'team',
    metadata,
    archived_at: null,
  });
  db.seed('workspace_members', { workspace_id: group.id, user_id: OWNER, role: 'owner' });
  return group.id as string;
}

const metadataOf = (id: string) =>
  db.rows('workspaces').find((row) => row.id === id)!.metadata as Row;

beforeEach(() => {
  db = new FakePostgrest();
  repo = new WorkspacesRepository(db as never);
  // The fake has no upsert; this stands in for addMember's write.
  added = vi.spyOn(repo, 'addMember').mockImplementation(async (workspaceId, userId, role) => {
    const row = db.seed('workspace_members', { workspace_id: workspaceId, user_id: userId, role });
    return { id: row.id as string, workspaceId, userId, role, createdAt: row.created_at as string };
  });
  composer = {
    repositories: {
      workspaces: repo,
      users: {
        findByEmail: vi.fn(async () => ({ id: FRIEND, email: 'friend@example.test' })),
        create: vi.fn(),
      },
    },
  } as never;
});

describe('adding a collaborator through MCP', () => {
  it('does not directly add anyone to an invite-only group', async () => {
    const group = seedGroup('synthetic', { membershipMode: 'invite_only' });
    await handleAddWorkspaceMember(
      { userId: OWNER, workspaceId: group, inviteeEmail: 'friend@example.test' },
      composer
    );
    expect(added).not.toHaveBeenCalled();
    expect(db.rows('workspace_members').filter((row) => row.user_id === FRIEND)).toHaveLength(0);
  });

  it('still adds to an ordinary group', async () => {
    const group = seedGroup('ordinary', {});
    await handleAddWorkspaceMember(
      { userId: OWNER, workspaceId: group, inviteeEmail: 'friend@example.test' },
      composer
    );
    expect(added).toHaveBeenCalledWith(group, FRIEND, 'member');
  });
});

describe('editing a group’s metadata', () => {
  it('does not erase the invite-only mode', async () => {
    const group = seedGroup('synthetic', { membershipMode: 'invite_only' });
    await handleUpdateWorkspace(
      { userId: OWNER, workspaceId: group, metadata: { color: 'blue' } },
      composer
    );
    expect(metadataOf(group)).toEqual({ color: 'blue', membershipMode: 'invite_only' });
  });

  it('does not switch the mode either way', async () => {
    const inviteOnly = seedGroup('synthetic', { membershipMode: 'invite_only' });
    const ordinary = seedGroup('ordinary', { color: 'red' });
    await handleUpdateWorkspace(
      { userId: OWNER, workspaceId: inviteOnly, metadata: { membershipMode: 'open' } },
      composer
    );
    await handleUpdateWorkspace(
      { userId: OWNER, workspaceId: ordinary, metadata: { membershipMode: 'invite_only' } },
      composer
    );
    expect(metadataOf(inviteOnly)).toEqual({ membershipMode: 'invite_only' });
    expect(metadataOf(ordinary)).toEqual({});
  });
});

describe('keepingFixedMetadata', () => {
  it('keeps the mode as created, whatever the new metadata says', () => {
    expect(keepingFixedMetadata({ membershipMode: 'invite_only' }, null)).toEqual({
      membershipMode: 'invite_only',
    });
    expect(keepingFixedMetadata(null, { membershipMode: 'invite_only', a: 1 })).toEqual({ a: 1 });
    expect(keepingFixedMetadata(undefined, null)).toBeNull();
  });
});
