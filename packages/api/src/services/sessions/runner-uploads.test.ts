/**
 * Every runner declares what it does with a person's uploads
 * (IRunner.uploadMedia), and a runner that grants gives its backend each
 * upload's own directory for that spawn only, never the uploads root. The
 * declaration is required by the type: the `@ts-expect-error` below fails
 * the type check if it ever becomes optional.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { IRunner } from './types.js';
import { CodexRunner } from './codex-runner.js';
import { GeminiRunner } from './gemini-runner.js';
import { AntigravityRunner, buildAgyArgs } from './antigravity-runner.js';
import { InkRunner } from './ink-runner.js';
import { HostedInkSessionRunner } from './hosted-ink-session.js';
import { ClaudeRunner } from './claude-runner.js';
import { setUploadsRoot } from '../uploads/runtime.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ROOT = '/home/u/.ink/uploads';
const U = '0a0a0a0a-0000-4000-8000-0000000000aa';
const W = '1c1c1c1c-0000-4000-8000-0000000000cc';
const A = '5a5a5a5a-0000-4000-8000-000000000001';
const B = '5a5a5a5a-0000-4000-8000-000000000002';
const dir = (id: string) => `${ROOT}/${U}/${W}/${id}`;
const upload = (id: string) => ({ type: 'image' as const, path: `${dir(id)}/${id}.jpg` });
const channelPhoto = { type: 'image' as const, path: '/home/u/.ink/files/telegram/p.jpg' };
const cfg = { workingDirectory: '/tmp', mcpConfigPath: '/tmp/.mcp.json', sbSlug: 'fern' };

// A runner that does not say what it does with uploads does not compile.
// @ts-expect-error uploadMedia is required on every IRunner
const undeclared: IRunner = {
  run: async () => ({ success: true, backendSessionId: null, responses: [] }),
};
void undeclared;

let prevStudios: string | undefined;

beforeEach(() => {
  prevStudios = process.env.INK_STUDIOS_ROOT;
  process.env.INK_STUDIOS_ROOT = join(tmpdir(), `ink-studios-runner-uploads-${process.pid}`);
  setUploadsRoot(ROOT);
});

afterEach(() => {
  rmSync(process.env.INK_STUDIOS_ROOT!, { recursive: true, force: true });
  if (prevStudios === undefined) delete process.env.INK_STUDIOS_ROOT;
  else process.env.INK_STUDIOS_ROOT = prevStudios;
  setUploadsRoot(null);
});

/** The args each runner spawns with, from its own run(). */
async function spawnArgs(
  runner: { run: IRunner['run'] },
  options: Record<string, unknown>
): Promise<string[]> {
  let captured: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runner as any).spawnProcess = vi.fn(async (args: string[]) => {
    captured = args;
    return { responses: [], toolCalls: [] };
  });
  await runner.run('Look at this', { config: cfg, ...options } as never);
  return captured;
}

const grantsOf = (args: string[], flag: string) =>
  args.map((a, i) => (a === flag ? args[i + 1] : null)).filter((d): d is string => !!d);

describe('every runner declares what it does with uploads', () => {
  it('grants on Claude, Codex, Gemini, Antigravity and ink; refuses on hosted ink', () => {
    expect(new ClaudeRunner().uploadMedia).toBe('grant');
    expect(new CodexRunner().uploadMedia).toBe('grant');
    expect(new GeminiRunner().uploadMedia).toBe('grant');
    expect(new AntigravityRunner().uploadMedia).toBe('grant');
    expect(new InkRunner().uploadMedia).toBe('grant');
    expect(new HostedInkSessionRunner({}).uploadMedia).toBe('refuse');
  });
});

describe.each([
  ['Codex', () => new CodexRunner(), '--add-dir'],
  ['Gemini', () => new GeminiRunner(), '--include-directories'],
  ['Antigravity', () => new AntigravityRunner(), '--add-dir'],
] as const)('%s with uploads', (_name, make, flag) => {
  it('grants each upload’s own directory once, for this spawn, and never the root', async () => {
    const args = await spawnArgs(make(), {
      mediaAttachments: [upload(A), channelPhoto, upload(B), upload(A)],
    });
    const uploadGrants = grantsOf(args, flag).filter((d) => d.startsWith(ROOT));
    expect(uploadGrants).toEqual([dir(A), dir(B)]);
    expect(grantsOf(args, flag)).not.toContain(ROOT);
  });

  it('grants nothing extra without uploads, or in a container', async () => {
    const plain = await spawnArgs(make(), { mediaAttachments: [channelPhoto] });
    expect(grantsOf(plain, flag).some((d) => d.startsWith(ROOT))).toBe(false);
    const runtimeDir = mkdtempSync(join(tmpdir(), 'ink-runner-uploads-c-'));
    let contained: string[];
    try {
      contained = await spawnArgs(make(), {
        config: { ...cfg, container: { name: 'c', runtimeDir } },
        mediaAttachments: [upload(A)],
      });
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
    expect(grantsOf(contained, flag).some((d) => d.startsWith(ROOT))).toBe(false);
  });
});

describe('Codex placement', () => {
  it('puts the upload grant before `resume`, where exec accepts it', async () => {
    const args = await spawnArgs(new CodexRunner(), {
      backendSessionId: 'thread-1',
      mediaAttachments: [upload(A)],
    });
    expect(args.indexOf(dir(A))).toBeGreaterThan(-1);
    expect(args.indexOf(dir(A))).toBeLessThan(args.indexOf('resume'));
  });
});

describe('Antigravity args', () => {
  it('adds each directory given, after the studios root', () => {
    const args = buildAgyArgs('m', cfg as never, undefined, [dir(A)]);
    expect(grantsOf(args, '--add-dir')).toContain(dir(A));
  });
});

describe('ink', () => {
  it('passes an upload’s original file as --attach-file, which ink chat reads itself', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args: string[] = (new InkRunner() as any).buildArgs('s-1', cfg, [upload(A)]);
    expect(grantsOf(args, '--attach-file')).toEqual([`${dir(A)}/${A}.jpg`]);
  });
});
