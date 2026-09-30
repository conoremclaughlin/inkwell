import { EventEmitter } from 'events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeContextToken } from '../runner/mcp-config.js';
import { startBackendTurn } from './backend-runner.js';
import type { BackendHost } from './types.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeChild() {
  const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  return Object.assign(new EventEmitter(), {
    stdout: stream(),
    stderr: stream(),
    stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
    kill: vi.fn(),
  });
}

// Real preparation and runner, fake OS boundary. No provider, MCP server,
// shell command or signal ever runs. Studio paths are under this test's root;
// the adapter's temporary MCP files are removed by its normal cleanup.
describe('overlapping provider turns in one process', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'provider-concurrent-'));
    spawn.mockReset();
    vi.stubEnv('INK_ACCESS_TOKEN', 'synthetic-host-token');
    vi.stubEnv('INK_SESSION_ID', 'synthetic-host-session');
    vi.stubEnv('INK_STUDIO_ID', 'synthetic-host-studio');
    // This process's own HOME: a child must get its host's, never this.
    vi.stubEnv('HOME', '/synthetic/runner-process-home');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps credentials, cwd, files, output and cancellation scoped when preparation finishes out of order', async () => {
    const firstReady = deferred<void>();
    const secondReady = deferred<void>();
    const firstChild = fakeChild();
    const secondChild = fakeChild();
    const children = [firstChild, secondChild];
    const turns: ReturnType<typeof startBackendTurn>[] = [];
    const spawnRecords: Array<{
      cwd: string;
      env: Record<string, string>;
      configPath: string;
    }> = [];
    const makeRequest = (name: string, ready: Promise<void>) => {
      const cwd = join(root, name);
      mkdirSync(cwd);
      writeFileSync(
        join(cwd, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            inkwell: { type: 'http', url: 'http://127.0.0.1:9/mcp' },
            [name]: { type: 'http', url: `http://127.0.0.1:9/${name}` },
          },
        })
      );
      const host: BackendHost = {
        paths: {
          inkFiles: join(cwd, 'files'),
          studiosRoot: join(cwd, 'studios'),
          // One temp directory for both, as a server serving both sessions
          // has: per-spawn file names must not collide within it.
          tempDir: join(root, 'tmp'),
        },
        ambientSession: () => {
          throw new Error('explicit hosts never use ambient routing');
        },
        claudeSupportsPartialMessages: async () => false,
        skillMcpServers: async () => {
          await ready;
          return [];
        },
        sessionEnv: async () => ({ INK_ACCESS_TOKEN: `synthetic-${name}-token` }),
        // Each host's own base env: an allowlisted name with this host's
        // value, a name the allowlist does not carry, and a credential the
        // host holds but did not hand over through sessionEnv.
        baseEnv: async () => ({
          HOME: `/synthetic/${name}/home`,
          SYNTHETIC_HOST_ONLY: 'synthetic-host-only',
          INK_ACCESS_TOKEN: 'synthetic-host-base-token',
        }),
        resolveBinary: async () => 'synthetic-provider-never-executed',
        warn: () => undefined,
      };
      return {
        backend: 'claude',
        sbSlug: name,
        prompt: `synthetic ${name}`,
        cliAttached: false,
        workingDirectory: cwd,
        inkSessionId: `${name}-session`,
        studioId: `${name}-studio`,
        host,
      };
    };
    const first = makeRequest('first', firstReady.promise);
    const second = makeRequest('second', secondReady.promise);
    spawn.mockImplementation(
      (
        _binary: string,
        args: string[],
        options: {
          cwd: string;
          env: Record<string, string>;
        }
      ) => {
        const configPath = args[args.indexOf('--mcp-config') + 1]!;
        spawnRecords.push({ cwd: options.cwd, env: options.env, configPath });
        return options.cwd === first.workingDirectory ? firstChild : secondChild;
      }
    );
    try {
      const a = startBackendTurn(first);
      const b = startBackendTurn(second);
      turns.push(a, b);
      let secondSettled = false;
      void b.result.then(() => {
        secondSettled = true;
      });

      // Both are preparing; the later request reaches spawn first.
      secondReady.resolve();
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      expect(spawnRecords[0]!.cwd).toBe(second.workingDirectory);
      firstReady.resolve();
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

      for (const request of [first, second]) {
        const child = spawnRecords.find((record) => record.cwd === request.workingDirectory)!;
        expect(child.env.INK_ACCESS_TOKEN).toBe(`synthetic-${request.sbSlug}-token`);
        expect(decodeContextToken(child.env.INK_CONTEXT)).toMatchObject({
          sessionId: request.inkSessionId,
          studioId: request.studioId,
          cliAttached: false,
        });
        expect(JSON.stringify(child.env)).not.toContain('synthetic-host');
        // The base env is the host's, and only the allowlist crosses from it.
        expect(child.env.HOME).toBe(`/synthetic/${request.sbSlug}/home`);
        expect(child.env).not.toHaveProperty('SYNTHETIC_HOST_ONLY');
        expect(JSON.stringify(child.env)).not.toContain('runner-process-home');
        const servers = JSON.parse(readFileSync(child.configPath, 'utf8')).mcpServers;
        expect(Object.keys(servers).sort()).toEqual([request.sbSlug, 'inkwell'].sort());
      }
      const firstConfig = spawnRecords[1]!.configPath;
      const secondConfig = spawnRecords[0]!.configPath;
      expect(firstConfig).not.toBe(secondConfig);
      firstChild.stdout.emit('data', 'first output');
      secondChild.stdout.emit('data', 'second output');

      a.abort();
      expect(firstChild.kill.mock.calls).toEqual([['SIGTERM']]);
      expect(secondChild.kill).not.toHaveBeenCalled();
      expect(existsSync(firstConfig)).toBe(true); // Signal is not settlement.
      firstChild.emit('close', null, 'SIGTERM');
      expect(await a.result).toMatchObject({ exitCode: 143, stdout: 'first output' });
      expect(existsSync(firstConfig)).toBe(false);
      expect(existsSync(secondConfig)).toBe(true);
      expect(secondSettled).toBe(false);

      secondChild.stdout.emit('data', ' continues');
      secondChild.emit('close', 0);
      expect(await b.result).toMatchObject({ success: true, stdout: 'second output continues' });
      expect(existsSync(secondConfig)).toBe(false);
    } finally {
      // Even failed assertions settle both fake children and their timers.
      firstReady.resolve();
      secondReady.resolve();
      for (const turn of turns) turn.abort();
      for (const child of children) child.emit('close', null, 'SIGTERM');
      await Promise.allSettled(turns.map((turn) => turn.result));
    }
  });
});
