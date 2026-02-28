import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSessionContext, runWithRequestContext, setSessionContext } from './request-context';
import {
  resolveWorkspaceContextForRequest,
  resolveWorkspaceScopeForWrite,
} from './workspace-scope';

afterEach(() => {
  clearSessionContext();
});

describe('resolveWorkspaceScopeForWrite', () => {
  it('uses header-derived request workspace first', async () => {
    await runWithRequestContext(
      {
        userId: 'user-1',
        workspaceId: 'ws-header',
        workspaceSource: 'header',
      },
      async () => {
        const derive = vi.fn().mockResolvedValue('ws-derived');
        const result = await resolveWorkspaceScopeForWrite({
          rawArgs: { workspaceId: 'ws-arg' },
          explicitWorkspaceId: 'ws-explicit',
          agentId: 'lumen',
          deriveWorkspaceIdFromAgent: derive,
        });

        expect(result).toEqual({ workspaceId: 'ws-header', source: 'header' });
        expect(derive).not.toHaveBeenCalled();
      }
    );
  });

  it('uses agent-derived workspace when no header workspace exists', async () => {
    const derive = vi.fn().mockResolvedValue('ws-derived');
    const result = await resolveWorkspaceScopeForWrite({
      rawArgs: {},
      agentId: 'lumen',
      deriveWorkspaceIdFromAgent: derive,
    });

    expect(result).toEqual({ workspaceId: 'ws-derived', source: 'derived' });
    expect(derive).toHaveBeenCalledWith('lumen');
  });

  it('falls back to merged request/session/arg workspace when derivation is unavailable', async () => {
    setSessionContext({ userId: 'user-1', workspaceId: 'ws-session' });

    const result = await resolveWorkspaceScopeForWrite({
      rawArgs: {},
    });

    expect(result).toEqual({ workspaceId: 'ws-session', source: 'context' });
  });

  it('returns null when no workspace can be resolved', async () => {
    const result = await resolveWorkspaceScopeForWrite({
      rawArgs: {},
    });

    expect(result).toBeNull();
  });
});

describe('resolveWorkspaceContextForRequest', () => {
  it('returns header workspace when provided and valid', async () => {
    const validate = vi.fn().mockResolvedValue(true);
    const result = await resolveWorkspaceContextForRequest({
      requestedWorkspaceId: 'ws-header',
      validateRequestedWorkspaceId: validate,
      deriveWorkspaceIdFromAgent: vi.fn().mockResolvedValue('ws-derived'),
    });

    expect(result).toEqual({ workspaceId: 'ws-header', source: 'header' });
    expect(validate).toHaveBeenCalledWith('ws-header');
  });

  it('throws when requested header workspace is invalid', async () => {
    await expect(
      resolveWorkspaceContextForRequest({
        requestedWorkspaceId: 'ws-bad',
        validateRequestedWorkspaceId: vi.fn().mockResolvedValue(false),
      })
    ).rejects.toThrow('Workspace not found or not accessible');
  });

  it('falls back to derived workspace when header is absent', async () => {
    const result = await resolveWorkspaceContextForRequest({
      deriveWorkspaceIdFromAgent: vi.fn().mockResolvedValue('ws-derived'),
    });

    expect(result).toEqual({ workspaceId: 'ws-derived', source: 'derived' });
  });
});
