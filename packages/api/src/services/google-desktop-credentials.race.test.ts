/**
 * Lumen's review repro (PR #588): an atomic re-login racing a listing.
 *
 * The seam replaces module-level fs/promises readFile/stat with a pair that
 * lets a rename land between them. The store now reads content and metadata
 * from ONE open handle, so the seam has nothing to split — and if anyone
 * reverts to separate readFile/stat calls, this test re-engages and fails.
 */

import { mkdtemp, writeFile, rename, rm, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({
  read: null as Promise<unknown> | null,
  replace: null as (() => Promise<void>) | null,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs/promises')>();
  return {
    ...fs,
    readFile: (...args: Parameters<typeof fs.readFile>) => {
      const read = fs.readFile(...args);
      race.read = read;
      return read;
    },
    stat: async (...args: Parameters<typeof fs.stat>) => {
      if (race.replace) {
        const replace = race.replace;
        race.replace = null;
        await race.read;
        await replace();
      }
      return fs.stat(...args);
    },
  };
});
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const { DesktopGoogleCredentialStore } = await import('./google-desktop-credentials');

const dirs: string[] = [];
afterEach(async () => {
  race.replace = null;
  race.read = null;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Lumen review: atomic replacement while reading', () => {
  it('does not pin the old refresh refusal to the replacement login', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lumen-google-race-'));
    dirs.push(dir);
    const path = join(dir, 'me@example.com.json');
    const credential = (refresh_token: string) =>
      JSON.stringify({
        type: 'authorized_user',
        email: 'me@example.com',
        client_id: 'client',
        client_secret: 'secret',
        refresh_token,
        scopes: [],
      });
    const oldTime = new Date('2026-09-08T12:00:00Z');
    const newTime = new Date('2026-09-08T12:01:00Z');
    await writeFile(path, credential('old-revoked'));
    await utimes(path, oldTime, oldTime);
    race.replace = async () => {
      const tempPath = path + '.tmp';
      await writeFile(tempPath, credential('new-valid'));
      await utimes(tempPath, newTime, newTime);
      await rename(tempPath, path);
    };
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const token = new URLSearchParams(String(init?.body)).get('refresh_token');
      return token === 'new-valid'
        ? new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }))
        : new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    });
    const store = new DesktopGoogleCredentialStore({ dir, fetchImpl });
    const raced = (await store.findForEmail('me@example.com')).record!;
    // An old snapshot can legitimately fail, or a retry can use the new one.
    // What must not happen is caching the OLD refusal against the NEW login.
    await store.getAccessToken(raced).catch(() => null);
    // The store reads through one open handle, so the seam above never fires
    // and the replacement must be applied here instead. Should the listing
    // ever go back to separate readFile/stat calls, the seam fires mid-listing
    // and this branch is skipped — either way the property below must hold.
    if (race.replace) {
      const replace = race.replace;
      race.replace = null;
      await replace();
    }
    const fresh = (await store.findForEmail('me@example.com')).record!;
    expect(fresh.credential.refresh_token).toBe('new-valid');
    await expect(store.getAccessToken(fresh)).resolves.toBe('new-access');
  });
});
