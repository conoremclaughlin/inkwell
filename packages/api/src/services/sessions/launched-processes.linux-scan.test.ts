/**
 * The Linux branch of the launch-tag scan, against a synthetic /proc: an
 * environment that cannot be read is reported, never read as "no tag".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const proc = vi.hoisted(() => {
  const uid = process.getuid?.() ?? 0;
  const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
  const gone = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const files: Record<string, string | Error> = {
    // A backend whose environment cannot be read.
    '/proc/100/stat': '100 (claude) S 1 100 100 0',
    '/proc/100/environ': denied,
    '/proc/100/cmdline': 'claude\0--print\0',
    // A tagged ink chat leading its own group.
    '/proc/101/stat': '101 (node) S 1 101 101 0',
    '/proc/101/environ': 'HOME=/h\0INK_LAUNCH_ID=row-1\0',
    '/proc/101/cmdline': 'node\0/x/cli.js\0chat\0',
    // Exited between the listing and the read.
    '/proc/102/stat': '102 (sh) S 1 1 1 0',
    '/proc/102/environ': gone,
    '/proc/102/cmdline': gone,
    // Its state cannot be read: unknown, not exited.
    '/proc/104/stat': denied,
    '/proc/104/environ': denied,
    '/proc/104/cmdline': 'codex\0exec\0',
    // Its command line cannot be read: unknown, so it could be any backend.
    '/proc/105/stat': '105 (x) S 1 105 105 0',
    '/proc/105/environ': denied,
    '/proc/105/cmdline': denied,
    // Another user's process.
    '/proc/103/stat': '103 (sshd) S 1 103 103 0',
    '/proc/103/environ': denied,
    '/proc/103/cmdline': 'sshd\0',
  };
  return { uid, files };
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(async () => ['100', '101', '102', '103', '104', '105', 'self', 'cpuinfo']),
    stat: vi.fn(async (path: string) => ({ uid: path === '/proc/103' ? proc.uid + 1 : proc.uid })),
    readFile: vi.fn(async (path: string) => {
      const value = proc.files[path];
      if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (value instanceof Error) throw value;
      return value;
    }),
  };
});

import { findTaggedProcesses } from './launched-processes';

describe('findTaggedProcesses on Linux', () => {
  const platform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
  });

  it('reports this user’s unreadable environments, and reads tags exactly', async () => {
    const inventory = await findTaggedProcesses(new Set(['row-1']));
    expect(inventory.tagged.get('row-1')).toEqual([
      { pid: 101, pgid: 101, command: 'node /x/cli.js chat ' },
    ]);
    expect(inventory.unreadable).toEqual([
      { pid: 100, pgid: 100, command: 'claude --print ' },
      { pid: 104, pgid: null, command: 'codex exec ' },
      { pid: 105, pgid: 105, command: null },
    ]);
  });
});
