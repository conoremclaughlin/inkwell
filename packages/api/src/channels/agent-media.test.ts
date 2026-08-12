import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { join, sep } from 'path';
import { tmpdir } from 'os';
import { open, readdir } from 'fs/promises';
import {
  resolveTriggerMedia,
  storedTriggerMedia,
  readBoundedFromHandle,
  MAX_TRIGGER_MEDIA,
  TRIGGER_SNAPSHOT_DIR,
  PRUNE_MIN_AGE_MS,
} from './agent-media.js';

const snapshotDigest = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 32);

const mockWarn = vi.fn();
vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('resolveTriggerMedia (agent-to-agent attachment containment)', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    mockWarn.mockReset();
    root = mkdtempSync(join(tmpdir(), 'agent-media-root-'));
    outside = mkdtempSync(join(tmpdir(), 'agent-media-outside-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const png = (dir: string, name: string, bytes?: Buffer): string => {
    const p = join(dir, name);
    writeFileSync(p, bytes ?? Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return p;
  };

  it('delivers a SNAPSHOT of an inside-root file, never the referenced path', async () => {
    const content = Buffer.from('distinctive-bytes-123');
    const p = png(root, 'photo.png', content);
    const out = await resolveTriggerMedia(
      { media: [{ type: 'image', path: p, mimeType: 'image/png', filename: 'photo.png' }] },
      { mediaRoot: root }
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('image');
    expect(out[0]!.mimeType).toBe('image/png');
    // Check/use gap closed: the delivered path is a snapshot copied from the
    // verified descriptor — mutating the original after resolution cannot
    // redirect what the spawn attaches.
    expect(out[0]!.path).not.toBe(p);
    expect(out[0]!.path!.includes(`${sep}${TRIGGER_SNAPSHOT_DIR}${sep}`)).toBe(true);
    expect(readFileSync(out[0]!.path!).equals(content)).toBe(true);
  });

  it('drops paths outside the shared root (the exfiltration vector)', async () => {
    const secret = png(outside, 'id_rsa');
    const out = await resolveTriggerMedia(
      { media: [{ type: 'image', path: secret }] },
      { mediaRoot: root }
    );
    expect(out).toEqual([]);
    expect(mockWarn).toHaveBeenCalled();
  });

  it('drops symlinks inside the root that point outside it', async () => {
    const secret = png(outside, 'secret.png');
    const link = join(root, 'innocent.png');
    symlinkSync(secret, link);
    const out = await resolveTriggerMedia({ media: [{ path: link }] }, { mediaRoot: root });
    expect(out).toEqual([]);
  });

  it('drops hard links — the root is a provenance boundary, not just a namespace', async () => {
    // A hard link inside the root aliasing other content has nlink > 1;
    // realpath cannot see through it, so provenance is enforced on the inode.
    const original = png(outside, 'aliased.png');
    const hardLink = join(root, 'looks-local.png');
    linkSync(original, hardLink);
    const out = await resolveTriggerMedia({ media: [{ path: hardLink }] }, { mediaRoot: root });
    expect(out).toEqual([]);
    expect(String(mockWarn.mock.calls.flat())).toContain('hard links');
  });

  it('drops files over the byte cap', async () => {
    const p = png(root, 'big.png', Buffer.alloc(2048, 1));
    const out = await resolveTriggerMedia(
      { media: [{ path: p }] },
      { mediaRoot: root, maxFileBytes: 1024 }
    );
    expect(out).toEqual([]);
  });

  it('drops directories and missing files', async () => {
    const sub = join(root, 'subdir');
    mkdirSync(sub);
    const out = await resolveTriggerMedia(
      { media: [{ path: sub }, { path: join(root, 'nope.png') }] },
      { mediaRoot: root }
    );
    expect(out).toEqual([]);
  });

  it('handles absent/malformed metadata, warning boundedly about malformed entries', async () => {
    expect(await resolveTriggerMedia(undefined, { mediaRoot: root })).toEqual([]);
    expect(await resolveTriggerMedia(null, { mediaRoot: root })).toEqual([]);
    expect(await resolveTriggerMedia({}, { mediaRoot: root })).toEqual([]);
    expect(await resolveTriggerMedia({ media: 'not-an-array' }, { mediaRoot: root })).toEqual([]);

    mockWarn.mockReset();
    const out = await resolveTriggerMedia(
      { media: [null, {}, { path: 42 }, { path: '' }] },
      { mediaRoot: root }
    );
    expect(out).toEqual([]);
    // One aggregated warn for all malformed entries — loud but bounded.
    const malformedWarns = mockWarn.mock.calls.filter((c) =>
      String(c[0]).includes('malformed media entries')
    );
    expect(malformedWarns).toHaveLength(1);
    expect((malformedWarns[0]![1] as { count: number }).count).toBe(4);
  });

  it('defaults unknown media types to document', async () => {
    const p = png(root, 'mystery.bin');
    const out = await resolveTriggerMedia(
      { media: [{ type: 'weird', path: p }] },
      { mediaRoot: root }
    );
    expect(out[0]!.type).toBe('document');
  });

  it('caps the number of attachments', async () => {
    const media = Array.from({ length: MAX_TRIGGER_MEDIA + 4 }, (_, i) => ({
      path: png(root, `f${i}.png`),
    }));
    const out = await resolveTriggerMedia({ media }, { mediaRoot: root });
    expect(out).toHaveLength(MAX_TRIGGER_MEDIA);
  });

  it('returns empty when the shared root itself is missing', async () => {
    const out = await resolveTriggerMedia(
      { media: [{ path: join(root, 'x.png') }] },
      { mediaRoot: join(root, 'does-not-exist') }
    );
    expect(out).toEqual([]);
  });

  it('refuses ALL delivery when the snapshot dir is a symlink out of the root', async () => {
    // A pre-existing symlink at <root>/.trigger-snapshots would route
    // mkdir/writeFile outside the root while the returned lexical path
    // still looked contained (Lumen repro, review 4900565751).
    const elsewhere = join(outside, 'evil-snapshots');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, TRIGGER_SNAPSHOT_DIR));
    const p = png(root, 'ok.png');
    const out = await resolveTriggerMedia({ media: [{ path: p }] }, { mediaRoot: root });
    expect(out).toEqual([]);
    // Nothing escaped through the symlink.
    expect(await readdir(elsewhere)).toEqual([]);
    expect(String(mockWarn.mock.calls.flat())).toContain('not canonical');
  });

  it('reuses content-addressed snapshots — repeated references do not grow storage', async () => {
    const p = png(root, 'same.png', Buffer.from('identical-bytes'));
    const first = await resolveTriggerMedia({ media: [{ path: p }] }, { mediaRoot: root });
    const second = await resolveTriggerMedia({ media: [{ path: p }] }, { mediaRoot: root });
    expect(first[0]!.path).toBe(second[0]!.path);
    const snaps = await readdir(join(root, TRIGGER_SNAPSHOT_DIR));
    expect(snaps).toHaveLength(1);
  });

  it('prunes AGED snapshots beyond the cap; fresh ones ride the grace window', async () => {
    for (let i = 0; i < 5; i++) {
      const p = png(root, `distinct-${i}.png`, Buffer.from(`content-${i}`));
      await resolveTriggerMedia({ media: [{ path: p }] }, { mediaRoot: root, maxSnapshots: 3 });
    }
    const dir = join(realpathSync(root), TRIGGER_SNAPSHOT_DIR);
    // All five are inside the grace window — a concurrent trigger's snapshot
    // must never be pruned between resolution and provider open, so the cap
    // is transiently exceeded rather than fresh files deleted.
    expect((await readdir(dir)).length).toBe(5);

    // Age everything past the window; the next delivery enforces the cap.
    const old = (Date.now() - PRUNE_MIN_AGE_MS - 60_000) / 1000;
    for (const name of await readdir(dir)) {
      utimesSync(join(dir, name), old, old);
    }
    const p = png(root, 'distinct-5.png', Buffer.from('content-5'));
    const out = await resolveTriggerMedia(
      { media: [{ path: p }] },
      { mediaRoot: root, maxSnapshots: 3 }
    );
    const snaps = await readdir(dir);
    expect(snaps.length).toBeLessThanOrEqual(3);
    // The just-delivered snapshot always survives its own prune
    expect(existsSync(out[0]!.path)).toBe(true);
  });

  it('never prunes the snapshot it just returned (future-mtime aggressor, cap 1)', async () => {
    // Lumen's PR #465 repro: with cap 1 and one future-mtime existing entry,
    // the old prune deleted the freshly-returned snapshot before the
    // provider could open it.
    const dir = join(realpathSync(root), TRIGGER_SNAPSHOT_DIR);
    mkdirSync(dir, { recursive: true });
    const aggressor = join(dir, 'aggressor.bin');
    writeFileSync(aggressor, Buffer.from('future-dated'));
    const future = (Date.now() + 60 * 60 * 1000) / 1000;
    utimesSync(aggressor, future, future);

    const content = Buffer.from('fresh-delivery');
    const p = png(root, 'fresh.png', content);
    const out = await resolveTriggerMedia(
      { media: [{ path: p }] },
      { mediaRoot: root, maxSnapshots: 1 }
    );
    expect(out).toHaveLength(1);
    expect(existsSync(out[0]!.path)).toBe(true);
    expect(readFileSync(out[0]!.path).equals(content)).toBe(true);
    // The future-dated file is ineligible too (negative age is not "aged") —
    // it must never displace real files, and it is not itself pruned.
    expect(existsSync(aggressor)).toBe(true);
  });

  it('publishes atomically: concurrent same-content resolves never drop or see partial bytes', async () => {
    // Lumen's PR #474 repro: with writeFile at the final CAS name, 16
    // concurrent resolves of one large source produced 12/16 drops —
    // verifiers read partial files and unlinked the live writer. Atomic
    // temp+rename publication must yield zero drops and complete bytes.
    const content = Buffer.concat([
      Buffer.from('large-payload-'),
      Buffer.alloc(2 * 1024 * 1024, 7),
    ]);
    const p = png(root, 'big-shared.bin', content);
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        resolveTriggerMedia({ media: [{ path: p }] }, { mediaRoot: root })
      )
    );
    for (const out of results) {
      expect(out).toHaveLength(1);
      // Immediate read of every returned path sees complete bytes
      expect(readFileSync(out[0]!.path).equals(content)).toBe(true);
    }
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('EEXIST is not trust: a pre-created symlink at the snapshot name is repaired, not reused', async () => {
    const content = Buffer.from('victim-content');
    const p = png(root, 'photo.png', content);
    const dir = join(realpathSync(root), TRIGGER_SNAPSHOT_DIR);
    mkdirSync(dir, { recursive: true });
    const snapshotName = join(dir, `${snapshotDigest(content)}-photo.png`);
    const target = join(outside, 'attacker-target.bin');
    writeFileSync(target, Buffer.from('outside-bytes'));
    symlinkSync(target, snapshotName);

    const out = await resolveTriggerMedia({ media: [{ path: p }] }, { mediaRoot: root });
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe(snapshotName);
    // The delivered path is a REGULAR contained file with the expected bytes…
    expect(lstatSync(snapshotName).isSymbolicLink()).toBe(false);
    expect(readFileSync(snapshotName).equals(content)).toBe(true);
    // …and the outside target was never touched (path-based utimes/write
    // through the symlink is exactly what the old code risked)
    expect(readFileSync(target).equals(Buffer.from('outside-bytes'))).toBe(true);
  });

  it('EEXIST with wrong content (crash/ENOSPC leftover) is repaired to the true bytes', async () => {
    const content = Buffer.from('full-and-correct-content');
    const p = png(root, 'doc.pdf', content);
    const dir = join(realpathSync(root), TRIGGER_SNAPSHOT_DIR);
    mkdirSync(dir, { recursive: true });
    const snapshotName = join(dir, `${snapshotDigest(content)}-doc.pdf`);
    writeFileSync(snapshotName, content.subarray(0, 8)); // truncated leftover

    const out = await resolveTriggerMedia({ media: [{ path: p }] }, { mediaRoot: root });
    expect(out).toHaveLength(1);
    expect(readFileSync(out[0]!.path).equals(content)).toBe(true);
  });

  it('verified EEXIST reuse still works and refreshes retention time', async () => {
    const content = Buffer.from('identical-bytes-verified');
    const p = png(root, 'same.png', content);
    const first = await resolveTriggerMedia({ media: [{ path: p }] }, { mediaRoot: root });
    // Age the snapshot, then re-deliver: reuse must refresh mtime (via the
    // handle) so LRU retention sees it as live.
    const old = (Date.now() - PRUNE_MIN_AGE_MS - 60_000) / 1000;
    utimesSync(first[0]!.path, old, old);
    const second = await resolveTriggerMedia({ media: [{ path: p }] }, { mediaRoot: root });
    expect(second[0]!.path).toBe(first[0]!.path);
    const st = lstatSync(first[0]!.path);
    expect(Date.now() - st.mtimeMs).toBeLessThan(PRUNE_MIN_AGE_MS);
  });
});

describe('readBoundedFromHandle (the actual read boundary)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bounded-read-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns full content at or under the cap, null beyond it', async () => {
    // fstat's size check is only a fast reject — an inode that grows after
    // fstat would make readFile() unbounded. This loop never requests more
    // than cap + 1 bytes, whatever the file holds.
    const p = join(dir, 'f.bin');
    const content = Buffer.alloc(1000, 5);
    writeFileSync(p, content);

    const h1 = await open(p, 'r');
    try {
      expect((await readBoundedFromHandle(h1, 1000))!.equals(content)).toBe(true);
    } finally {
      await h1.close();
    }

    const h2 = await open(p, 'r');
    try {
      expect(await readBoundedFromHandle(h2, 999)).toBeNull();
    } finally {
      await h2.close();
    }
  });
});

describe('storedTriggerMedia (trust wiring — stored rows only)', () => {
  let root: string;

  beforeEach(() => {
    mockWarn.mockReset();
    root = mkdtempSync(join(tmpdir(), 'agent-media-stored-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const clientWithRows = (rows: Record<string, { metadata?: unknown } | null>) => {
    const from = vi.fn().mockImplementation((table: string) => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: rows[table] ?? null, error: null }),
        }),
      }),
    }));
    return { client: { from }, from };
  };

  it('resolves media from a stored LEGACY inbox row', async () => {
    const p = join(root, 'a.png');
    writeFileSync(p, 'x');
    const { client, from } = clientWithRows({
      agent_inbox: { metadata: { media: [{ type: 'image', path: p }] } },
    });
    const out = await storedTriggerMedia(client, { inboxMessageId: 'msg-1' }, { mediaRoot: root });
    expect(out).toHaveLength(1);
    expect(from).toHaveBeenCalledWith('agent_inbox');
  });

  it('resolves media from a stored THREAD message row', async () => {
    const p = join(root, 'b.png');
    writeFileSync(p, 'y');
    const { client, from } = clientWithRows({
      inbox_thread_messages: { metadata: { media: [{ type: 'image', path: p }] } },
    });
    const out = await storedTriggerMedia(client, { threadMessageId: 'tm-1' }, { mediaRoot: root });
    expect(out).toHaveLength(1);
    expect(from).toHaveBeenCalledWith('inbox_thread_messages');
  });

  it('delivers NOTHING for a trigger without a stored message reference — payload metadata is not an input', async () => {
    // The security property Lumen asked to see proven: a caller-composed
    // payload claiming media cannot smuggle attachments. storedTriggerMedia
    // does not even accept payload metadata; with no row reference it never
    // touches the database.
    const { client, from } = clientWithRows({});
    const out = await storedTriggerMedia(client, {}, { mediaRoot: root });
    expect(out).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it('delivers nothing when the stored row has no media metadata', async () => {
    const { client } = clientWithRows({ agent_inbox: { metadata: { note: 'no media here' } } });
    const out = await storedTriggerMedia(client, { inboxMessageId: 'msg-2' }, { mediaRoot: root });
    expect(out).toEqual([]);
  });
});
