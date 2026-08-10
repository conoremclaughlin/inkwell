import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveTriggerMedia, MAX_TRIGGER_MEDIA } from './agent-media.js';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('resolveTriggerMedia (agent-to-agent attachment containment)', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-media-root-'));
    outside = mkdtempSync(join(tmpdir(), 'agent-media-outside-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const png = (dir: string, name: string): string => {
    const p = join(dir, name);
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return p;
  };

  it('passes a regular file inside the shared root, normalizing its shape', async () => {
    const p = png(root, 'photo.png');
    const out = await resolveTriggerMedia(
      { media: [{ type: 'image', path: p, mimeType: 'image/png', filename: 'photo.png' }] },
      root
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('image');
    expect(out[0]!.mimeType).toBe('image/png');
    // Realpath'd — containment was checked on the real location.
    expect(out[0]!.path!.endsWith('photo.png')).toBe(true);
  });

  it('drops paths outside the shared root (the exfiltration vector)', async () => {
    const secret = png(outside, 'id_rsa');
    const out = await resolveTriggerMedia({ media: [{ type: 'image', path: secret }] }, root);
    expect(out).toEqual([]);
  });

  it('drops symlinks inside the root that point outside it', async () => {
    const secret = png(outside, 'secret.png');
    const link = join(root, 'innocent.png');
    symlinkSync(secret, link);
    const out = await resolveTriggerMedia({ media: [{ path: link }] }, root);
    expect(out).toEqual([]);
  });

  it('drops directories and missing files', async () => {
    const sub = join(root, 'subdir');
    mkdirSync(sub);
    const out = await resolveTriggerMedia(
      { media: [{ path: sub }, { path: join(root, 'nope.png') }] },
      root
    );
    expect(out).toEqual([]);
  });

  it('handles absent/malformed metadata and entries', async () => {
    expect(await resolveTriggerMedia(undefined, root)).toEqual([]);
    expect(await resolveTriggerMedia(null, root)).toEqual([]);
    expect(await resolveTriggerMedia({}, root)).toEqual([]);
    expect(await resolveTriggerMedia({ media: 'not-an-array' }, root)).toEqual([]);
    expect(await resolveTriggerMedia({ media: [null, {}, { path: 42 }] }, root)).toEqual([]);
  });

  it('defaults unknown media types to document', async () => {
    const p = png(root, 'mystery.bin');
    const out = await resolveTriggerMedia({ media: [{ type: 'weird', path: p }] }, root);
    expect(out[0]!.type).toBe('document');
  });

  it('caps the number of attachments', async () => {
    const media = Array.from({ length: MAX_TRIGGER_MEDIA + 4 }, (_, i) => ({
      path: png(root, `f${i}.png`),
    }));
    const out = await resolveTriggerMedia({ media }, root);
    expect(out).toHaveLength(MAX_TRIGGER_MEDIA);
  });

  it('returns empty when the shared root itself is missing', async () => {
    const out = await resolveTriggerMedia(
      { media: [{ path: join(root, 'x.png') }] },
      join(root, 'does-not-exist')
    );
    expect(out).toEqual([]);
  });
});
