/**
 * apiFetch's recovery paths. Both exist because the failure they cover is
 * otherwise permanent from the phone's point of view: a dead refresh token
 * would 401 forever, and a remembered workspace the account can't reach
 * would 403 every screen until the app was reinstalled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});

vi.mock('expo-constants', () => ({ default: { expoConfig: { hostUri: '10.0.0.5:8081' } } }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
const memory = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k: string) => memory.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => void memory.set(k, v)),
    removeItem: vi.fn(async (k: string) => void memory.delete(k)),
  },
}));

import { apiFetch } from './api';
import { storeLogin } from './auth';
import { getWorkspaceId, setWorkspaceId } from './storage';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

function headerOf(call: number, name: string): string | undefined {
  const init = fetchMock.mock.calls[call]?.[1];
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers[name];
}

beforeEach(async () => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  await storeLogin({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresIn: 3600,
    userId: 'u1',
    email: 'a@b.c',
  });
  await setWorkspaceId(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch workspace scoping', () => {
  it('sends x-ink-workspace-id only when a workspace is selected', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { ok: true }));

    await apiFetch('/api/admin/threads');
    expect(headerOf(0, 'x-ink-workspace-id')).toBeUndefined();

    await setWorkspaceId('ws-2');
    await apiFetch('/api/admin/threads');
    expect(headerOf(1, 'x-ink-workspace-id')).toBe('ws-2');
    expect(headerOf(1, 'Authorization')).toBe('Bearer access-1');
  });

  it('drops an unreachable workspace and retries against the default', async () => {
    await setWorkspaceId('ws-gone');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(403, { error: 'Workspace not found or not accessible' }))
      .mockResolvedValueOnce(jsonResponse(200, { spines: [] }));

    const body = await apiFetch<{ spines: unknown[] }>('/api/admin/threads');

    expect(body).toEqual({ spines: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headerOf(0, 'x-ink-workspace-id')).toBe('ws-gone');
    expect(headerOf(1, 'x-ink-workspace-id')).toBeUndefined();
    expect(getWorkspaceId()).toBeNull();
  });

  it('does not touch the selection for an unrelated 403', async () => {
    await setWorkspaceId('ws-2');
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'Insufficient permissions' }));

    await expect(apiFetch('/api/admin/secrets')).rejects.toThrow('Insufficient permissions');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getWorkspaceId()).toBe('ws-2');
  });

  it('does not retry a 404 when no workspace is selected', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'Thread not found' }));

    await expect(apiFetch('/api/admin/threads/messages?key=pr:1')).rejects.toThrow(
      'Thread not found'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('apiFetch token refresh', () => {
  it('refreshes once on 401 and replays with the new access token', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          accessToken: 'access-2',
          expiresIn: 3600,
          userId: 'u1',
          email: 'a@b.c',
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await apiFetch('/api/admin/threads');

    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/admin\/auth\/mobile-refresh$/);
    expect(headerOf(2, 'Authorization')).toBe('Bearer access-2');
  });
});
