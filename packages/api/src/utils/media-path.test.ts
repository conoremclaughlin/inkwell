import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsPromises } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  expandHomePath,
  isWithinRoots,
  openVerifiedMedia,
  resolveAllowedMediaPath,
} from './media-path';

const execFileAsync = promisify(execFile);

const HOME = '/Users/conor';
const REPO = '/Users/conor/ws/inkwell';
const ROOTS = ['/Users/conor/.ink/files', '/Users/conor/ws/inkwell/docs/screenshots'];

describe('resolveAllowedMediaPath', () => {
  it('serves the three real evidence path shapes: ~, absolute, repo-relative', () => {
    expect(
      resolveAllowedMediaPath('~/.ink/files/wren-screenshots/a.jpeg', ROOTS, HOME, REPO)
    ).toEqual({
      absolutePath: '/Users/conor/.ink/files/wren-screenshots/a.jpeg',
      mediaType: 'image',
    });
    expect(
      resolveAllowedMediaPath('/Users/conor/.ink/files/telegram/video.mp4', ROOTS, HOME, REPO)
    ).toEqual({
      absolutePath: '/Users/conor/.ink/files/telegram/video.mp4',
      mediaType: 'video',
    });
    expect(
      resolveAllowedMediaPath('docs/screenshots/pr-547/above-fold.jpeg', ROOTS, HOME, REPO)
    ).toEqual({
      absolutePath: '/Users/conor/ws/inkwell/docs/screenshots/pr-547/above-fold.jpeg',
      mediaType: 'image',
    });
  });

  it('refuses traversal, however it is spelled', () => {
    expect(
      resolveAllowedMediaPath('~/.ink/files/../../.ssh/id_rsa.png', ROOTS, HOME, REPO)
    ).toBeNull();
    expect(
      resolveAllowedMediaPath('docs/screenshots/../../.env.local.png', ROOTS, HOME, REPO)
    ).toBeNull();
    expect(resolveAllowedMediaPath('../outside/a.jpeg', ROOTS, HOME, REPO)).toBeNull();
  });

  it('refuses paths outside every root even without traversal', () => {
    expect(resolveAllowedMediaPath('/etc/passwd.png', ROOTS, HOME, REPO)).toBeNull();
    expect(resolveAllowedMediaPath('~/Desktop/photo.jpeg', ROOTS, HOME, REPO)).toBeNull();
    // Prefix-sibling directory: /Users/conor/.ink/files-evil must not match
    // the /Users/conor/.ink/files root by string prefix.
    expect(
      resolveAllowedMediaPath('/Users/conor/.ink/files-evil/a.jpeg', ROOTS, HOME, REPO)
    ).toBeNull();
  });

  it('refuses non-media extensions and malformed input inside the roots', () => {
    expect(resolveAllowedMediaPath('~/.ink/files/secrets/auth.json', ROOTS, HOME, REPO)).toBeNull();
    expect(resolveAllowedMediaPath('', ROOTS, HOME, REPO)).toBeNull();
    expect(resolveAllowedMediaPath('~/.ink/files/a.jpeg\0.txt', ROOTS, HOME, REPO)).toBeNull();
  });
});

describe('isWithinRoots', () => {
  it('containment is segment-aware, not string-prefix', () => {
    expect(isWithinRoots('/Users/conor/.ink/files/x.png', ROOTS)).toBe(true);
    expect(isWithinRoots('/Users/conor/.ink/files', ROOTS)).toBe(true);
    expect(isWithinRoots('/Users/conor/.ink/files-evil/x.png', ROOTS)).toBe(false);
  });
});

describe('expandHomePath', () => {
  it('expands only a leading tilde segment', () => {
    expect(expandHomePath('~/.ink/files/a.png', HOME)).toBe('/Users/conor/.ink/files/a.png');
    expect(expandHomePath('/abs/path.png', HOME)).toBe('/abs/path.png');
    expect(expandHomePath('rel/~x/path.png', HOME)).toBe('rel/~x/path.png');
  });
});

/**
 * The descriptor pipeline against REAL files — each rejection case is one
 * of the validate-then-reopen holes from the PR #551 review, reproduced as
 * a fixture: hard link to outside content, symlink extension spoof
 * (png -> html), symlink escape, FIFO, and root-resolution independence.
 */
describe('openVerifiedMedia (real filesystem fixtures)', () => {
  let fixtureBase: string;
  let root: string;
  let outside: string;
  const roots = () => [root];

  const openAt = (requestedPath: string, allowedRoots: string[] = roots()) =>
    openVerifiedMedia(requestedPath, allowedRoots, '/nonexistent-home', fixtureBase);

  beforeAll(async () => {
    fixtureBase = await fsPromises.mkdtemp(join(tmpdir(), 'media-path-test-'));
    root = join(fixtureBase, 'allowed');
    outside = join(fixtureBase, 'outside');
    await fsPromises.mkdir(root, { recursive: true });
    await fsPromises.mkdir(outside, { recursive: true });

    await fsPromises.writeFile(join(root, 'legit.jpeg'), Buffer.from('jpeg-bytes'));
    await fsPromises.writeFile(join(outside, 'secret.jpeg'), Buffer.from('outside-secret'));
    await fsPromises.writeFile(join(root, 'payload.html'), '<script>alert(1)</script>');

    // Hard link INSIDE the root to OUTSIDE content: every path-based check
    // sees an in-root file, but the inode is the outside file's.
    await fsPromises.link(join(outside, 'secret.jpeg'), join(root, 'leak.jpeg'));
    // Extension spoof: requested/served name says png, canonical target is HTML.
    await fsPromises.symlink(join(root, 'payload.html'), join(root, 'preview.png'));
    // Plain symlink escape to an outside media file.
    await fsPromises.symlink(join(outside, 'secret.jpeg'), join(root, 'escape.jpeg'));
  });

  afterAll(async () => {
    await fsPromises.rm(fixtureBase, { recursive: true, force: true });
  });

  it('serves a regular in-root file with size and canonical content type', async () => {
    const media = await openAt(join(root, 'legit.jpeg'));
    expect(media).not.toBeNull();
    expect(media!.mediaType).toBe('image');
    expect(media!.contentType).toBe('image/jpeg');
    expect(media!.size).toBe(Buffer.from('jpeg-bytes').length);
    const served = await media!.handle.readFile();
    expect(served.toString()).toBe('jpeg-bytes');
    await media!.handle.close();
  });

  it('refuses a hard link inside the root to outside content (nlink > 1)', async () => {
    expect(await openAt(join(root, 'leak.jpeg'))).toBeNull();
  });

  it('refuses the png -> html extension spoof: type comes from the canonical target', async () => {
    expect(await openAt(join(root, 'preview.png'))).toBeNull();
  });

  it('refuses a symlink escaping the root even when the target is media', async () => {
    expect(await openAt(join(root, 'escape.jpeg'))).toBeNull();
  });

  it('refuses a FIFO with a media name — never opens blocking, never serves a non-file', async () => {
    const fifoPath = join(root, 'pipe.jpeg');
    try {
      await execFileAsync('mkfifo', [fifoPath]);
    } catch {
      return; // platform without mkfifo — the guard is still covered by isFile()
    }
    expect(await openAt(fifoPath)).toBeNull();
  });

  it('one missing root never disables the others', async () => {
    const media = await openAt(join(root, 'legit.jpeg'), [
      join(fixtureBase, 'does-not-exist'),
      root,
    ]);
    expect(media).not.toBeNull();
    await media!.handle.close();
  });
});
