/**
 * Containment tests for outbound attachments.
 *
 * These run against a REAL temp filesystem — real symlinks, real hard
 * links, real directories. The boundary being tested is "can an agent mail
 * out a file it should not be able to read", and a mocked fs would only
 * prove the mock agrees with itself.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AttachmentError, resolveOutboundAttachments } from './attachments';

let root: string; // stands in for ~/.ink/files
let outside: string; // anything the agent should not be able to reach
let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'gmail-attach-'));
  root = join(base, 'files');
  outside = join(base, 'secrets');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const resolve = (paths: Array<{ path: string; filename?: string }>, opts = {}) =>
  resolveOutboundAttachments(paths, { mediaRoot: root, ...opts });

describe('resolveOutboundAttachments — happy path', () => {
  it('returns nothing for an empty list', async () => {
    expect(await resolve([])).toEqual([]);
  });

  it('reads a contained file with its bytes and inferred type', async () => {
    const file = join(root, 'insurance-front.jpg');
    await writeFile(file, 'JPEGBYTES');

    const [attachment] = await resolve([{ path: file }]);

    expect(attachment.filename).toBe('insurance-front.jpg');
    expect(attachment.mimeType).toBe('image/jpeg');
    expect(attachment.content.toString()).toBe('JPEGBYTES');
  });

  it('honors an explicit filename override', async () => {
    const file = join(root, '1739_scan.pdf');
    await writeFile(file, 'PDF');

    const [attachment] = await resolve([{ path: file, filename: 'Insurance Card.pdf' }]);

    expect(attachment.filename).toBe('Insurance Card.pdf');
    expect(attachment.mimeType).toBe('application/pdf');
  });

  // Content-Type describes the bytes; `filename` only decides what the
  // recipient sees. Myra caught this live: a JPEG sent as "scan.pdf" was
  // declared application/pdf, so the header stated something untrue about
  // the payload and nothing warned.
  it('types the attachment from the real file, not the display override', async () => {
    const file = join(root, 'photo.jpg');
    await writeFile(file, 'JPEGBYTES');

    const [attachment] = await resolve([{ path: file, filename: 'scan.pdf' }]);

    expect(attachment.filename).toBe('scan.pdf');
    expect(attachment.mimeType).toBe('image/jpeg');
  });

  // Lumen's catch: an earlier revision fell back to the display name whenever
  // the real file was unmapped, which reinstated the very coupling this change
  // removes. `.html` is not in the map, so `payload.html` shown as
  // `report.pdf` went out declared a PDF on the strength of a name that never
  // saw the bytes.
  it('never borrows the display type for a real file it cannot type', async () => {
    const file = join(root, 'payload.html');
    await writeFile(file, '<html>NOT A PDF</html>');

    const [attachment] = await resolve([{ path: file, filename: 'report.pdf' }]);

    expect(attachment.filename).toBe('report.pdf');
    expect(attachment.mimeType).toBe('application/octet-stream');
  });

  // A genuinely extension-less file — the earlier fixture used a real Telegram
  // id with `.jpg` stripped, which reads as covering production but tests a
  // shape that does not occur there: every file in the media root has a
  // suffix. This one is honestly opaque.
  it('stays octet-stream when the real file has no extension at all', async () => {
    const file = join(root, 'opaque-download');
    await writeFile(file, 'BYTES');

    const [attachment] = await resolve([{ path: file, filename: 'Report.pdf' }]);

    expect(attachment.mimeType).toBe('application/octet-stream');
  });

  // Myra found this by listing the media root rather than reasoning about it:
  // Telegram voice notes land as `.oga`, 6 of the 23 files there, and `.oga`
  // was absent from the map — so a file we positively know is Ogg audio went
  // out as generic bytes.
  it('types a Telegram voice note as Ogg audio', async () => {
    const file = join(root, 'AgACAgUAAxkBAAIJQmqH_1787251286114.oga');
    await writeFile(file, 'OGGBYTES');

    const [attachment] = await resolve([{ path: file }]);

    expect(attachment.mimeType).toBe('audio/ogg');
  });

  // The real first use: Telegram downloads land in a subdirectory of the media
  // root, so a containment rule that accepted the root but not its children
  // would pass review and fail on the first actual send.
  it('reads a Telegram download from a subdirectory of the media root', async () => {
    const dir = join(root, 'telegram');
    await mkdir(dir);
    const file = join(dir, 'photo_2026-08-20.jpg');
    await writeFile(file, 'JPEGBYTES');

    const [attachment] = await resolve([{ path: file }]);

    expect(attachment.filename).toBe('photo_2026-08-20.jpg');
    expect(attachment.mimeType).toBe('image/jpeg');
    expect(attachment.content.toString()).toBe('JPEGBYTES');
  });

  it('reads files from a deeply nested subdirectory', async () => {
    const dir = join(root, 'gmail', 'inbound', '2026-08');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'report.pdf');
    await writeFile(file, 'REPORT');

    const [attachment] = await resolve([{ path: file }]);
    expect(attachment.content.toString()).toBe('REPORT');
  });

  it('resolves several attachments in order', async () => {
    await writeFile(join(root, 'a.txt'), 'A');
    await writeFile(join(root, 'b.txt'), 'B');

    const result = await resolve([{ path: join(root, 'a.txt') }, { path: join(root, 'b.txt') }]);

    expect(result.map((a) => a.content.toString())).toEqual(['A', 'B']);
  });

  it('follows a symlink that stays inside the root', async () => {
    const target = join(root, 'real.pdf');
    const linkPath = join(root, 'alias.pdf');
    await writeFile(target, 'REAL');
    await symlink(target, linkPath);

    const [attachment] = await resolve([{ path: linkPath }]);
    expect(attachment.content.toString()).toBe('REAL');
  });
});

describe('resolveOutboundAttachments — containment', () => {
  it('refuses a path outside the media root', async () => {
    const secret = join(outside, 'id_rsa');
    await writeFile(secret, 'PRIVATE KEY');

    await expect(resolve([{ path: secret }])).rejects.toThrow(AttachmentError);
    await expect(resolve([{ path: secret }])).rejects.toThrow(/outside the shared media directory/);
  });

  it('refuses a symlink that escapes the root', async () => {
    const secret = join(outside, '.env.local');
    await writeFile(secret, 'SUPABASE_SECRET_KEY=sb_secret_xxx');
    const escape = join(root, 'innocent.txt');
    await symlink(secret, escape);

    // The lexical path looks contained; realpath is what judges it.
    await expect(resolve([{ path: escape }])).rejects.toThrow(/outside the shared media directory/);
  });

  it('refuses a traversal path', async () => {
    await writeFile(join(outside, 'secret.txt'), 'S');

    await expect(resolve([{ path: join(root, '..', 'secrets', 'secret.txt') }])).rejects.toThrow(
      /outside the shared media directory/
    );
  });

  it('refuses a hard link aliasing content from outside the root', async () => {
    const secret = join(outside, 'creds.json');
    await writeFile(secret, '{"token":"x"}');
    const alias = join(root, 'notes.json');
    await link(secret, alias);

    await expect(resolve([{ path: alias }])).rejects.toThrow(/multiple hard links/);
  });

  it('refuses a directory', async () => {
    const dir = join(root, 'adir');
    await mkdir(dir);

    await expect(resolve([{ path: dir }])).rejects.toThrow(/not a regular file/);
  });

  it('refuses a file that does not exist', async () => {
    await expect(resolve([{ path: join(root, 'nope.pdf') }])).rejects.toThrow(
      /could not be resolved/
    );
  });

  it('refuses an empty path', async () => {
    await expect(resolve([{ path: '' }])).rejects.toThrow(/missing a path/);
  });

  it('refuses everything when the media root is missing', async () => {
    await writeFile(join(root, 'a.txt'), 'A');
    await expect(
      resolveOutboundAttachments([{ path: join(root, 'a.txt') }], {
        mediaRoot: join(base, 'does-not-exist'),
      })
    ).rejects.toThrow(/media directory is unavailable/);
  });

  it('fails the whole batch when any one file is rejected', async () => {
    // The divergence from trigger media: partial success would mail a
    // message missing the files it was supposed to carry.
    const good = join(root, 'good.txt');
    await writeFile(good, 'GOOD');
    const bad = join(outside, 'bad.txt');
    await writeFile(bad, 'BAD');

    await expect(resolve([{ path: good }, { path: bad }])).rejects.toThrow(AttachmentError);
  });

  it('names the offending path in the error', async () => {
    const bad = join(outside, 'oops.txt');
    await writeFile(bad, 'X');

    await expect(resolve([{ path: bad }])).rejects.toThrow(new RegExp(bad.replace(/\./g, '\\.')));
  });
});

describe('resolveOutboundAttachments — limits', () => {
  it('rejects more than the per-message attachment count', async () => {
    const files = [];
    for (let i = 0; i < 11; i++) {
      const p = join(root, `f${i}.txt`);
      await writeFile(p, 'x');
      files.push({ path: p });
    }

    await expect(resolve(files)).rejects.toThrow(/Too many attachments: 11/);
  });

  it('rejects a single file over the per-file cap', async () => {
    const big = join(root, 'big.bin');
    await writeFile(big, Buffer.alloc(2048));

    await expect(resolve([{ path: big }], { maxFileBytes: 1024 })).rejects.toThrow(
      /exceeds the size limit/
    );
  });

  it('rejects a batch over the total cap even when each file fits', async () => {
    await writeFile(join(root, 'a.bin'), Buffer.alloc(800));
    await writeFile(join(root, 'b.bin'), Buffer.alloc(800));

    await expect(
      resolve([{ path: join(root, 'a.bin') }, { path: join(root, 'b.bin') }], {
        maxFileBytes: 1024,
        maxTotalBytes: 1000,
      })
    ).rejects.toThrow(/total size limit/);
  });

  it('accepts a batch exactly at the total cap', async () => {
    await writeFile(join(root, 'a.bin'), Buffer.alloc(500));
    await writeFile(join(root, 'b.bin'), Buffer.alloc(500));

    const result = await resolve([{ path: join(root, 'a.bin') }, { path: join(root, 'b.bin') }], {
      maxFileBytes: 1024,
      maxTotalBytes: 1000,
    });
    expect(result).toHaveLength(2);
  });
});
