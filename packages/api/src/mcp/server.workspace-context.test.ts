import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env', () => ({
  env: {
    MCP_TRANSPORT: 'http',
    MCP_HTTP_PORT: 0,
    MCP_REQUIRE_OAUTH: false,
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'test-secret',
    SUPABASE_ANON_KEY: 'test-anon',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
  },
}));

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./tools', () => ({
  registerAllTools: vi.fn(),
  registerChannelListener: vi.fn(),
  setMiniAppsRegistry: vi.fn(),
  setTelegramListener: vi.fn(),
}));

vi.mock('../mini-apps', () => ({
  loadMiniApps: vi.fn(() => new Map()),
  registerMiniAppTools: vi.fn(),
  getMiniAppsInfo: vi.fn(() => []),
}));

vi.mock('../routes/admin', () => {
  const { Router } = require('express');
  return {
    default: Router(),
    setWhatsAppListener: vi.fn(),
  };
});

vi.mock('../routes/agent-trigger', () => {
  const { Router } = require('express');
  return {
    default: Router(),
    getAgentGateway: vi.fn(),
  };
});

vi.mock('../routes/chat', () => ({
  createChatRouter: vi.fn(() => {
    const { Router } = require('express');
    return Router();
  }),
}));

vi.mock('../channels/gateway', () => ({
  ChannelGateway: vi.fn(),
  createChannelGateway: vi.fn(() => null),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
    from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn() })) })) })),
  })),
}));

import { MCPServer } from './server';

const mockFindById = vi.fn();
const mockFrom = vi.fn();

function createDataComposerMock() {
  return {
    repositories: {
      workspaces: {
        findById: mockFindById,
      },
    },
    getClient: () => ({
      from: mockFrom,
    }),
  } as any;
}

function buildAgentIdentityChain(result: { data: unknown; error: unknown }) {
  const secondEq = vi.fn().mockResolvedValue(result);
  const firstEq = vi.fn().mockReturnValue({ eq: secondEq });
  return {
    select: vi.fn().mockReturnValue({ eq: firstEq }),
  };
}

describe('MCPServer workspace context resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses requested workspace header when accessible', async () => {
    mockFindById.mockResolvedValue({ id: 'ws-header' });
    mockFrom.mockImplementation(() => {
      throw new Error('agent derivation should not be called for valid header scope');
    });

    const server = new MCPServer(createDataComposerMock());
    const req = {
      header: vi.fn((name: string) => (name === 'x-pcp-workspace-id' ? 'ws-header' : undefined)),
    } as any;

    const result = await (server as any).resolveWorkspaceContextForMcpRequest(req, {
      userId: 'user-1',
      email: 'user@example.com',
      agentId: 'lumen',
    });

    expect(result).toEqual({ workspaceId: 'ws-header', workspaceSource: 'header' });
    expect(mockFindById).toHaveBeenCalledWith('ws-header', 'user-1');
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('throws when requested workspace header is not accessible', async () => {
    mockFindById.mockResolvedValue(null);
    const server = new MCPServer(createDataComposerMock());
    const req = {
      header: vi.fn((name: string) => (name === 'x-pcp-workspace-id' ? 'ws-missing' : undefined)),
    } as any;

    await expect(
      (server as any).resolveWorkspaceContextForMcpRequest(req, {
        userId: 'user-1',
        email: 'user@example.com',
        agentId: 'lumen',
      })
    ).rejects.toThrow('Workspace not found or not accessible');
  });

  it('derives workspace from agent identity when no header is provided', async () => {
    mockFrom.mockReturnValue(
      buildAgentIdentityChain({
        data: [{ workspace_id: 'ws-derived' }],
        error: null,
      })
    );

    const server = new MCPServer(createDataComposerMock());
    const req = { header: vi.fn(() => undefined) } as any;

    const result = await (server as any).resolveWorkspaceContextForMcpRequest(req, {
      userId: 'user-1',
      email: 'user@example.com',
      agentId: 'lumen',
    });

    expect(result).toEqual({ workspaceId: 'ws-derived', workspaceSource: 'derived' });
    expect(mockFrom).toHaveBeenCalledWith('agent_identities');
  });

  it('returns empty context when no header and no derivable workspace', async () => {
    const server = new MCPServer(createDataComposerMock());
    const req = { header: vi.fn(() => undefined) } as any;

    const result = await (server as any).resolveWorkspaceContextForMcpRequest(req, {
      userId: 'user-1',
      email: 'user@example.com',
    });

    expect(result).toEqual({});
  });
});
