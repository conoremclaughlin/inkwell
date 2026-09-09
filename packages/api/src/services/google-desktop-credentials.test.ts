/**
 * DesktopGoogleCredentialStore — the `desktop` credential source.
 *
 * The properties that matter: a file binds to exactly one email, `inspect`
 * describes the decision `getAccessToken` makes, and Google's permanent
 * refusals stick to a file until it changes while transient failures do not.
 */

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { DesktopGoogleCredentialStore } = await import('./google-desktop-credentials');
const { logger } = await import('../utils/logger');

const cleanup: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ink-google-store-'));
  cleanup.push(dir);
  return dir;
}
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop() as string, { recursive: true, force: true });
  vi.clearAllMocks();
});

function credentialJson(email: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'authorized_user',
    client_id: 'desk-client',
    client_secret: 'desk-secret',
    refresh_token: `rt-${email}`,
    email,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    obtained_at: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

function writeCredential(dir: string, email: string, mtime?: Date, overrides = {}): string {
  const path = join(dir, `${email}.json`);
  writeFileSync(path, JSON.stringify(credentialJson(email, overrides)));
  if (mtime) utimesSync(path, mtime, mtime);
  return path;
}

function granted(token = 'access-1') {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ access_token: token, expires_in: 3600 }),
  } as unknown as Response;
}

function refused(status: number, body: string) {
  return {
    ok: false,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

const T0 = Date.parse('2026-09-08T12:00:00.000Z');

function storeIn(dir: string, fetchImpl: ReturnType<typeof vi.fn>, clock = { now: T0 }) {
  return new DesktopGoogleCredentialStore({
    dir,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => clock.now,
  });
}

describe('list and findForEmail — what is bound to whom', () => {
  it('reports an absent directory as empty without complaint', async () => {
    const store = storeIn(join(tempDir(), 'absent'), vi.fn());
    expect(await store.list()).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('lists well-formed files and skips the client file, non-JSON, and malformed files', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'client.json'),
      JSON.stringify({ installed: { client_id: 'a', client_secret: 'b' } })
    );
    writeFileSync(join(dir, 'notes.txt'), 'not a credential');
    writeFileSync(join(dir, 'broken.json'), JSON.stringify({ type: 'authorized_user' }));
    writeCredential(dir, 'me@example.com');

    const records = await storeIn(dir, vi.fn()).list();

    expect(records.map((r) => r.email)).toEqual(['me@example.com']);
    expect(records[0].scopes).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
    expect(records[0].obtainedAt).toBe('2026-09-08T00:00:00.000Z');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Ignoring malformed desktop Google credential',
      expect.objectContaining({ path: join(dir, 'broken.json'), reason: 'missing client_id' })
    );
  });

  it('binds by email case-insensitively and never to another address', async () => {
    const dir = tempDir();
    writeCredential(dir, 'me@example.com');
    const store = storeIn(dir, vi.fn());

    expect((await store.findForEmail('Me@EXAMPLE.com'))?.email).toBe('me@example.com');
    expect(await store.findForEmail('other@example.com')).toBeNull();
    expect(await store.findForEmail(null)).toBeNull();
    expect(await store.findForEmail('  ')).toBeNull();
  });
});

describe("getAccessToken and inspect — inspect describes getAccessToken's decision", () => {
  it("refreshes with the file's own client, caches, and re-refreshes inside the window", async () => {
    const dir = tempDir();
    writeCredential(dir, 'me@example.com');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(granted('access-1'))
      .mockResolvedValueOnce(granted('access-2'));
    const clock = { now: T0 };
    const store = storeIn(dir, fetchImpl, clock);
    const record = (await store.findForEmail('me@example.com'))!;

    expect(store.inspect(record).state).toBe('refresh_required');

    expect(await store.getAccessToken(record)).toBe('access-1');
    const body = new URLSearchParams(fetchImpl.mock.calls[0][1].body as string);
    expect(body.get('client_id')).toBe('desk-client');
    expect(body.get('client_secret')).toBe('desk-secret');
    expect(body.get('refresh_token')).toBe('rt-me@example.com');
    expect(body.get('grant_type')).toBe('refresh_token');

    const active = store.inspect(record);
    expect(active.state).toBe('active');
    expect(active.expiresAt).toBe(new Date(T0 + 3600 * 1000).toISOString());

    expect(await store.getAccessToken(record)).toBe('access-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Four minutes before expiry is inside the five-minute refresh window.
    clock.now = T0 + 56 * 60 * 1000;
    expect(store.inspect(record).state).toBe('refresh_required');
    expect(await store.getAccessToken(record)).toBe('access-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('remembers a permanent refusal against the file until the file changes', async () => {
    const dir = tempDir();
    const path = writeCredential(dir, 'me@example.com', new Date(T0 - 60_000));
    const invalidGrant =
      '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(refused(400, invalidGrant))
      .mockResolvedValueOnce(granted());
    const store = storeIn(dir, fetchImpl);
    const record = (await store.findForEmail('me@example.com'))!;

    await expect(store.getAccessToken(record)).rejects.toThrow(/invalid_grant/);
    await expect(store.getAccessToken(record)).rejects.toThrow(path);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const verdict = store.inspect(record);
    expect(verdict.state).toBe('unusable');
    expect(verdict.reason).toContain('invalid_grant');

    // A new login rewrites the file: the refusal no longer applies.
    writeCredential(dir, 'me@example.com', new Date(T0 + 60_000));
    const rewritten = (await store.findForEmail('me@example.com'))!;
    expect(store.inspect(rewritten).state).toBe('refresh_required');
    expect(await store.getAccessToken(rewritten)).toBe('access-1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not remember a transient failure or a network error', async () => {
    const dir = tempDir();
    writeCredential(dir, 'me@example.com');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(refused(503, 'upstream unavailable'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(granted());
    const store = storeIn(dir, fetchImpl);
    const record = (await store.findForEmail('me@example.com'))!;

    await expect(store.getAccessToken(record)).rejects.toThrow(/503/);
    expect(store.inspect(record).state).toBe('refresh_required');
    await expect(store.getAccessToken(record)).rejects.toThrow(/network/);
    expect(store.inspect(record).state).toBe('refresh_required');
    expect(await store.getAccessToken(record)).toBe('access-1');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('drops a cached token when the file is rewritten', async () => {
    const dir = tempDir();
    writeCredential(dir, 'me@example.com', new Date(T0 - 60_000));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(granted('access-1'))
      .mockResolvedValueOnce(granted('access-2'));
    const store = storeIn(dir, fetchImpl);
    const before = (await store.findForEmail('me@example.com'))!;
    expect(await store.getAccessToken(before)).toBe('access-1');

    writeCredential(dir, 'me@example.com', new Date(T0 + 60_000));
    const after = (await store.findForEmail('me@example.com'))!;
    expect(store.inspect(after).state).toBe('refresh_required');
    expect(await store.getAccessToken(after)).toBe('access-2');
  });
});
