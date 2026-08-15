/**
 * Concurrency safety for the host-global agy MCP config write.
 *
 * There is no lock here any more, and that is the fix rather than a retreat.
 * Four hand-rolled schemes failed the same way — POSIX has no atomic
 * compare-and-delete, so "check the owner, then remove it" always leaves a
 * window — and proper-lockfile could not close it either: its mtime heartbeat
 * cannot see a lock stolen and replaced between two ticks, and this critical
 * section finishes well inside one tick. Lumen demonstrated exactly that
 * (steal the lock, return immediately, withFileLock still reports success).
 *
 * The lock was also guarding the wrong thing. Every Ink server now writes an
 * IDENTICAL inkwell entry, so Ink-versus-Ink is not a conflict at all; and the
 * writers that ARE a conflict — a human editing the file, agy itself — never
 * take our lock.
 *
 * These assert the properties that actually matter: convergence under real
 * concurrency, preservation of foreign keys, atomic publication, and fail-closed
 * on a file we cannot read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

const hoisted = vi.hoisted(() => ({
  home: '',
  /** Fires once, right after the config candidate is staged but before it is published. */
  afterCandidateStaged: null as null | (() => void),
}));

// A passthrough by default. The hook exists because the window under test —
// between staging the candidate and renaming it into place — cannot be hit
// from outside; and an ESM namespace cannot be spied on after import.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    writeFile: async (path: unknown, data: unknown, options: unknown) => {
      const result = await (actual.writeFile as (...a: unknown[]) => Promise<void>)(
        path,
        data,
        options
      );
      const name = String(path);
      if (hoisted.afterCandidateStaged && name.includes('mcp_config') && name.endsWith('.tmp')) {
        const hook = hoisted.afterCandidateStaged;
        hoisted.afterCandidateStaged = null;
        hook();
      }
      return result;
    },
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => hoisted.home };
});

import { AntigravityRunner, launcherPath } from './antigravity-runner.js';

let home: string;
let configPath: string;

const ensure = (runner: AntigravityRunner) =>
  (runner as unknown as { ensureGlobalMcpConfig: () => Promise<string> }).ensureGlobalMcpConfig();

const readConfig = () =>
  JSON.parse(readFileSync(configPath, 'utf-8')) as {
    mcpServers: Record<string, unknown>;
  };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agy-cfg-'));
  hoisted.home = home;
  configPath = join(home, '.gemini', 'config', 'mcp_config.json');
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('concurrent writers', () => {
  it('converges on the same entry from eight simultaneous writers', async () => {
    await Promise.all(Array.from({ length: 8 }, () => ensure(new AntigravityRunner())));

    expect(readConfig().mcpServers.inkwell).toEqual({ command: launcherPath(), args: [] });
  }, 20_000);

  it('preserves a foreign server through concurrent writes', async () => {
    // The only loss a lock could ever have prevented, and the one the
    // re-read-before-publish check is actually for.
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { sqlite: { command: 'sqlite-mcp-server' } } })
    );

    await Promise.all(Array.from({ length: 8 }, () => ensure(new AntigravityRunner())));

    const written = readConfig();
    expect(written.mcpServers.sqlite).toEqual({ command: 'sqlite-mcp-server' });
    expect(written.mcpServers.inkwell).toBeDefined();
  }, 20_000);

  it('publishes atomically, so no reader can observe a partial config', async () => {
    // Poll the file while writers churn. writeFile truncates in place; rename
    // does not. Any unparseable read here would mean a reader could see a
    // config with no servers at all and start agy toolless.
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ mcpServers: { sqlite: { command: 'x' } } }));

    let torn = 0;
    let reads = 0;
    const poller = setInterval(() => {
      try {
        const raw = readFileSync(configPath, 'utf-8');
        reads += 1;
        JSON.parse(raw);
      } catch (error) {
        // ENOENT is impossible with rename; a JSON error means a torn read.
        if (!(error as NodeJS.ErrnoException).code) torn += 1;
      }
    }, 1);

    await Promise.all(Array.from({ length: 12 }, () => ensure(new AntigravityRunner())));
    clearInterval(poller);

    expect(reads).toBeGreaterThan(0);
    expect(torn).toBe(0);
  }, 20_000);

  it('leaves no scratch files behind', async () => {
    await Promise.all(Array.from({ length: 8 }, () => ensure(new AntigravityRunner())));

    expect(readdirSync(dirname(configPath)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  }, 20_000);
});

describe('a foreign writer that moves the file mid-merge', () => {
  it('rebuilds on the new base instead of clobbering it', async () => {
    // Lumen's steal-then-return-immediately schedule, in the shape it takes
    // without a lock: a foreign write lands after our read, so the merge in
    // flight is already stale. Renaming it over the top would erase the
    // newcomer. The confirming re-read turns that into a retry.
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));

    let injected = false;
    hoisted.afterCandidateStaged = () => {
      injected = true;
      writeFileSync(
        configPath,
        JSON.stringify({ mcpServers: { latecomer: { command: 'other' } } })
      );
    };

    await ensure(new AntigravityRunner());

    expect(injected).toBe(true);
    const written = readConfig();
    expect(written.mcpServers.inkwell).toBeDefined();
    expect(written.mcpServers.latecomer).toEqual({ command: 'other' });
  }, 20_000);
});

describe('fail closed', () => {
  it('refuses the spawn and preserves a file it cannot parse', async () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, '{ not json');

    await expect(ensure(new AntigravityRunner())).rejects.toThrow(/refusing to start agy/);
    expect(readFileSync(configPath, 'utf-8')).toBe('{ not json');
  });

  it('treats an absent file as installable rather than as an error', async () => {
    await expect(ensure(new AntigravityRunner())).resolves.toMatch(
      /antigravity-mcp-bridge-[0-9a-f]{16}\.mjs$/
    );
  });
});
