/**
 * Ephemeral studio root derivation (spec:studio-materialization v8).
 *
 * The contract these pin: `<root>/<agent>/<project>/<leaf>`, where the root
 * honors INK_STUDIOS_ROOT, segments are filesystem- and traversal-safe, and
 * the leaf preserves the DB slug byte-for-byte for well-formed slugs —
 * collapsing its `--` would alias two different studios onto one directory.
 */

import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import { homedir } from 'os';
import { inkStudiosRoot, ephemeralWorktreePath, studioPathSegment } from './studio-paths';

const ORIGINAL = process.env.INK_STUDIOS_ROOT;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.INK_STUDIOS_ROOT;
  else process.env.INK_STUDIOS_ROOT = ORIGINAL;
});

describe('inkStudiosRoot', () => {
  it('defaults to ~/.ink/studios', () => {
    delete process.env.INK_STUDIOS_ROOT;
    expect(inkStudiosRoot()).toBe(path.join(homedir(), '.ink', 'studios'));
  });

  it('honors the INK_STUDIOS_ROOT override (tests, isolated servers)', () => {
    process.env.INK_STUDIOS_ROOT = '/tmp/alt-root';
    expect(inkStudiosRoot()).toBe('/tmp/alt-root');
  });
});

describe('ephemeralWorktreePath', () => {
  it('derives <root>/<agent>/<project>/<leaf>', () => {
    process.env.INK_STUDIOS_ROOT = '/tmp/studios';
    expect(
      ephemeralWorktreePath({
        agentId: 'wren',
        repoRoot: '/Users/conor/ws/pcp/inkwell',
        leaf: 'wren-omega--pr-537',
      })
    ).toBe('/tmp/studios/wren/inkwell/wren-omega--pr-537');
  });

  it('preserves the DB slug byte-for-byte as the leaf, double hyphens included', () => {
    process.env.INK_STUDIOS_ROOT = '/tmp/studios';
    const p = ephemeralWorktreePath({
      agentId: 'lumen',
      repoRoot: '/ws/inkwell',
      leaf: 'lumen-review--pr-476-h1a2b3c',
    });
    expect(path.basename(p)).toBe('lumen-review--pr-476-h1a2b3c');
  });

  it('falls back to safe segment names when inputs are empty or missing', () => {
    process.env.INK_STUDIOS_ROOT = '/tmp/studios';
    expect(ephemeralWorktreePath({ agentId: null, repoRoot: '/x/:::', leaf: '' })).toBe(
      '/tmp/studios/agent/project/studio'
    );
  });
});

describe('studioPathSegment', () => {
  it('lowercases and hyphenates unsafe characters', () => {
    expect(studioPathSegment('Wren Agent!', 'x')).toBe('wren-agent');
    expect(studioPathSegment('pr:537', 'x')).toBe('pr-537');
  });

  it('neutralizes path traversal — dots never survive', () => {
    expect(studioPathSegment('..', 'x')).toBe('x');
    expect(studioPathSegment('../../etc', 'x')).toBe('etc');
    expect(studioPathSegment('.hidden', 'x')).toBe('hidden');
    // No sanitized segment can contain a separator or a dot.
    for (const hostile of ['a/b', 'a\\b', '..', 'a..b', './x']) {
      const seg = studioPathSegment(hostile, 'fallback');
      expect(seg).not.toMatch(/[/\\.]/);
    }
  });

  it('trims leading/trailing hyphens and caps length', () => {
    expect(studioPathSegment('--edge--', 'x')).toBe('edge');
    expect(studioPathSegment('a'.repeat(300), 'x')).toHaveLength(100);
    // The cap must not leave a dangling hyphen at the cut point.
    const capped = studioPathSegment(`${'a'.repeat(99)}-tail`, 'x');
    expect(capped.endsWith('-')).toBe(false);
  });

  it('uses the fallback only when nothing survives sanitization', () => {
    expect(studioPathSegment(':::', 'fallback')).toBe('fallback');
    expect(studioPathSegment(undefined, 'fallback')).toBe('fallback');
    expect(studioPathSegment('ok', 'fallback')).toBe('ok');
  });
});
