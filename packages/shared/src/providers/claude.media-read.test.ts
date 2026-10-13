import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * readMediaBounded against a file whose size changes under it, which a real
 * file cannot be made to do on cue. The next open() returns a handle whose
 * stat reports `size` and whose reads report the scripted byte counts, then 0.
 *
 * The buffer is Buffer.allocUnsafe(size): if a short read were accepted, its
 * unread tail would be uninitialised process memory, sent to the provider as
 * base64 media (Myra, #701 review of 9e46b871).
 */
const scripted = vi.hoisted(() => ({
  next: undefined as undefined | { size: number; reads: number[]; closed: boolean },
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const script = scripted.next;
      if (!script) return actual.open(...args);
      scripted.next = undefined;
      const reads = [...script.reads];
      return {
        stat: async () => ({ isFile: () => true, size: script.size }),
        read: async (buf: Buffer, offset: number, length: number) => {
          // A macrotask per read, so a loop that never ends fails on the
          // test's timeout instead of starving the timer that enforces it.
          await new Promise((resolve) => setImmediate(resolve));
          const bytesRead = Math.min(reads.shift() ?? 0, length);
          buf.fill(0x41, offset, offset + bytesRead);
          return { bytesRead, buffer: buf };
        },
        close: async () => {
          script.closed = true;
        },
      };
    },
  };
});

import { readMediaBounded } from './claude.js';

function script(size: number, reads: number[]) {
  const entry = { size, reads, closed: false };
  scripted.next = entry;
  return entry;
}

afterEach(() => {
  scripted.next = undefined;
});

describe('readMediaBounded when the file changes under the read', () => {
  it('assembles a file delivered in several short reads (control)', async () => {
    const handle = script(16, [5, 5, 6]);
    const buf = await readMediaBounded('/synthetic/media.png', 4096);
    expect(buf).toEqual(Buffer.alloc(16, 0x41));
    expect(handle.closed).toBe(true);
  });

  it('refuses a file that shrank after the stat, rather than return a partly unread buffer', async () => {
    const handle = script(16, [10]);
    expect(await readMediaBounded('/synthetic/media.png', 4096)).toBeNull();
    expect(handle.closed).toBe(true);
  });

  it('stops at a read that makes no progress, and refuses', async () => {
    const handle = script(16, []);
    expect(await readMediaBounded('/synthetic/media.png', 4096)).toBeNull();
    expect(handle.closed).toBe(true);
  }, 2000);
});
