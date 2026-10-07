/**
 * A person's uploads on a Claude turn: each upload's own directory is
 * granted for that spawn only, never the uploads root; in a container, which
 * mounts no host media, the uploads are dropped and the turn is told.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ClaudeRunner } from './claude-runner.js';
import { setUploadsRoot } from '../uploads/runtime.js';

const ROOT = '/home/u/.ink/uploads';
const U = '0a0a0a0a-0000-4000-8000-0000000000aa';
const W = '1c1c1c1c-0000-4000-8000-0000000000cc';
const A = '5a5a5a5a-0000-4000-8000-000000000001';
const B = '5a5a5a5a-0000-4000-8000-000000000002';
const upload = (id: string) => ({
  type: 'image' as const,
  path: `${ROOT}/${U}/${W}/${id}/${id}.jpg`,
});
const channelPhoto = { type: 'image' as const, path: '/home/u/.ink/files/telegram/p.jpg' };
const cfg = { workingDirectory: '/tmp', mcpConfigPath: '/tmp/.mcp.json', sbSlug: 'fern' };

let prevStudios: string | undefined;

beforeEach(() => {
  prevStudios = process.env.INK_STUDIOS_ROOT;
  process.env.INK_STUDIOS_ROOT = join(tmpdir(), `ink-studios-uploads-${process.pid}`);
  setUploadsRoot(ROOT);
});

afterEach(() => {
  rmSync(process.env.INK_STUDIOS_ROOT!, { recursive: true, force: true });
  if (prevStudios === undefined) delete process.env.INK_STUDIOS_ROOT;
  else process.env.INK_STUDIOS_ROOT = prevStudios;
  setUploadsRoot(null);
});

async function spawnOf(options: Record<string, unknown>, resumeFails = false) {
  const runner = new ClaudeRunner();
  const spawns: Array<{ args: string[]; message: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runner as any).spawnProcess = vi.fn(async (args: string[], message: string) => {
    spawns.push({ args, message });
    if (resumeFails && spawns.length === 1) {
      return { responses: [], toolCalls: [], resumeFailedNoSession: true };
    }
    return { responses: [], toolCalls: [], finalTextResponse: 'ok' };
  });
  await runner.run('Look at this', { config: cfg, ...options } as never);
  const grants = (args: string[]) =>
    args.map((a, i) => (a === '--add-dir' ? args[i + 1] : null)).filter((d): d is string => !!d);
  return spawns.map((s) => ({ grants: grants(s.args), message: s.message }));
}

describe('ClaudeRunner with uploads', () => {
  it('grants each upload’s own directory once, and never the uploads root', async () => {
    const [spawn] = await spawnOf({
      mediaAttachments: [upload(A), channelPhoto, upload(B), upload(A)],
    });
    const uploadGrants = spawn.grants.filter((d) => d.startsWith(ROOT));
    expect(uploadGrants).toEqual([`${ROOT}/${U}/${W}/${A}`, `${ROOT}/${U}/${W}/${B}`]);
    expect(spawn.grants).not.toContain(ROOT);
    expect(spawn.message).toBe('Look at this');
  });

  it('grants the same directories to the fresh-session retry', async () => {
    const spawns = await spawnOf({ backendSessionId: 'gone', mediaAttachments: [upload(A)] }, true);
    expect(spawns).toHaveLength(2);
    for (const s of spawns) expect(s.grants).toContain(`${ROOT}/${U}/${W}/${A}`);
  });

  it('grants nothing extra on a turn without uploads', async () => {
    const [spawn] = await spawnOf({ mediaAttachments: [channelPhoto] });
    expect(spawn.grants.some((d) => d.startsWith(ROOT))).toBe(false);
  });

  it('in a container, drops the uploads and tells the turn', async () => {
    const [spawn] = await spawnOf({
      config: { ...cfg, container: { name: 'c', runtimeDir: '/run/ink' } },
      mediaAttachments: [upload(A)],
    });
    expect(spawn.grants.some((d) => d.startsWith(ROOT))).toBe(false);
    expect(spawn.message).toBe(
      'Look at this\n\n(One attached file could not be opened in this runtime.)'
    );
  });
});
