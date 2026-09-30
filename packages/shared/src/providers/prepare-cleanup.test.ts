import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// A disk fault on demand: the next writeFile writes a partial file and then
// fails, as a full disk does.
const faults = vi.hoisted(() => ({
  partialWriteOnce: false,
  /** When set, the next readFile fails with this errno code. */
  readErrorCode: undefined as string | undefined,
}));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const code = faults.readErrorCode;
      if (code) {
        faults.readErrorCode = undefined;
        throw Object.assign(new Error(`synthetic ${code}`), { code });
      }
      return actual.readFile(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (faults.partialWriteOnce) {
        faults.partialWriteOnce = false;
        await actual.writeFile(args[0], String(args[1]).slice(0, 8));
        throw new Error('synthetic ENOSPC');
      }
      return actual.writeFile(...args);
    },
  };
});

import { CodexAdapter } from './codex.js';
import { buildGeminiSettings, GeminiAdapter } from './gemini.js';
import { createIdentityPromptFile } from './identity-prompt.js';
import { buildMergedMcpConfig } from './skill-mcp.js';
import type { BackendAdapter, BackendHost } from './types.js';

/**
 * Per-spawn files live under the host's temp directory, are removed by the
 * prepared cleanup, and are removed by prepare() itself when it fails after
 * writing them: nothing ever receives the cleanup of a prepare that rejected
 * (Myra, P2b-2a review).
 */

let root: string;
let tempDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prepare-cleanup-'));
  tempDir = join(root, 'tmp');
  mkdirSync(tempDir);
});

afterEach(() => {
  faults.partialWriteOnce = false;
  faults.readErrorCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** A host whose studios root fails when read: a host call after the first write. */
function host(options: { failAfterWrite?: boolean } = {}): BackendHost {
  return {
    paths: {
      inkFiles: join(root, 'files'),
      get studiosRoot(): string {
        if (options.failAfterWrite) throw new Error('synthetic host failure');
        return join(root, 'studios');
      },
      tempDir,
    },
    ambientSession: () => ({}),
    claudeSupportsPartialMessages: async () => false,
    skillMcpServers: async () => [],
    sessionEnv: async () => ({}),
    baseEnv: async () => process.env,
    resolveBinary: async (name) => name,
    warn: () => undefined,
  };
}

const config = {
  sbSlug: 'wren',
  prompt: 'hello',
  promptParts: ['hello'],
  passthroughArgs: [],
  cliAttached: false,
};

/** Every file under the temp directory, and the identity-prompt directories. */
function left(): { files: string[]; identityDirs: string[] } {
  const entries = readdirSync(tempDir, { recursive: true, withFileTypes: true });
  return {
    files: entries.filter((e) => e.isFile()).map((e) => e.name),
    identityDirs: readdirSync(tempDir).filter((name) => name.startsWith('sb-')),
  };
}

// Myra's a601d0d9 review: for a spawn that named its session, only a missing
// .mcp.json is "no project config"; any other read error refuses.
describe('a project MCP config that cannot be read', () => {
  const build = (explicitSession: boolean) =>
    buildMergedMcpConfig(root, { explicitSession, skillServers: [], tempDir });

  it('refuses a named session with a fixed reason, and leaves nothing behind', async () => {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    faults.readErrorCode = 'EACCES';
    await expect(build(true)).rejects.toThrow('the project .mcp.json could not be read (EACCES)');
    expect(left().files).toEqual([]);
  });

  it('treats a missing file as no project config, named session or not', async () => {
    expect((await build(true)).mcpConfigPath).toBeNull();
    expect((await build(false)).mcpConfigPath).toBeNull();
  });

  it('lets a launcher treat an unreadable file as absent, as before', async () => {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    faults.readErrorCode = 'EACCES';
    expect((await build(false)).mcpConfigPath).toBeNull();
  });
});

// Myra's R2 and R3 (72027fba review): each writer removes what a failed
// write left, before the failure reaches its caller.
describe('a failed write leaves nothing behind', () => {
  it('the identity prompt removes its directory and the partial file', async () => {
    faults.partialWriteOnce = true;
    await expect(createIdentityPromptFile(tempDir, 'wren')).rejects.toThrow('synthetic ENOSPC');
    expect(left()).toEqual({ files: [], identityDirs: [] });
  });

  it('the MCP config builder removes the partial file and rejects', async () => {
    faults.partialWriteOnce = true;
    await expect(
      buildMergedMcpConfig(root, {
        skillServers: [{ name: 'synthetic-skill', command: 'npx', args: [] }],
        tempDir,
      })
    ).rejects.toThrow('synthetic ENOSPC');
    expect(left().files).toEqual([]);
  });

  it('the Gemini settings remove the partial file and report no settings', async () => {
    faults.partialWriteOnce = true;
    expect(await buildGeminiSettings(tempDir, root, 'synthetic-context')).toBeNull();
    expect(left().files).toEqual([]);
  });
});

describe.each([
  ['codex', () => new CodexAdapter()],
  ['gemini', () => new GeminiAdapter()],
] as Array<[string, () => BackendAdapter]>)('%s prepare', (_name, make) => {
  it('writes under the host’s temp directory, and its cleanup removes what it wrote', async () => {
    const prepared = await make().prepare({ ...config, cwd: root }, host());
    expect(left().identityDirs).toHaveLength(1);
    expect(left().files.length).toBeGreaterThan(0);
    await prepared.cleanup();
    expect(left()).toEqual({ files: [], identityDirs: [] });
  });

  it('removes what it wrote when a later host call fails', async () => {
    await expect(
      make().prepare({ ...config, cwd: root }, host({ failAfterWrite: true }))
    ).rejects.toThrow('synthetic host failure');
    expect(left()).toEqual({ files: [], identityDirs: [] });
  });
});
