import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceContainerSchema,
  listWorkspaceContainersSchema,
  handleCreateWorkspaceContainer,
  handleListWorkspaceContainers,
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
        findById: vi.fn(),
        update: vi.fn(),
        listMembers: vi.fn(),
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
      mockDataComposer as never,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.workspace.id).toBe('ws-1');
    expect(mockDataComposer.repositories.workspaceContainers.create).toHaveBeenCalled();
    expect(mockDataComposer.repositories.workspaceContainers.addMember).toHaveBeenCalledWith('ws-1', 'user-123', 'owner');
  });

  it('list handler ensures personal workspace by default', async () => {
    mockDataComposer.repositories.workspaceContainers.ensurePersonalWorkspace.mockResolvedValue({
      id: 'personal-1',
    });
    mockDataComposer.repositories.workspaceContainers.listByUser.mockResolvedValue([]);

    const result = await handleListWorkspaceContainers(
      { email: 'test@test.com' },
      mockDataComposer as never,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(mockDataComposer.repositories.workspaceContainers.ensurePersonalWorkspace).toHaveBeenCalledWith('user-123');
    expect(mockDataComposer.repositories.workspaceContainers.listByUser).toHaveBeenCalled();
  });
});

