import { describe, it, expect } from 'vitest';
import { expandHomePath, isWithinRoots, resolveAllowedMediaPath } from './media-path';

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
