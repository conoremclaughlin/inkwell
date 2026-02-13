import { describe, expect, it } from 'vitest';
import {
  clearSessionContext,
  mergeWithContext,
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
