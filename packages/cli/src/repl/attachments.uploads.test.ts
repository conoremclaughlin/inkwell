/**
 * A person's upload reaches ink chat as --attach-file <its original file>,
 * under the server's private uploads root, never under ~/.ink/files. This pins
 * what InkRunner's `uploadMedia: 'grant'` relies on:
 *   - ink chat reads the file itself (as the server's user), with no
 *     allowed-roots check that would refuse a path outside ~/.ink/files;
 *   - the directory it grants its backend is that file's own directory,
 *     never the uploads root or a person's or workspace's level above it.
 * The files are laid out and moded exactly as the server writes them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectAttachmentDirs, resolveAttachments } from './attachments.js';
import { classifyMedia, encodeMediaBlocks } from '../backends/claude.js';

const U = '0a0a0a0a-0000-4000-8000-0000000000aa';
const W = '1c1c1c1c-0000-4000-8000-0000000000cc';
const A = '5a5a5a5a-0000-4000-8000-000000000001';
const B = '5a5a5a5a-0000-4000-8000-000000000002';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj');

let base: string;
let root: string;
let photo: string;
let doc: string;

async function place(id: string, ext: string, bytes: Buffer): Promise<string> {
  const dir = join(root, U, W, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${id}.${ext}`);
  await writeFile(file, bytes);
  await chmod(file, 0o400);
  await chmod(dir, 0o500);
  return file;
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'ink-chat-uploads-'));
  root = join(base, 'uploads');
  photo = await place(A, 'jpg', JPEG);
  doc = await place(B, 'pdf', PDF);
});

afterAll(async () => {
  await chmod(join(root, U, W, A), 0o700);
  await chmod(join(root, U, W, B), 0o700);
  await rm(base, { recursive: true, force: true });
});

describe('an upload attached to an ink chat turn', () => {
  it('resolves as readable, typed from its server-chosen extension', async () => {
    const resolved = await resolveAttachments([photo, doc]);
    expect(resolved.map((a) => [a.mime, a.missing ?? false])).toEqual([
      ['image/jpeg', false],
      ['application/pdf', false],
    ]);
  });

  it('grants the backend each file’s own directory, never the uploads root', async () => {
    const dirs = collectAttachmentDirs(await resolveAttachments([photo, doc]));
    expect(dirs).toEqual([join(root, U, W, A), join(root, U, W, B)]);
    for (const above of [root, join(root, U), join(root, U, W)]) expect(dirs).not.toContain(above);
  });

  it('is read by ink chat itself and inlined, with no allowed-roots refusal', async () => {
    const media = [{ path: photo, mimeType: 'image/jpeg' }];
    const { candidates } = classifyMedia(media);
    const encoded = await encodeMediaBlocks(candidates);
    expect(encoded.rejected).toEqual([]);
    expect(encoded.injected).toEqual(media);
    expect(encoded.blocks[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: JPEG.toString('base64') },
    });
  });

  it('leaves a document for native read through the granted directory', () => {
    expect(classifyMedia([{ path: doc, mimeType: 'application/pdf' }]).nativeRead).toHaveLength(1);
  });
});
