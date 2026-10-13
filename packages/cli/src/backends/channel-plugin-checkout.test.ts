import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeAdapter } from '@inklabs/shared/providers';
import { createCliBackendHost } from './cli-host.js';
import { resolveChannelPluginPath } from '../lib/skill-mcp.js';

const checkout = vi.hoisted(() => ({ main: null as string | null }));
vi.mock('../lib/ink-checkout.js', () => ({ inkCliMainWorktree: () => checkout.main }));

describe('the CLI channel checkout survives provider extraction', () => {
  let root: string;
  let project: string;
  let plugin: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ink-channel-checkout-'));
    project = join(root, 'app');
    checkout.main = join(root, 'trusted-main');
    plugin = join(checkout.main, 'packages', 'channel-plugin', 'index.ts');
    await mkdir(join(checkout.main, 'packages', 'channel-plugin'), { recursive: true });
    await mkdir(project);
    await writeFile(plugin, '// synthetic plugin; never executed');
    await writeFile(
      join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { inkmail: { command: 'ignored', args: ['untrusted'] } } })
    );
  });

  afterEach(async () => {
    checkout.main = null;
    await rm(root, { recursive: true, force: true });
  });

  it('gives init and the async provider the same host-resolved fallback', async () => {
    const cliHost = createCliBackendHost();
    expect(cliHost.paths.channelPluginCheckout).toBe(checkout.main);
    expect(resolveChannelPluginPath(project)).toBe(plugin);
    const prepared = await new ClaudeAdapter().prepare(
      {
        cwd: project,
        sbSlug: 'echo',
        prompt: 'hello',
        promptParts: [],
        passthroughArgs: [],
        toolRouting: 'local',
        explicitSession: true,
        cliAttached: true,
      },
      {
        ...cliHost,
        paths: {
          ...cliHost.paths,
          inkFiles: join(root, 'files'),
          studiosRoot: join(root, 'studios'),
          tempDir: root,
        },
        claudeSupportsPartialMessages: async () => false,
        baseEnv: async () => ({}),
        sessionEnv: async () => ({}),
        skillMcpServers: async () => [],
      }
    );
    try {
      const path = prepared.args[prepared.args.indexOf('--mcp-config') + 1]!;
      const config = JSON.parse(await readFile(path, 'utf8'));
      expect(config.mcpServers).toEqual({
        inkmail: { type: 'stdio', command: 'npx', args: ['tsx', plugin] },
      });
      expect(prepared.args).toContain('--strict-mcp-config');
      expect(prepared.args).toContain('--dangerously-load-development-channels');
    } finally {
      await prepared.cleanup();
    }
  });

  it('keeps fallback resolution host-owned and reads it when asked', () => {
    const host = createCliBackendHost();
    checkout.main = null;
    expect(host.paths.channelPluginCheckout).toBeUndefined();
    expect(resolveChannelPluginPath(project)).toBeNull();
  });
});
