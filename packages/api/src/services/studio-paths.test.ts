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
  it('lowercases and hyphenates unsafe characters, digest-suffixed', () => {
    expect(studioPathSegment('Wren Agent!', 'x')).toMatch(/^wren-agent-h[a-z0-9]+$/);
    expect(studioPathSegment('pr:537', 'x')).toMatch(/^pr-537-h[a-z0-9]+$/);
  });

  it('passes already-canonical inputs through byte-for-byte', () => {
    expect(studioPathSegment('ok', 'fallback')).toBe('ok');
    expect(studioPathSegment('wren', 'x')).toBe('wren');
    expect(studioPathSegment('lumen-review--pr-476-h1a2b3', 'x')).toBe(
      'lumen-review--pr-476-h1a2b3'
    );
  });

  it('neutralizes path traversal — dots never survive', () => {
    expect(studioPathSegment('..', 'x')).toBe('x');
    expect(studioPathSegment('../../etc', 'x')).toMatch(/^etc-h[a-z0-9]+$/);
    expect(studioPathSegment('.hidden', 'x')).toMatch(/^hidden-h[a-z0-9]+$/);
    // No sanitized segment can contain a separator or a dot.
    for (const hostile of ['a/b', 'a\\b', '..', 'a..b', './x']) {
      const seg = studioPathSegment(hostile, 'fallback');
      expect(seg).not.toMatch(/[/\\.]/);
    }
  });

  it('trims leading/trailing hyphens and caps length without a dangling hyphen', () => {
    expect(studioPathSegment('--edge--', 'x')).toMatch(/^edge-h[a-z0-9]+$/);
    expect(studioPathSegment('a'.repeat(300), 'x').length).toBeLessThanOrEqual(100);
    const capped = studioPathSegment(`${'a'.repeat(99)}-tail`, 'x');
    expect(capped.length).toBeLessThanOrEqual(100);
    expect(capped).not.toMatch(/-h[a-z0-9]+-/); // digest is terminal
  });

  it('uses the fallback only when nothing survives sanitization', () => {
    expect(studioPathSegment(':::', 'fallback')).toBe('fallback');
    expect(studioPathSegment(undefined, 'fallback')).toBe('fallback');
  });

  // PR #544 r1 P1 (Lumen): sanitization and truncation are many-to-one.
  // Every transformed/truncated output carries a digest of the ORIGINAL so
  // distinct inputs can never share a directory.
  describe('alias resistance', () => {
    it('two long slugs differing past the cap do not alias', () => {
      const a = studioPathSegment(`${'a'.repeat(100)}--pr-1`, 'x');
      const b = studioPathSegment(`${'a'.repeat(100)}--pr-2`, 'x');
      expect(a).not.toBe(b);
      expect(a.length).toBeLessThanOrEqual(100);
      expect(b.length).toBeLessThanOrEqual(100);
    });

    it('case normalization does not alias onto a canonical input', () => {
      expect(studioPathSegment('A-b', 'x')).not.toBe(studioPathSegment('a-b', 'x'));
      expect(studioPathSegment('a-b', 'x')).toBe('a-b');
    });

    it('punctuation normalization does not alias onto a canonical input', () => {
      expect(studioPathSegment('pr:1', 'x')).not.toBe(studioPathSegment('pr-1', 'x'));
      expect(studioPathSegment('pr-1', 'x')).toBe('pr-1');
    });

    it('hyphen trimming does not alias onto a canonical input', () => {
      expect(studioPathSegment('--edge--', 'x')).not.toBe(studioPathSegment('edge', 'x'));
    });

    it('is deterministic — the digest is a function of the input alone', () => {
      expect(studioPathSegment('PR:537', 'x')).toBe(studioPathSegment('PR:537', 'x'));
    });
  });
});
