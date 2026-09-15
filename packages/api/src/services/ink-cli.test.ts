/**
 * The server resolves the ink CLI from its own checkout (or INK_CLI_PATH),
 * never from the global ~/.ink/bin/ink link. That link points at whichever
 * checkout the OB last chose; a server following it would run some other
 * checkout's CLI for every hook and chat loop it spawns (AGENTS.md, "The
 * Global ink CLI Link").
 */

import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const warnMock = vi.fn();
vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: (...a: unknown[]) => warnMock(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  INK_CLI_PATH_ENV,
  findOwnCheckoutRoot,
  inkCliCommand,
  inkCliSpawn,
  resetInkCliWarnings,
  resolveInkCli,
  shellQuote,
} from './ink-cli';

interface FakeCheckout {
  root: string;
  /** A directory as deep inside the checkout as this module lives. */
  startDir: string;
  cli: string;
}

async function makeCheckout(opts: { built: boolean }): Promise<FakeCheckout> {
  const root = await mkdtemp(join(tmpdir(), 'ink-cli-'));
  await mkdir(join(root, 'packages', 'cli', 'dist'), { recursive: true });
  await writeFile(join(root, 'packages', 'cli', 'package.json'), '{"name":"@inklabs/cli"}\n');
  const startDir = join(root, 'packages', 'api', 'src', 'services');
  await mkdir(startDir, { recursive: true });
  const cli = join(root, 'packages', 'cli', 'dist', 'cli.js');
  if (opts.built) await writeFile(cli, '#!/usr/bin/env node\n', { mode: 0o644 });
  return { root, startDir, cli };
}

const tempDirs: string[] = [];

async function checkout(opts: { built: boolean }): Promise<FakeCheckout> {
  const made = await makeCheckout(opts);
  tempDirs.push(made.root);
  return made;
}

beforeEach(() => {
  warnMock.mockClear();
  resetInkCliWarnings();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('findOwnCheckoutRoot', () => {
  it("finds this repository from the module's own directory", () => {
    const root = findOwnCheckoutRoot();
    expect(root).toBe(resolve(__dirname, '..', '..', '..', '..'));
  });

  it('returns null when no checkout lies above the start directory', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'ink-cli-bare-'));
    tempDirs.push(bare);
    expect(findOwnCheckoutRoot(bare)).toBeNull();
  });
});

describe('resolveInkCli', () => {
  it("uses this checkout's own build, as a script", async () => {
    const { startDir, cli } = await checkout({ built: true });
    expect(resolveInkCli({ env: {}, startDir })).toEqual({
      path: cli,
      source: 'checkout',
      script: true,
    });
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('never consults the global link, even when one exists and the checkout is unbuilt', async () => {
    const { startDir } = await checkout({ built: false });
    const home = await mkdtemp(join(tmpdir(), 'ink-cli-home-'));
    tempDirs.push(home);
    await mkdir(join(home, '.local', 'bin'), { recursive: true });
    await mkdir(join(home, '.ink', 'bin'), { recursive: true });
    await writeFile(join(home, '.local', 'bin', 'ink'), '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(join(home, '.ink', 'bin', 'ink'), '#!/bin/sh\n', { mode: 0o755 });

    expect(resolveInkCli({ env: { HOME: home }, startDir })).toBeNull();
  });

  it('warns once, with the build command, when the checkout has no build', async () => {
    const { startDir, root } = await checkout({ built: false });
    expect(resolveInkCli({ env: {}, startDir })).toBeNull();
    expect(resolveInkCli({ env: {}, startDir })).toBeNull();
    expect(warnMock).toHaveBeenCalledTimes(1);
    const [message, meta] = warnMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain('yarn workspace @inklabs/cli build');
    expect(meta.checkoutRoot).toBe(root);
  });

  it('picks up a build that lands after the first call', async () => {
    const { startDir, cli } = await checkout({ built: false });
    expect(resolveInkCli({ env: {}, startDir })).toBeNull();
    await writeFile(cli, '#!/usr/bin/env node\n');
    expect(resolveInkCli({ env: {}, startDir })?.path).toBe(cli);
  });

  it('lets INK_CLI_PATH override the checkout build', async () => {
    const { startDir } = await checkout({ built: true });
    const elsewhere = await checkout({ built: true });
    const env = { [INK_CLI_PATH_ENV]: elsewhere.cli };
    expect(resolveInkCli({ env, startDir })).toEqual({
      path: elsewhere.cli,
      source: 'env',
      script: true,
    });
  });

  it('treats an extensionless INK_CLI_PATH as an executable, not a script', async () => {
    const { startDir, root } = await checkout({ built: true });
    const bin = join(root, 'ink');
    await writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
    expect(resolveInkCli({ env: { [INK_CLI_PATH_ENV]: bin }, startDir })).toEqual({
      path: bin,
      source: 'env',
      script: false,
    });
  });

  it('ignores an INK_CLI_PATH that does not exist, warning once, and falls back to the checkout', async () => {
    const { startDir, cli, root } = await checkout({ built: true });
    const env = { [INK_CLI_PATH_ENV]: join(root, 'nope', 'cli.js') };
    expect(resolveInkCli({ env, startDir })?.path).toBe(cli);
    expect(resolveInkCli({ env, startDir })?.path).toBe(cli);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(warnMock.mock.calls[0][0])).toContain(INK_CLI_PATH_ENV);
  });

  it('refuses a relative INK_CLI_PATH', async () => {
    const { startDir, cli } = await checkout({ built: true });
    const env = { [INK_CLI_PATH_ENV]: join('packages', 'cli', 'dist', 'cli.js') };
    expect(resolveInkCli({ env, startDir })?.path).toBe(cli);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});

describe('invocation forms', () => {
  it('runs a script through node on a hook command line, quoting only when needed', () => {
    expect(
      inkCliCommand({ path: '/srv/ink/packages/cli/dist/cli.js', source: 'checkout', script: true })
    ).toBe('node /srv/ink/packages/cli/dist/cli.js');
    expect(inkCliCommand({ path: '/Users/o b/ink/cli.js', source: 'env', script: true })).toBe(
      'node "/Users/o b/ink/cli.js"'
    );
    expect(inkCliCommand({ path: '/usr/local/bin/ink', source: 'env', script: false })).toBe(
      '/usr/local/bin/ink'
    );
  });

  it("spawns a script through this server's own node binary", () => {
    expect(
      inkCliSpawn({ path: '/srv/ink/packages/cli/dist/cli.js', source: 'checkout', script: true })
    ).toEqual({
      command: process.execPath,
      args: ['/srv/ink/packages/cli/dist/cli.js'],
    });
    expect(inkCliSpawn({ path: '/usr/local/bin/ink', source: 'env', script: false })).toEqual({
      command: '/usr/local/bin/ink',
      args: [],
    });
  });

  it('shellQuote escapes the characters a double-quoted shell word interprets', () => {
    expect(shellQuote('/plain/path-1.2_3')).toBe('/plain/path-1.2_3');
    expect(shellQuote('/has space/x')).toBe('"/has space/x"');
    expect(shellQuote('/has"quote/$HOME/`x`')).toBe('"/has\\"quote/\\$HOME/\\`x\\`"');
  });
});
