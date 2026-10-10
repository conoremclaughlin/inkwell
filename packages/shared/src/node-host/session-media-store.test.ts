import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  mkdtemp,
  realpath,
  rm,
  readFile,
  writeFile,
  readdir,
  mkdir,
  symlink,
  chmod,
  stat,
} from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  SessionMediaStore,
  parseRetainedImageDescriptor,
  type RetainedImageResult,
} from './session-media-store.js';
import { MAX_INLINE_IMAGE_BYTES } from './tool-images.js';

const publication = vi.hoisted(() => ({
  inspect: vi.fn<(from: string, to: string) => Promise<void>>(),
}));
vi.mock('fs/promises', async (original) => {
  const fs = await original<typeof import('fs/promises')>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      await publication.inspect(from, to);
      return fs.rename(from, to);
    },
  };
});

let root: string;
const stores: SessionMediaStore[] = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ink-media-store-')));
  publication.inspect.mockReset();
});
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
  await rm(root, { recursive: true, force: true });
});
function store(name = 'session', limits: { maxFiles?: number; maxBytes?: number } = {}) {
  const s = new SessionMediaStore({ logPath: join(root, `${name}.jsonl`), ...limits });
  stores.push(s);
  return s;
}
function ok(result: RetainedImageResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result;
}
// Invented tiny GIF. Store validation measures the image header, not a decoder.
const image = (width = 1) =>
  Buffer.from([
    ...Buffer.from('GIF89a'),
    width & 255,
    width >> 8,
    1,
    0,
    0x80,
    0,
    0,
    0,
    0,
    0,
    255,
    255,
    255,
    0x2c,
    0,
    0,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    2,
    2,
    0x44,
    1,
    0,
    0x3b,
  ]);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('log-owned retained media (no live caller or collector)', () => {
  it('publishes complete private bytes atomically before returning a path-free descriptor', async () => {
    const bytes = image();
    const directory = join(root, 'session.jsonl.media');
    let publications = 0;
    publication.inspect.mockImplementation(async (from, to) => {
      if (!to.endsWith(digest(bytes))) return;
      publications++;
      expect(await readFile(from)).toEqual(bytes);
      await expect(readFile(to)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe('*\n');
    });
    const saved = ok(await store().put(bytes));
    expect(publications).toBe(1);
    expect(saved.descriptor).toEqual({
      version: 1,
      sha256: digest(bytes),
      byteLength: bytes.length,
      mimeType: 'image/gif',
      width: 1,
      height: 1,
    });
    expect(JSON.stringify(saved.descriptor)).not.toContain(root);
    expect(saved.image).toMatchObject({ ref: `img:${digest(bytes)}`, approxTokens: 1 });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(saved.image.path)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).sort()).toEqual(['.gitignore', digest(bytes)].sort());
  });

  it('dedupes only validated bytes; close/reopen restores without the original source', async () => {
    const first = store();
    const a = ok(await first.put(image()));
    const b = ok(await first.put(image()));
    expect(b).toEqual(a);
    await first.close();
    expect(await first.put(image())).toMatchObject({ ok: false, reason: 'closed' });
    const restored = ok(await store().restore(JSON.parse(JSON.stringify(a.descriptor))));
    expect(await readFile(restored.image.path)).toEqual(image());
    expect(restored).toEqual(a);
  });

  it('does not publish a descriptor or leave a hash name when rename fails', async () => {
    publication.inspect.mockImplementation(async (_from, to) => {
      if (!to.endsWith('.gitignore')) throw new Error('synthetic publication failure');
    });
    expect(await store().put(image())).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await readdir(join(root, 'session.jsonl.media'))).toEqual(['.gitignore']);
  });

  it('restores partial hash files only by publishing verified replacement bytes atomically', async () => {
    const s = store();
    const saved = ok(await s.put(image()));
    await writeFile(saved.image.path, image().subarray(0, 12));
    expect(await s.restore(saved.descriptor)).toMatchObject({
      ok: false,
      reason: 'unavailable',
      placeholder: expect.stringContaining('you have not seen it'),
    });
    publication.inspect.mockImplementation(async (from, to) => {
      expect(to).toBe(saved.image.path);
      expect(await readFile(to)).toHaveLength(12);
      expect(await readFile(from)).toEqual(image());
    });
    expect(ok(await s.put(image()))).toEqual(saved);
    expect(ok(await s.restore(saved.descriptor))).toEqual(saved);
    expect(await readFile(saved.image.path)).toEqual(image());
  });

  it('requires room for both the corrupt file and its staged replacement; a failed repair preserves the old file', async () => {
    const s = store('session', { maxFiles: 1 });
    const saved = ok(await s.put(image()));
    await writeFile(saved.image.path, image().subarray(0, 12));
    expect(await s.put(image())).toMatchObject({ ok: false, reason: 'quota' });
    expect(await readFile(saved.image.path)).toHaveLength(12);
    const retry = store(); // The old owner has stopped; one writer for this log.
    await s.close();
    publication.inspect.mockRejectedValue(new Error('synthetic repair publish failure'));
    expect(await retry.put(image())).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await readFile(saved.image.path)).toHaveLength(12);
    expect((await readdir(join(root, 'session.jsonl.media'))).sort()).toEqual(
      ['.gitignore', saved.descriptor.sha256].sort()
    );
  });

  it('verifies full hash, exact length and measured metadata on every restore', async () => {
    const s = store();
    const saved = ok(await s.put(image()));
    expect(await s.restore({ ...saved.descriptor, width: 2 })).toMatchObject({ ok: false });
    expect(await s.restore({ ...saved.descriptor, mimeType: 'image/png' })).toMatchObject({
      ok: false,
    });
    expect(await s.restore({ ...saved.descriptor, byteLength: image().length + 1 })).toMatchObject({
      ok: false,
    });
    const corrupt = image();
    corrupt[15] ^= 1;
    await writeFile(saved.image.path, corrupt);
    expect(await s.restore(saved.descriptor)).toMatchObject({ ok: false });
    await writeFile(saved.image.path, Buffer.concat([image(), Buffer.from([0])]));
    expect(await s.restore(saved.descriptor)).toMatchObject({ ok: false });
    await rm(saved.image.path);
    expect(await s.restore(saved.descriptor)).toMatchObject({ ok: false });
  });

  it('rejects path-bearing, traversal, malformed and over-bound descriptors', async () => {
    const saved = ok(await store().put(image()));
    for (const bad of [
      null,
      [],
      {},
      { ...saved.descriptor, path: '/private/anything' },
      { ...saved.descriptor, sha256: '../elsewhere' },
      { ...saved.descriptor, version: 2 },
      { ...saved.descriptor, byteLength: MAX_INLINE_IMAGE_BYTES + 1 },
      { ...saved.descriptor, width: 2001 },
      { ...saved.descriptor, height: 0 },
      { ...saved.descriptor, width: 1.5 },
      { ...saved.descriptor, mimeType: 'text/plain' },
    ]) {
      expect(parseRetainedImageDescriptor(bad)).toBeUndefined();
      expect(await store().restore(bad)).toMatchObject({ ok: false, reason: 'invalid_descriptor' });
    }
  });

  it('refuses symlinked roots/files and non-private media without following or changing them', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(root, 'linked.jsonl.media'));
    expect(await store('linked').put(image())).toMatchObject({ ok: false });
    expect(await readdir(outside)).toEqual([]);
    const s = store();
    const saved = ok(await s.put(image()));
    const target = join(outside, 'picture');
    await writeFile(target, image(), { mode: 0o600 });
    await rm(saved.image.path);
    await symlink(target, saved.image.path);
    expect(await s.restore(saved.descriptor)).toMatchObject({ ok: false });
    expect(await s.put(image())).toMatchObject({ ok: false });
    await rm(saved.image.path);
    await writeFile(saved.image.path, image(), { mode: 0o644 });
    expect(await s.restore(saved.descriptor)).toMatchObject({ ok: false });
    await chmod(join(root, 'session.jsonl.media'), 0o755);
    expect(await s.put(image(2))).toMatchObject({ ok: false });
    expect(await readFile(target)).toEqual(image());
  });

  it('refuses an unsafe ignore file before writing any image', async () => {
    const directory = join(root, 'session.jsonl.media');
    await mkdir(directory, { mode: 0o700 });
    const other = join(root, 'other-ignore');
    await writeFile(other, '*\n', { mode: 0o600 });
    await symlink(other, join(directory, '.gitignore'));
    expect(await store().put(image())).toMatchObject({ ok: false });
    expect(await readdir(directory)).toEqual(['.gitignore']);
    await rm(join(directory, '.gitignore'));
    await writeFile(join(directory, '.gitignore'), '!*.gif\n', { mode: 0o600 });
    expect(await store().put(image())).toMatchObject({ ok: false });
    expect(await readdir(directory)).toEqual(['.gitignore']);
  });

  it('counts orphan files/bytes without deleting them, while valid dedupe works at capacity', async () => {
    const s = store('session', { maxFiles: 2 });
    const saved = ok(await s.put(image()));
    const orphan = join(root, 'session.jsonl.media', '.pending-orphan');
    await writeFile(orphan, Buffer.alloc(10), { mode: 0o600 });
    expect(await s.put(image(2))).toMatchObject({ ok: false, reason: 'quota' });
    expect(ok(await s.put(image()))).toEqual(saved);
    await s.close();
    expect(await readFile(orphan)).toHaveLength(10);
    const byteLimited = store('bytes', { maxBytes: image().length + 9 });
    ok(await byteLimited.put(image()));
    expect(await byteLimited.put(image(2))).toMatchObject({ ok: false, reason: 'quota' });
  });

  it('bounds queued buffer copies, freezes callers bytes, and drains accepted writes on close', async () => {
    const s = store('session', { maxFiles: 1 });
    const original = image();
    const pending = s.put(original);
    original.fill(0);
    expect(await s.put(image(2))).toMatchObject({ ok: false, reason: 'quota' });
    const closing = s.close();
    expect(await s.put(image())).toMatchObject({ ok: false, reason: 'closed' });
    await closing;
    const saved = ok(await pending);
    expect(await readFile(saved.image.path)).toEqual(image());
    expect(await store().restore(saved.descriptor)).toMatchObject({ ok: true });
  });

  it('serializes distinct concurrent writes against the disk cap', async () => {
    const s = store('session', { maxFiles: 2 });
    ok(await s.put(image()));
    const results = await Promise.all([s.put(image(2)), s.put(image(3))]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1]).toMatchObject({ reason: 'quota' });
  });

  it("isolates two logs with the same bytes and never adopts another log's path", async () => {
    const a = store('a'),
      b = store('b');
    const savedA = ok(await a.put(image()));
    expect(await b.restore(savedA.descriptor)).toMatchObject({ ok: false });
    const savedB = ok(await b.put(image()));
    expect(savedB.image.path).not.toBe(savedA.image.path);
    await rm(savedA.image.path);
    expect(await a.restore(savedA.descriptor)).toMatchObject({ ok: false });
    expect(await b.restore(savedB.descriptor)).toMatchObject({ ok: true });
  });

  it('is ignored by ordinary git add in a repository with no pre-existing Ink rules', async () => {
    const run = promisify(execFile);
    await run('git', ['init', '-q', root]);
    const saved = ok(await store().put(image()));
    await run('git', ['check-ignore', saved.image.path], { cwd: root });
    await run('git', ['add', '.'], { cwd: root });
    const { stdout } = await run('git', ['diff', '--cached', '--name-only'], { cwd: root });
    expect(stdout).toBe('');
  });

  it('rejects oversized/unmeasurable images and unreasonable configuration without media writes', async () => {
    const s = store();
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from('not an image'),
      image(2001),
      image(0),
      Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1),
    ]) {
      expect(await s.put(bytes)).toMatchObject({ ok: false, reason: 'invalid_image' });
    }
    expect(await readdir(root)).toEqual([]);
    expect(() => new SessionMediaStore({ logPath: 'relative.jsonl' })).toThrow();
    for (const limits of [
      { maxFiles: 0 },
      { maxFiles: 65 },
      { maxBytes: Infinity },
      { maxBytes: 0 },
    ])
      expect(() => store('bad', limits)).toThrow();
  });
});
