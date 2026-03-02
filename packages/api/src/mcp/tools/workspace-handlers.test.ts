import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceSchema,
  listWorkspacesSchema,
  handleCreateWorkspace,
  handleListWorkspaces,
  handleGetWorkspace,
  handleUpdateWorkspace,
  handleAddWorkspaceMember,
  addWorkspaceMemberSchema,
} from './workspace-handlers';

vi.mock('../../services/user-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/user-resolver')>();
  return {
    ...actual,
    resolveUserOrThrow: vi.fn().mockResolvedValue({
      user: { id: 'user-123' },
      resolvedBy: 'email',
    }),
  };
});

function createMockDataComposer() {
  return {
    repositories: {
      workspaces: {
        create: vi.fn(),
        addMember: vi.fn(),
        ensurePersonalWorkspace: vi.fn(),
        listByUser: vi.fn(),
        listMembershipsByUser: vi.fn(),
        findById: vi.fn(),
        canManageWorkspace: vi.fn(),
        getMemberRole: vi.fn(),
        update: vi.fn(),
        listMembers: vi.fn(),
        listMembersWithUsers: vi.fn(),
      },
      users: {
        findByEmail: vi.fn(),
        create: vi.fn(),
      },
    },
  };
}

describe('workspace schemas', () => {
  it('accepts create payload and defaults type', () => {
    const parsed = createWorkspaceSchema.safeParse({
      email: 'test@test.com',
      name: 'PCP Team',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('personal');
    }
  });

  it('accepts list payload and defaults ensurePersonal', () => {
    const parsed = listWorkspacesSchema.safeParse({
      email: 'test@test.com',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.ensurePersonal).toBe(true);
    }
  });

  it('accepts add-member payload and defaults role', () => {
    const parsed = addWorkspaceMemberSchema.safeParse({
      email: 'owner@test.com',
      workspaceId: '11111111-1111-1111-1111-111111111111',
      inviteeEmail: 'co@test.com',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.role).toBe('member');
    }
  });
});

describe('workspace handlers', () => {
  let mockDataComposer: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    mockDataComposer = createMockDataComposer();
    vi.clearAllMocks();
  });

  it('create handler creates workspace and owner membership', async () => {
    mockDataComposer.repositories.workspaces.create.mockResolvedValue({
      id: 'ws-1',
      userId: 'user-123',
      name: 'PCP Team',
      slug: 'pcp-team',
      type: 'team',
      description: null,
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
    });
    mockDataComposer.repositories.workspaces.addMember.mockResolvedValue({
      id: 'member-1',
      workspaceId: 'ws-1',
      userId: 'user-123',
      role: 'owner',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await handleCreateWorkspace(
      { email: 'test@test.com', name: 'PCP Team', type: 'team' },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.workspace.id).toBe('ws-1');
    expect(mockDataComposer.repositories.workspaces.create).toHaveBeenCalled();
    expect(mockDataComposer.repositories.workspaces.addMember).toHaveBeenCalledWith(
      'ws-1',
      'user-123',
      'owner'
    );
  });

  it('list handler ensures personal workspace by default', async () => {
    mockDataComposer.repositories.workspaces.ensurePersonalWorkspace.mockResolvedValue({
      id: 'personal-1',
    });
    mockDataComposer.repositories.workspaces.listMembershipsByUser.mockResolvedValue([]);

    const result = await handleListWorkspaces(
      { email: 'test@test.com' },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(mockDataComposer.repositories.workspaces.ensurePersonalWorkspace).toHaveBeenCalledWith(
      'user-123'
    );
    expect(mockDataComposer.repositories.workspaces.listMembershipsByUser).toHaveBeenCalled();
  });

  it('get handler returns workspace when found', async () => {
    mockDataComposer.repositories.workspaces.findById.mockResolvedValue({
      id: 'ws-1',
      userId: 'user-123',
      name: 'PCP Team',
      slug: 'pcp-team',
      type: 'team',
      description: null,
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
    });

    const result = await handleGetWorkspace(
      { email: 'test@test.com', workspaceId: '11111111-1111-1111-1111-111111111111' },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.workspace.id).toBe('ws-1');
  });

  it('get handler returns error when workspace is missing', async () => {
    mockDataComposer.repositories.workspaces.findById.mockResolvedValue(null);

    const result = await handleGetWorkspace(
      { email: 'test@test.com', workspaceId: '11111111-1111-1111-1111-111111111111' },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Workspace not found');
    expect(result.isError).toBe(true);
  });

  it('update handler updates workspace fields', async () => {
    mockDataComposer.repositories.workspaces.update.mockResolvedValue({
      id: 'ws-1',
      userId: 'user-123',
      name: 'PCP Team Updated',
      slug: 'pcp-team-updated',
      type: 'team',
      description: 'new desc',
      metadata: { hello: 'world' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      archivedAt: null,
    });

    const result = await handleUpdateWorkspace(
      {
        email: 'test@test.com',
        workspaceId: '11111111-1111-1111-1111-111111111111',
        name: 'PCP Team Updated',
        description: 'new desc',
        metadata: { hello: 'world' },
      },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.workspace.name).toBe('PCP Team Updated');
    expect(mockDataComposer.repositories.workspaces.update).toHaveBeenCalled();
  });

  it('add-member handler adds collaborator by email', async () => {
    mockDataComposer.repositories.workspaces.findById.mockResolvedValue({
      id: 'ws-1',
      userId: 'user-123',
      name: 'PCP Team',
      slug: 'pcp-team',
      type: 'team',
      description: null,
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
    });
    mockDataComposer.repositories.workspaces.canManageWorkspace.mockResolvedValue(true);
    mockDataComposer.repositories.workspaces.getMemberRole.mockResolvedValue('owner');
    mockDataComposer.repositories.users.findByEmail.mockResolvedValue({
      id: 'user-456',
      email: 'co@test.com',
    });
    mockDataComposer.repositories.workspaces.addMember.mockResolvedValue({
      id: 'member-2',
      workspaceId: 'ws-1',
      userId: 'user-456',
      role: 'admin',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await handleAddWorkspaceMember(
      {
        email: 'owner@test.com',
        workspaceId: '11111111-1111-1111-1111-111111111111',
        inviteeEmail: 'co@test.com',
        role: 'admin',
      },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.member.role).toBe('admin');
    expect(mockDataComposer.repositories.workspaces.addMember).toHaveBeenCalledWith(
      'ws-1',
      'user-456',
      'admin'
    );
  });

  it('add-member handler blocks admins from assigning owner role', async () => {
    mockDataComposer.repositories.workspaces.findById.mockResolvedValue({
      id: 'ws-1',
      userId: 'user-123',
      name: 'PCP Team',
      slug: 'pcp-team',
      type: 'team',
      description: null,
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
    });
    mockDataComposer.repositories.workspaces.canManageWorkspace.mockResolvedValue(true);
    mockDataComposer.repositories.workspaces.getMemberRole.mockResolvedValue('admin');

    const result = await handleAddWorkspaceMember(
      {
        email: 'owner@test.com',
        workspaceId: '11111111-1111-1111-1111-111111111111',
        inviteeEmail: 'co@test.com',
        role: 'owner',
      },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Only workspace owners can grant owner role');
    expect(result.isError).toBe(true);
  });
});
