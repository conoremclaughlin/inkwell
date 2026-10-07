/**
 * The ink chat runtime runs the launch completion before it reads its
 * studio scope (Lumen, PR #699 round 1, finding 3).
 *
 * `-b ink`, `ink chat` and `ink alpha` all enter through runChat, none of
 * them through the backend wrappers that got the launch completion in
 * this PR's first round, so a partial linked worktree launched as an ink
 * session started with no identity file and a session scoped to "main".
 * runChat now takes its identity from prepareChatStudio, which completes
 * first and reads second. Pinned here through the real chain
 * (prepareChatStudio → completeStudioAtLaunch → runInit → completeStudio)
 * on a temp worktree with a stubbed placement, the RPC mocked at ink-mcp,
 * registration and skills stubbed, and HOME isolated before anything
 * reads it. No chat session is started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { auditStudio } from '@inklabs/shared';

const isolated = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pr699-chat-home-'));
  process.env.HOME = home;
  return { home };
});

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/ink-mcp.js', () => ({
  callInkTool: rpc.call,
  getInkServerUrl: () => 'http://127.0.0.1:1',
}));

import { prepareChatStudio } from './chat.js';
import { runInit } from './init.js';

let root: string;
let studio: string;
let main: string;
const STUDIO_ID = '00000000-0000-4000-8000-000000000699';
const placement = () => ({ toplevel: studio, mainRoot: main, linked: true });
const deps = () => {
  const init = {
    register: vi.fn(async () => null),
    syncSkills: vi.fn(async () => ({ label: 'skills', status: 'skipped' as const })),
    lookupBackend: vi.fn(async (slug: string) => (slug === 'lumen' ? 'codex' : 'claude')),
  };
  return {
    placement,
    // Stubbed at both layers: runInit reads the placement for itself, and a
    // temp directory is not a git worktree.
    runInit: (cwd: string, opts: Parameters<typeof runInit>[1]) =>
      runInit(cwd, opts, { ...init, placement }),
  };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pr699-chat-'));
  studio = join(root, 'repo--owner');
  main = join(root, 'repo');
  mkdirSync(studio);
  mkdirSync(main);
  rpc.call.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  rmSync(join(isolated.home, '.ink'), { recursive: true, force: true });
});

describe('prepareChatStudio', () => {
  it('completes a partial linked worktree for its row owner BEFORE reading the identity the session is scoped by', async () => {
    rpc.call.mockResolvedValueOnce({ studio: { id: STUDIO_ID, sbSlug: 'lumen' } });
    expect(auditStudio(studio, { linked: true }).complete).toBe(false);
    const { identity } = await prepareChatStudio(studio, 'wren', deps());
    // The identity handed to the chat runtime is the one the completion
    // just wrote: the row's owner and the studio id the session will carry.
    expect(identity).toMatchObject({ sbSlug: 'lumen', studioId: STUDIO_ID, backend: 'codex' });
    expect(auditStudio(studio, { linked: true }).complete).toBe(true);
  });

  it('with no answer from the server it completes what needs no owner and hands back no identity', async () => {
    rpc.call.mockRejectedValueOnce(new Error('fetch failed'));
    const { identity } = await prepareChatStudio(studio, 'wren', deps());
    expect(identity).toBeNull();
    expect(existsSync(join(studio, '.ink', 'identity.json'))).toBe(false);
    // Permissions wait for an answer too (design v3, item 5): their profile
    // comes from the studio row the server could not return.
    expect(auditStudio(studio, { linked: true }).missing).toEqual([
      'identity',
      'studio-id',
      'claude-permissions',
    ]);
  });

  it('an existing identity is read as it is when the studio is already complete', async () => {
    // Complete it once through the same path, then the second call must not ask the server.
    rpc.call.mockResolvedValueOnce({ studio: { id: STUDIO_ID, sbSlug: 'lumen' } });
    await prepareChatStudio(studio, 'wren', deps());
    rpc.call.mockReset();
    const { identity } = await prepareChatStudio(studio, 'wren', deps());
    expect(identity?.studioId).toBe(STUDIO_ID);
    expect(rpc.call).not.toHaveBeenCalled();
  });

  // Lumen's round-2 reproduction, as delivered: the completion resolved the
  // nested cwd to the worktree root and wrote the identity there, and the
  // read that followed used the nested cwd, so the runtime got null after a
  // successful repair.
  it('returns the repaired worktree identity when chat starts inside a package directory', async () => {
    const nested = join(studio, 'packages', 'api');
    mkdirSync(nested, { recursive: true });
    rpc.call.mockResolvedValueOnce({ studio: { id: STUDIO_ID, sbSlug: 'lumen' } });
    const { identity } = await prepareChatStudio(nested, 'wren', deps());
    expect(auditStudio(studio, { linked: true }).complete).toBe(true);
    expect(identity).toMatchObject({ sbSlug: 'lumen', studioId: STUDIO_ID, backend: 'codex' });
    expect(existsSync(join(nested, '.ink', 'identity.json'))).toBe(false);
  });

  it('an already-complete worktree launched from a package directory hands back its root identity', async () => {
    rpc.call.mockResolvedValueOnce({ studio: { id: STUDIO_ID, sbSlug: 'lumen' } });
    await prepareChatStudio(studio, 'wren', deps());
    rpc.call.mockReset();
    const nested = join(studio, 'packages', 'cli');
    mkdirSync(nested, { recursive: true });
    const { identity } = await prepareChatStudio(nested, 'wren', deps());
    expect(identity?.studioId).toBe(STUDIO_ID);
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it('outside a repository the cwd is the root: nothing is completed and the identity there is read', async () => {
    const loose = join(root, 'loose');
    mkdirSync(join(loose, '.ink'), { recursive: true });
    writeFileSync(join(loose, '.ink', 'identity.json'), JSON.stringify({ sbSlug: 'wren' }));
    const { identity } = await prepareChatStudio(loose, 'wren', {
      placement: () => ({ toplevel: null, mainRoot: null, linked: false }),
    });
    expect(identity).toEqual({ sbSlug: 'wren' });
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it('the main worktree is never completed from a chat launch', async () => {
    mkdirSync(join(main, '.ink'), { recursive: true });
    writeFileSync(join(main, '.ink', 'identity.json'), JSON.stringify({ sbSlug: 'wren' }));
    const { identity } = await prepareChatStudio(main, 'wren', {
      placement: () => ({ toplevel: main, mainRoot: null, linked: false }),
    });
    expect(identity).toEqual({ sbSlug: 'wren' });
    expect(rpc.call).not.toHaveBeenCalled();
  });
});
