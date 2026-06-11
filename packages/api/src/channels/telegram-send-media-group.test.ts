/**
 * sendMediaGroup form construction
 *
 * Verifies the Telegram album payload: files attached via multipart with
 * attach://<name> references in the media JSON, per the Bot API's
 * sendMediaGroup contract (2-10 photos/videos per album).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config/env', () => ({
  env: {
    TELEGRAM_BOT_TOKEN: 'test-token',
    LOG_LEVEL: 'info',
    // Transitive: TelegramListener pulls in AuthorizationService, which
    // constructs a Supabase client at module init
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SECRET_KEY: 'test-secret-key',
    SUPABASE_PUBLISHABLE_KEY: 'test-pub-key',
  },
}));

import { createTelegramListener } from './telegram-listener.js';

describe('TelegramListener.sendMediaGroup', () => {
  let dir: string;
  let photoA: string;
  let photoB: string;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tg-album-test-'));
    photoA = join(dir, 'a.jpg');
    photoB = join(dir, 'b.png');
    await writeFile(photoA, Buffer.alloc(64, 1));
    await writeFile(photoB, Buffer.alloc(64, 2));
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      json: async () => ({ ok: true, result: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it('posts to sendMediaGroup with attach:// references and per-item captions', async () => {
    const listener = createTelegramListener({ token: 'test-token' });

    await listener.sendMediaGroup('telegram:12345', [
      { filePath: photoA, type: 'image', caption: 'first', contentType: 'image/jpeg' },
      { filePath: photoB, type: 'image', contentType: 'image/png' },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/sendMediaGroup');

    const form = init.body as FormData;
    expect(form.get('chat_id')).toBe('12345');
    const mediaSpec = JSON.parse(String(form.get('media')));
    expect(mediaSpec).toEqual([
      { type: 'photo', media: 'attach://media0', caption: 'first' },
      { type: 'photo', media: 'attach://media1' },
    ]);
    // The referenced files ride the same multipart form
    expect(form.get('media0')).toBeInstanceOf(Blob);
    expect(form.get('media1')).toBeInstanceOf(Blob);
  });

  it('maps video items to type video', async () => {
    const listener = createTelegramListener({ token: 'test-token' });

    await listener.sendMediaGroup('99', [
      { filePath: photoA, type: 'image' },
      { filePath: photoB, type: 'video', contentType: 'video/mp4' },
    ]);

    const form = fetchMock.mock.calls[0][1].body as FormData;
    const mediaSpec = JSON.parse(String(form.get('media')));
    expect(mediaSpec.map((m: { type: string }) => m.type)).toEqual(['photo', 'video']);
  });

  it('rejects item counts outside 2-10', async () => {
    const listener = createTelegramListener({ token: 'test-token' });

    await expect(
      listener.sendMediaGroup('99', [{ filePath: photoA, type: 'image' }])
    ).rejects.toThrow(/2-10/);
    await expect(
      listener.sendMediaGroup(
        '99',
        Array.from({ length: 11 }, () => ({ filePath: photoA, type: 'image' as const }))
      )
    ).rejects.toThrow(/2-10/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces Telegram API errors', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ ok: false, description: 'flood control exceeded' }),
    });
    const listener = createTelegramListener({ token: 'test-token' });

    await expect(
      listener.sendMediaGroup('99', [
        { filePath: photoA, type: 'image' },
        { filePath: photoB, type: 'image' },
      ])
    ).rejects.toThrow(/flood control exceeded/);
  });
});
