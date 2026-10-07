import { describe, expect, it } from 'vitest';
import {
  clearPinnedAgent,
  clearSessionContext,
  getAuthenticatedPrincipal,
  getPinnedSlug,
  getUserFromContext,
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

describe('user context inside and outside a request', () => {
  it('a request with no user does not inherit the process-global session user', async () => {
    clearSessionContext();
    setSessionContext({ userId: 'someone-who-bootstrapped' });

    await runWithRequestContext({}, async () => {
      expect(getUserFromContext()).toBeUndefined();
      expect(getAuthenticatedPrincipal()).toBeUndefined();
      expect(mergeWithContext({}).userId).toBeUndefined();
    });

    clearSessionContext();
  });

  it('outside any request the session user is still used, as stdio needs', () => {
    clearSessionContext();
    setSessionContext({ userId: 'stdio-user' });

    expect(getUserFromContext()?.userId).toBe('stdio-user');
    expect(getAuthenticatedPrincipal()).toBeUndefined();

    clearSessionContext();
  });

  it('the authenticated principal is the request context user', async () => {
    await runWithRequestContext({ userId: 'user-1', email: 'user-1@example.com' }, async () => {
      expect(getAuthenticatedPrincipal()).toEqual({
        userId: 'user-1',
        email: 'user-1@example.com',
      });
    });
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
