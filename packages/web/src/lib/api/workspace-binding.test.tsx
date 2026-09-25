// @vitest-environment jsdom
/**
 * A request bound to a workspace asks that workspace, whatever is selected
 * by the time it is sent. The sidebar selects a new workspace and
 * invalidates every query before any component re-renders, so the old
 * workspace's still-active query refetches first; unbound, it stored the new
 * workspace's page under the old workspace's key (Lumen, #679). The real
 * client, interceptors and QueryClient run here; only the transport is
 * synthetic.
 */

import { createElement, useSyncExternalStore, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AxiosAdapter } from 'axios';
import { apiClient, apiGet } from './client';
import { useWorkspaceApiQuery } from './hooks';
import {
  getSelectedWorkspaceId,
  setSelectedWorkspaceId,
  subscribeSelectedWorkspace,
} from '@/lib/workspace-selection';

const WORKSPACE_HEADER = 'x-ink-workspace-id';

let sent: Array<string | null> = [];
let savedAdapter: typeof apiClient.defaults.adapter;

/** Answers every GET with the workspace it was asked for, and records it. */
const echoWorkspace: AxiosAdapter = (config) => {
  const workspace = (config.headers[WORKSPACE_HEADER] as string | undefined) ?? null;
  sent.push(workspace);
  return Promise.resolve({
    data: { workspace },
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  });
};

beforeEach(() => {
  sent = [];
  savedAdapter = apiClient.defaults.adapter;
  apiClient.defaults.adapter = echoWorkspace;
});

afterEach(() => {
  cleanup();
  apiClient.defaults.adapter = savedAdapter;
  setSelectedWorkspaceId(null);
});

describe('workspace-bound requests', () => {
  it('ask their own workspace, whatever is selected', async () => {
    setSelectedWorkspaceId('fixture-workspace-b');
    await apiGet('/api/admin/threads/messages?key=a', { workspaceId: 'fixture-workspace-a' });
    expect(sent).toEqual(['fixture-workspace-a']);
  });

  it('bound to the default workspace, send no workspace at all', async () => {
    setSelectedWorkspaceId('fixture-workspace-b');
    await apiGet('/api/admin/threads/messages?key=a', { workspaceId: null });
    expect(sent).toEqual([null]);
  });

  it('leave unbound requests following the selection', async () => {
    setSelectedWorkspaceId('fixture-workspace-b');
    await apiGet('/api/admin/threads');
    expect(sent).toEqual(['fixture-workspace-b']);
  });
});

describe('useWorkspaceApiQuery across a sidebar switch', () => {
  it('never caches one workspace’s page under another’s key, A -> B -> A', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    setSelectedWorkspaceId('fixture-workspace-a');

    const view = renderHook(
      () => {
        const workspaceId = useSyncExternalStore(
          subscribeSelectedWorkspace,
          getSelectedWorkspaceId,
          () => null
        );
        return useWorkspaceApiQuery<{ workspace: string | null }>(
          ['thread-messages', 'fixture:pr:1'],
          '/api/admin/threads/messages?key=fixture%3Apr%3A1',
          workspaceId
        );
      },
      { wrapper }
    );
    const cached = (workspaceId: string) =>
      client.getQueryData<{ workspace: string | null }>([
        'thread-messages',
        'fixture:pr:1',
        { workspaceId },
      ])?.workspace;

    try {
      await waitFor(() => expect(view.result.current.data?.workspace).toBe('fixture-workspace-a'));

      // Sidebar.handleWorkspaceChange: select, then invalidate everything.
      await act(async () => {
        setSelectedWorkspaceId('fixture-workspace-b');
        await client.invalidateQueries();
      });
      await waitFor(() => expect(view.result.current.data?.workspace).toBe('fixture-workspace-b'));
      expect(cached('fixture-workspace-a')).toBe('fixture-workspace-a');

      await act(async () => {
        setSelectedWorkspaceId('fixture-workspace-a');
        await client.invalidateQueries();
      });
      await waitFor(() => expect(view.result.current.data?.workspace).toBe('fixture-workspace-a'));
      expect(cached('fixture-workspace-a')).toBe('fixture-workspace-a');
      expect(cached('fixture-workspace-b')).toBe('fixture-workspace-b');
    } finally {
      view.unmount();
      client.clear();
    }
  });
});
