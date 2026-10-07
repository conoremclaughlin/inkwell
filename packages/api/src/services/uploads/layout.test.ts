import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  canonicalPath,
  isCanonicalId,
  isWithin,
  pathsOverlap,
  prepareUploadsRoot,
  stagingFilePath,
  uploadDirPath,
  uploadFilePath,
  uploadSegments,
} from './layout.js';

const USER = '0b6f3f7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const WORKSPACE = '1c7a4b8f-2d3e-4f5a-9b0c-1d2e3f4a5b6c';
const UPLOAD = '2d8b5c9a-3e4f-4a5b-8c1d-2e3f4a5b6c7d';
const loc = { userId: USER, workspaceId: WORKSPACE, uploadId: UPLOAD, ext: 'jpg' as const };

describe('upload paths', () => {
  it('builds every segment from server ids and the sniffed extension', () => {
    expect(uploadSegments(loc)).toEqual([USER, WORKSPACE, UPLOAD, `${UPLOAD}.jpg`]);
    expect(uploadFilePath('/r', loc)).toBe(`/r/${USER}/${WORKSPACE}/${UPLOAD}/${UPLOAD}.jpg`);
    expect(uploadDirPath('/r', loc)).toBe(`/r/${USER}/${WORKSPACE}/${UPLOAD}`);
    expect(stagingFilePath('/r', UPLOAD)).toBe(`/r/.staging/${UPLOAD}.part`);
  });

  it('names no path for anything that is not a canonical id or a known extension', () => {
    for (const bad of [
      { ...loc, userId: '..' },
      { ...loc, workspaceId: `${WORKSPACE}/..` },
      { ...loc, uploadId: UPLOAD.toUpperCase() },
      { ...loc, uploadId: `${UPLOAD}\0` },
      { ...loc, uploadId: '' },
      { ...loc, ext: 'html' as never },
      { ...loc, ext: 'jpg/../x' as never },
    ]) {
      expect(uploadSegments(bad)).toBeNull();
      expect(uploadFilePath('/r', bad)).toBeNull();
      expect(uploadDirPath('/r', bad)).toBeNull();
    }
    expect(stagingFilePath('/r', '../x')).toBeNull();
    expect(isCanonicalId(UPLOAD)).toBe(true);
    expect(isCanonicalId(` ${UPLOAD}`)).toBe(false);
    expect(isCanonicalId(42)).toBe(false);
  });
});

describe('isWithin and pathsOverlap', () => {
  it('is true for the same path and for descendants, in either direction for overlap', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b/c')).toBe(true);
    expect(isWithin('/a/b/c', '/a/b')).toBe(false);
    expect(pathsOverlap('/a/b/c', '/a/b')).toBe(true);
    expect(isWithin('/', '/anything')).toBe(true);
  });

  it('does not treat a sibling sharing a prefix, or a name starting with dots, as inside', () => {
    expect(pathsOverlap('/home/u/.ink/files', '/home/u/.ink/files-uploads')).toBe(false);
    expect(pathsOverlap('/home/u/.ink/uploads', '/home/u/.ink/files')).toBe(false);
    expect(isWithin('/a', '/a/..b')).toBe(true);
    expect(isWithin('/a/b', '/a/..b')).toBe(false);
  });
});

describe('prepareUploadsRoot', () => {
  let base: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'uploads-layout-')));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('creates a private root with a canonical staging directory', async () => {
    const root = join(base, 'uploads');
    const files = join(base, 'files');
    const result = await prepareUploadsRoot(root, base, [files]);
    expect(result).toEqual({ ok: true, rootReal: root, stagingReal: join(root, '.staging') });
  });

  it('refuses a root inside a listed neighbour, and one containing it', async () => {
    const files = join(base, 'outer', 'files');
    // Private, so only the overlap can refuse it.
    mkdirSync(files, { recursive: true, mode: 0o700 });
    const inside = await prepareUploadsRoot(join(files, 'uploads'), base, [files]);
    expect(inside).toMatchObject({ ok: false, reason: 'overlaps' });
    const around = await prepareUploadsRoot(join(base, 'outer'), base, [files]);
    expect(around).toMatchObject({ ok: false, reason: 'overlaps' });
    const same = await prepareUploadsRoot(files, base, [files]);
    expect(same).toMatchObject({ ok: false, reason: 'overlaps' });
  });

  it('compares a neighbour given through a symlink at its target', async () => {
    const real = join(base, 'real-files');
    mkdirSync(real, { mode: 0o700 });
    const link = join(base, 'files-link');
    symlinkSync(real, link);
    expect(await prepareUploadsRoot(join(real, 'uploads'), base, [link])).toMatchObject({
      ok: false,
      reason: 'overlaps',
    });
  });

  it('compares by realpath, so a symlinked root that lands in a neighbour is refused', async () => {
    const files = join(base, 'files');
    mkdirSync(join(files, 'real-uploads'), { recursive: true, mode: 0o700 });
    const link = join(base, 'uploads-link');
    symlinkSync(join(files, 'real-uploads'), link);
    expect(await prepareUploadsRoot(link, base, [files])).toMatchObject({
      ok: false,
      reason: 'overlaps',
    });
  });

  it('compares against a neighbour that does not exist yet, where it would be created', async () => {
    const result = await prepareUploadsRoot(join(base, 'later', 'files', 'uploads'), base, [
      join(base, 'later', 'files'),
    ]);
    expect(result).toMatchObject({ ok: false, reason: 'overlaps' });
    expect(await canonicalPath(join(base, 'no', 'such', '..', 'path'))).toBe(
      join(base, 'no', 'path')
    );
  });

  it('refuses, rather than throws, when a neighbour cannot be resolved', async () => {
    const locked = join(base, 'locked');
    mkdirSync(join(locked, 'files'), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      expect(
        await prepareUploadsRoot(join(base, 'uploads'), base, [join(locked, 'files')])
      ).toMatchObject({
        ok: false,
        reason: 'unavailable',
      });
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('refuses a root other users can reach', async () => {
    const root = join(base, 'shared');
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o750);
    expect(await prepareUploadsRoot(root, base, [])).toMatchObject({
      ok: false,
      reason: 'not-private',
    });
  });

  it('refuses a relative root and a root that is a file', async () => {
    expect(await prepareUploadsRoot('uploads', base, [])).toMatchObject({
      ok: false,
      reason: 'not-absolute',
    });
    const file = join(base, 'file');
    writeFileSync(file, 'x');
    expect(await prepareUploadsRoot(file, base, [])).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('refuses a staging directory that is a symlink', async () => {
    const root = join(base, 'uploads');
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(join(base, 'elsewhere'));
    symlinkSync(join(base, 'elsewhere'), join(root, '.staging'));
    expect(await prepareUploadsRoot(root, base, [])).toMatchObject({
      ok: false,
      reason: 'staging-not-canonical',
    });
  });

  describe('inside the data directory', () => {
    let data: string;

    beforeEach(() => {
      data = join(base, 'ink');
      mkdirSync(data, { mode: 0o700 });
    });

    it('accepts a root inside it', async () => {
      expect(await prepareUploadsRoot(join(data, 'uploads'), data, [])).toMatchObject({
        ok: true,
        rootReal: join(data, 'uploads'),
      });
    });

    it('refuses a root outside it, or the directory itself, and creates nothing', async () => {
      const outside = join(base, 'uploads');
      expect(await prepareUploadsRoot(outside, data, [])).toMatchObject({
        ok: false,
        reason: 'outside-data-dir',
      });
      expect(existsSync(outside)).toBe(false);
      expect(await prepareUploadsRoot(data, data, [])).toMatchObject({
        ok: false,
        reason: 'outside-data-dir',
      });
      expect(await prepareUploadsRoot(`${data}-sibling/uploads`, data, [])).toMatchObject({
        ok: false,
        reason: 'outside-data-dir',
      });
    });

    it('refuses a root that a link inside it leads out of, and creates nothing there', async () => {
      const elsewhere = join(base, 'elsewhere');
      mkdirSync(elsewhere, { mode: 0o700 });
      symlinkSync(elsewhere, join(data, 'uploads'));
      for (const root of [join(data, 'uploads'), join(data, 'uploads', 'deeper')]) {
        expect(await prepareUploadsRoot(root, data, []), root).toMatchObject({
          ok: false,
          reason: 'outside-data-dir',
        });
      }
      expect(existsSync(join(elsewhere, 'deeper'))).toBe(false);
    });

    it('compares a data directory given through a link at its target', async () => {
      const link = join(base, 'ink-link');
      symlinkSync(data, link);
      expect(await prepareUploadsRoot(join(data, 'uploads'), link, [])).toMatchObject({
        ok: true,
      });
      expect(await prepareUploadsRoot(join(base, 'uploads'), link, [])).toMatchObject({
        ok: false,
        reason: 'outside-data-dir',
      });
    });
  });
});
