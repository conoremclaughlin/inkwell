import { describe, expect, it } from 'vitest';
import { uploadDirOf, uploadMediaForRunner } from './runner-media';

const ROOT = '/home/u/.ink/uploads';
const U = '0a0a0a0a-0000-4000-8000-0000000000aa';
const W = '1c1c1c1c-0000-4000-8000-0000000000cc';
const A = '5a5a5a5a-0000-4000-8000-000000000001';
const B = '5a5a5a5a-0000-4000-8000-000000000002';
const upload = (id: string, ext = 'jpg') => ({
  type: 'image' as const,
  path: `${ROOT}/${U}/${W}/${id}/${id}.${ext}`,
});
const channelPhoto = { type: 'image' as const, path: '/home/u/.ink/files/telegram/photo.jpg' };

describe('uploadDirOf', () => {
  it('names only an upload’s own directory', () => {
    expect(uploadDirOf(upload(A).path, ROOT)).toBe(`${ROOT}/${U}/${W}/${A}`);
  });

  it('names nothing for the root, a level above an upload, a stray file or another root', () => {
    for (const path of [
      ROOT,
      `${ROOT}/${U}`,
      `${ROOT}/${U}/${W}/${A}`,
      `${ROOT}/${U}/${W}/${A}/${B}.jpg`,
      `${ROOT}/${U}/${W}/${A}/nested/${A}.jpg`,
      `${ROOT}/.staging/${A}.part`,
      `${ROOT}/${U}/${W}/not-an-id/x.jpg`,
      `${ROOT}-other/${U}/${W}/${A}/${A}.jpg`,
      channelPhoto.path,
    ]) {
      expect(uploadDirOf(path, ROOT), path).toBeNull();
    }
  });
});

describe('uploadMediaForRunner', () => {
  it('grants each upload’s own directory once, and passes other media through', () => {
    const out = uploadMediaForRunner({
      attachments: [upload(A), channelPhoto, upload(B, 'pdf'), upload(A)],
      root: ROOT,
      policy: 'grant',
      sandboxed: false,
    });
    expect(out.grantDirs).toEqual([`${ROOT}/${U}/${W}/${A}`, `${ROOT}/${U}/${W}/${B}`]);
    expect(out.attachments).toHaveLength(4);
    expect(out.grantDirs).not.toContain(ROOT);
    expect(out.dropped).toEqual([]);
    expect(out.note).toBeNull();
  });

  it('drops uploads, with a note the turn sees, for a runner that refuses or a container', () => {
    for (const input of [
      { policy: 'refuse' as const, sandboxed: false },
      { policy: 'grant' as const, sandboxed: true },
    ]) {
      const given = [upload(A), channelPhoto, upload(B)];
      const out = uploadMediaForRunner({ attachments: given, root: ROOT, ...input });
      expect(out.attachments).toEqual([channelPhoto]);
      expect(out.grantDirs).toEqual([]);
      // The same objects, so the caller can leave exactly these out of the prompt.
      expect(out.dropped).toHaveLength(2);
      expect(out.dropped[0]).toBe(given[0]);
      expect(out.dropped[1]).toBe(given[2]);
      expect(out.note).toBe('(2 attached files could not be opened in this runtime.)');
    }
  });

  it('drops uploads for a runner that declares no policy', () => {
    const out = uploadMediaForRunner({
      attachments: [upload(A), channelPhoto],
      root: ROOT,
      policy: undefined as unknown as 'grant',
      sandboxed: false,
    });
    expect(out.attachments).toEqual([channelPhoto]);
    expect(out.grantDirs).toEqual([]);
    expect(out.note).toBe('(One attached file could not be opened in this runtime.)');
  });

  it('drops a path under the root that is not exactly one upload’s file', () => {
    const stray = { type: 'document' as const, path: `${ROOT}/${U}/${W}/${A}` };
    const out = uploadMediaForRunner({
      attachments: [stray],
      root: ROOT,
      policy: 'grant',
      sandboxed: false,
    });
    expect(out).toEqual({
      attachments: [],
      grantDirs: [],
      dropped: [stray],
      note: '(One attached file could not be opened in this runtime.)',
    });
  });

  it('changes nothing when uploads are off or nothing is attached', () => {
    expect(
      uploadMediaForRunner({
        attachments: [channelPhoto],
        root: null,
        policy: 'refuse',
        sandboxed: true,
      })
    ).toEqual({ attachments: [channelPhoto], grantDirs: [], dropped: [], note: null });
    expect(
      uploadMediaForRunner({
        attachments: undefined,
        root: ROOT,
        policy: 'grant',
        sandboxed: false,
      })
    ).toEqual({ attachments: [], grantDirs: [], dropped: [], note: null });
  });
});
