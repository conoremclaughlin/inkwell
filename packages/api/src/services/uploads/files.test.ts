import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readUploadFile, removeUploadBytes, sha256Hex, writeUploadFile } from './files.js';
import { createHash, webcrypto } from 'crypto';
import {
  prepareUploadsRoot,
  uploadDirPath,
  uploadFilePath,
  type UploadLocation,
} from './layout.js';

const USER = '0b6f3f7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const WORKSPACE = '1c7a4b8f-2d3e-4f5a-9b0c-1d2e3f4a5b6c';
const UPLOAD = '2d8b5c9a-3e4f-4a5b-8c1d-2e3f4a5b6c7d';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe('upload files', () => {
  let base: string;
  let root: string;
  let outside: string;
  const loc: UploadLocation = {
    userId: USER,
    workspaceId: WORKSPACE,
    uploadId: UPLOAD,
    ext: 'jpg',
  };

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'uploads-files-')));
    const prepared = await prepareUploadsRoot(join(base, 'uploads'), base, []);
    if (!prepared.ok) throw new Error(prepared.detail);
    root = prepared.rootReal;
    outside = join(base, 'outside');
    mkdirSync(outside);
  });

  afterEach(() => {
    // Read-only directories must be opened up before they can be removed.
    for (const dir of [root, join(root, USER), join(root, USER, WORKSPACE)]) {
      if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          if (lstatSync(p).isDirectory()) chmodSync(p, 0o700);
        }
      }
    }
    rmSync(base, { recursive: true, force: true });
  });

  const write = () => writeUploadFile(root, loc, JPEG);
  const JPEG_SHA = createHash('sha256').update(JPEG).digest('hex');
  const expected = { byteSize: JPEG.length, sha256: JPEG_SHA };

  describe('writeUploadFile', () => {
    it('places the bytes in a read-only directory of their own and leaves staging empty', async () => {
      const result = await write();
      expect(result).toEqual({
        ok: true,
        path: uploadFilePath(root, loc),
        byteSize: JPEG.length,
        sha256: JPEG_SHA,
      });
      const file = uploadFilePath(root, loc)!;
      expect(readFileSync(file).equals(JPEG)).toBe(true);
      expect(lstatSync(file).mode & 0o777).toBe(0o400);
      expect(lstatSync(uploadDirPath(root, loc)!).mode & 0o777).toBe(0o500);
      expect(lstatSync(join(root, USER)).mode & 0o777).toBe(0o700);
      expect(readdirSync(join(root, '.staging'))).toEqual([]);
    });

    it('never reuses an existing upload directory', async () => {
      await write();
      expect(await write()).toEqual({ ok: false, reason: 'exists' });
      expect(readdirSync(join(root, '.staging'))).toEqual([]);
      expect(readFileSync(uploadFilePath(root, loc)!).equals(JPEG)).toBe(true);
    });

    it('creates nothing through a symlinked user directory', async () => {
      symlinkSync(outside, join(root, USER));
      expect(await write()).toEqual({ ok: false, reason: 'symlinked' });
      expect(readdirSync(outside)).toEqual([]);
      expect(readdirSync(join(root, '.staging'))).toEqual([]);
    });

    it('refuses a staging name that already exists, and leaves it alone', async () => {
      const target = join(outside, 'target');
      writeFileSync(target, 'untouched');
      symlinkSync(target, join(root, '.staging', `${UPLOAD}.part`));
      expect(await write()).toMatchObject({ ok: false, reason: 'failed' });
      expect(readFileSync(target, 'utf8')).toBe('untouched');
      expect(lstatSync(join(root, '.staging', `${UPLOAD}.part`)).isSymbolicLink()).toBe(true);
    });

    it('refuses a location that is not made of server ids', async () => {
      expect(await writeUploadFile(root, { ...loc, uploadId: '../x' }, JPEG)).toEqual({
        ok: false,
        reason: 'bad-location',
      });
    });
  });

  it('hashes with the thread-pool digest, matching sha256, for writes and reads', async () => {
    expect(await sha256Hex(JPEG)).toBe(JPEG_SHA);
    const digest = vi.spyOn(webcrypto.subtle, 'digest');
    try {
      await write();
      await readUploadFile(root, loc, expected);
      expect(digest).toHaveBeenCalledTimes(2);
    } finally {
      digest.mockRestore();
    }
  });

  describe('readUploadFile', () => {
    it('reads back exactly what was written', async () => {
      await write();
      const read = await readUploadFile(root, loc, expected);
      expect(read.ok && read.bytes.equals(JPEG)).toBe(true);
    });

    it('reports a missing file as missing', async () => {
      expect(await readUploadFile(root, loc, expected)).toEqual({ ok: false, reason: 'missing' });
    });

    it('marks changed bytes, or a changed size, as damaged', async () => {
      await write();
      const file = uploadFilePath(root, loc)!;
      chmodSync(file, 0o600);
      const changed = Buffer.from(JPEG);
      changed[changed.length - 1] ^= 0xff;
      writeFileSync(file, changed);
      expect(await readUploadFile(root, loc, expected)).toEqual({ ok: false, reason: 'damaged' });
      writeFileSync(file, Buffer.concat([JPEG, Buffer.from([0])]));
      expect(await readUploadFile(root, loc, expected)).toEqual({ ok: false, reason: 'damaged' });
    });

    it('refuses a symlink anywhere on the way down, even one that stays inside the root', async () => {
      await write();
      const dir = uploadDirPath(root, loc)!;
      const file = uploadFilePath(root, loc)!;
      // The file swapped for a link to an identical copy elsewhere in the root.
      chmodSync(dir, 0o700);
      const copy = join(root, 'copy.jpg');
      writeFileSync(copy, JPEG);
      unlinkSync(file);
      symlinkSync(copy, file);
      expect(await readUploadFile(root, loc, expected)).toEqual({ ok: false, reason: 'symlinked' });

      // A directory on the way down swapped for a link.
      rmSync(join(root, USER), { recursive: true, force: true });
      mkdirSync(join(outside, WORKSPACE, UPLOAD), { recursive: true });
      writeFileSync(join(outside, WORKSPACE, UPLOAD, `${UPLOAD}.jpg`), JPEG);
      symlinkSync(outside, join(root, USER));
      expect(await readUploadFile(root, loc, expected)).toEqual({ ok: false, reason: 'symlinked' });
    });

    it('refuses a hard-linked file and a directory where the file should be', async () => {
      await write();
      const file = uploadFilePath(root, loc)!;
      linkSync(file, join(root, 'alias.jpg'));
      expect(await readUploadFile(root, loc, expected)).toEqual({
        ok: false,
        reason: 'hard-linked',
      });
      unlinkSync(join(root, 'alias.jpg'));

      chmodSync(uploadDirPath(root, loc)!, 0o700);
      unlinkSync(file);
      mkdirSync(file);
      expect(await readUploadFile(root, loc, expected)).toEqual({
        ok: false,
        reason: 'not-a-file',
      });
    });

    it('refuses a location that is not made of server ids', async () => {
      expect(await readUploadFile(root, { ...loc, userId: '..' }, expected)).toEqual({
        ok: false,
        reason: 'bad-location',
      });
    });
  });

  describe('removeUploadBytes', () => {
    it('removes the file, its directory and any staging file, and absent is gone', async () => {
      await write();
      const staging = join(root, '.staging', `${UPLOAD}.part`);
      writeFileSync(staging, 'partial');
      expect(await removeUploadBytes(root, loc)).toEqual({ gone: true });
      expect(existsSync(uploadDirPath(root, loc)!)).toBe(false);
      expect(existsSync(staging)).toBe(false);
      expect(await removeUploadBytes(root, loc)).toEqual({ gone: true });
    });

    it('removes a staging file left by a write that never placed its bytes', async () => {
      const staging = join(root, '.staging', `${UPLOAD}.part`);
      writeFileSync(staging, 'partial');
      expect(await removeUploadBytes(root, loc)).toEqual({ gone: true });
      expect(existsSync(staging)).toBe(false);
    });

    it('is not gone while anything is left, so the row keeps its slots', async () => {
      await write();
      const dir = uploadDirPath(root, loc)!;
      chmodSync(dir, 0o700);
      writeFileSync(join(dir, 'unexpected'), 'x');
      expect(await removeUploadBytes(root, loc)).toMatchObject({ gone: false, reason: 'failed' });
      expect(existsSync(dir)).toBe(true);
      // The next pass, once the obstacle is gone, finishes the removal.
      unlinkSync(join(dir, 'unexpected'));
      expect(await removeUploadBytes(root, loc)).toEqual({ gone: true });
    });

    it('is not gone when the staging file cannot be removed', async () => {
      const staging = join(root, '.staging', `${UPLOAD}.part`);
      mkdirSync(staging);
      writeFileSync(join(staging, 'x'), 'x');
      expect(await removeUploadBytes(root, loc)).toMatchObject({ gone: false, reason: 'failed' });
    });

    it('touches nothing through a symlinked directory', async () => {
      mkdirSync(join(outside, WORKSPACE, UPLOAD), { recursive: true });
      const victim = join(outside, WORKSPACE, UPLOAD, `${UPLOAD}.jpg`);
      writeFileSync(victim, JPEG);
      symlinkSync(outside, join(root, USER));
      expect(await removeUploadBytes(root, loc)).toEqual({ gone: false, reason: 'symlinked' });
      expect(existsSync(victim)).toBe(true);
    });

    it('refuses a location that is not made of server ids', async () => {
      expect(await removeUploadBytes(root, { ...loc, uploadId: '../uploads' })).toEqual({
        gone: false,
        reason: 'bad-location',
      });
    });
  });
});
