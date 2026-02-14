import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceContainerSchema,
  listWorkspaceContainersSchema,
  handleCreateWorkspaceContainer,
  handleListWorkspaceContainers,
  handleGetWorkspaceContainer,
  handleUpdateWorkspaceContainer,
  handleAddWorkspaceMember,
  addWorkspaceMemberSchema,
} from './workspace-container-handlers';

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
      workspaceContainers: {
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

describe('workspace-container schemas', () => {
  it('accepts create payload and defaults type', () => {
    const parsed = createWorkspaceContainerSchema.safeParse({
      email: 'test@test.com',
      name: 'PCP Team',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('personal');
    }
  });

  it('accepts list payload and defaults ensurePersonal', () => {
    const parsed = listWorkspaceContainersSchema.safeParse({
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

describe('workspace-container handlers', () => {
  let mockDataComposer: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    mockDataComposer = createMockDataComposer();
    vi.clearAllMocks();
  });

  it('create handler creates workspace and owner membership', async () => {
    mockDataComposer.repositories.workspaceContainers.create.mockResolvedValue({
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
    mockDataComposer.repositories.workspaceContainers.addMember.mockResolvedValue({
      id: 'member-1',
      workspaceId: 'ws-1',
      userId: 'user-123',
      role: 'owner',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await handleCreateWorkspaceContainer(
      { email: 'test@test.com', name: 'PCP Team', type: 'team' },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.workspace.id).toBe('ws-1');
    expect(mockDataComposer.repositories.workspaceContainers.create).toHaveBeenCalled();
    expect(mockDataComposer.repositories.workspaceContainers.addMember).toHaveBeenCalledWith(
      'ws-1',
      'user-123',
      'owner'
    );
  });

  it('list handler ensures personal workspace by default', async () => {
    mockDataComposer.repositories.workspaceContainers.ensurePersonalWorkspace.mockResolvedValue({
      id: 'personal-1',
    });
    mockDataComposer.repositories.workspaceContainers.listMembershipsByUser.mockResolvedValue([]);

    const result = await handleListWorkspaceContainers(
      { email: 'test@test.com' },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(
      mockDataComposer.repositories.workspaceContainers.ensurePersonalWorkspace
    ).toHaveBeenCalledWith('user-123');
    expect(mockDataComposer.repositories.workspaceContainers.listMembershipsByUser).toHaveBeenCalled();
  });

  it('get handler returns workspace when found', async () => {
    mockDataComposer.repositories.workspaceContainers.findById.mockResolvedValue({
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

    const result = await handleGetWorkspaceContainer(
      { email: 'test@test.com', workspaceId: '11111111-1111-1111-1111-111111111111' },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.workspace.id).toBe('ws-1');
  });

  it('get handler returns error when workspace is missing', async () => {
    mockDataComposer.repositories.workspaceContainers.findById.mockResolvedValue(null);

    const result = await handleGetWorkspaceContainer(
      { email: 'test@test.com', workspaceId: '11111111-1111-1111-1111-111111111111' },
      mockDataComposer as never
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Workspace not found');
    expect(result.isError).toBe(true);
  });

  it('update handler updates workspace fields', async () => {
    mockDataComposer.repositories.workspaceContainers.update.mockResolvedValue({
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

    const result = await handleUpdateWorkspaceContainer(
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
    expect(mockDataComposer.repositories.workspaceContainers.update).toHaveBeenCalled();
  });

  it('add-member handler adds collaborator by email', async () => {
    mockDataComposer.repositories.workspaceContainers.findById.mockResolvedValue({
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
    mockDataComposer.repositories.workspaceContainers.canManageWorkspace.mockResolvedValue(true);
    mockDataComposer.repositories.workspaceContainers.getMemberRole.mockResolvedValue('owner');
    mockDataComposer.repositories.users.findByEmail.mockResolvedValue({
      id: 'user-456',
      email: 'co@test.com',
    });
    mockDataComposer.repositories.workspaceContainers.addMember.mockResolvedValue({
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
    expect(mockDataComposer.repositories.workspaceContainers.addMember).toHaveBeenCalledWith(
      'ws-1',
      'user-456',
      'admin'
    );
  });

  it('add-member handler blocks admins from assigning owner role', async () => {
    mockDataComposer.repositories.workspaceContainers.findById.mockResolvedValue({
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
    mockDataComposer.repositories.workspaceContainers.canManageWorkspace.mockResolvedValue(true);
    mockDataComposer.repositories.workspaceContainers.getMemberRole.mockResolvedValue('admin');

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
