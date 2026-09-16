import { describe, expect, it } from 'vitest';
import {
  clearPinnedAgent,
  clearSessionContext,
  getPinnedSlug,
  mergeWithContext,
  pinSessionAgent,
  runWithRequestContext,
  setSessionContext,
} from './request-context';

describe('request-context workspace merging', () => {
  it('falls back to session workspaceId when request context is absent', () => {
    clearSessionContext();
    setSessionContext({ userId: 'user-1', workspaceId: 'workspace-session' });

    const merged = mergeWithContext({});
    expect(merged.workspaceId).toBe('workspace-session');

    clearSessionContext();
  });

  it('prefers request workspaceId over session workspaceId', async () => {
    clearSessionContext();
    setSessionContext({ userId: 'user-1', workspaceId: 'workspace-session' });

    await runWithRequestContext(
      { userId: 'user-1', workspaceId: 'workspace-request' },
      async () => {
        const merged = mergeWithContext({});
        expect(merged.workspaceId).toBe('workspace-request');
      }
    );

    clearSessionContext();
  });
});

describe('identity pinning in HTTP mode', () => {
  it('does not set process-global pin when MCP_TRANSPORT=http', () => {
    const previous = process.env.MCP_TRANSPORT;
    process.env.MCP_TRANSPORT = 'http';

    clearPinnedAgent();
    pinSessionAgent('wren');
    pinSessionAgent('lumen');

    expect(getPinnedSlug()).toBeNull();

    clearPinnedAgent();
    process.env.MCP_TRANSPORT = previous;
  });

  it('returns request-scoped sbSlug in request context', async () => {
    const previous = process.env.MCP_TRANSPORT;
    process.env.MCP_TRANSPORT = 'http';

    await runWithRequestContext({ userId: 'user-1', sbSlug: 'lumen' }, async () => {
      expect(getPinnedSlug()).toBe('lumen');
    });

    process.env.MCP_TRANSPORT = previous;
  });
});
