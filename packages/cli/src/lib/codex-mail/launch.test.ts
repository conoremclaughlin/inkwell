import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendHost } from '@inklabs/shared/providers';
import { splitCodexMailArgs } from './launch.js';
import { hasTrustedCodexMailHooks, modernCodexMailHooks, codexMailHooks } from './hooks.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const id = '00000000-0000-4000-8000-000000000001';
describe('native Codex live-mail launch mapping', () => {
  it('preserves identity and auth config on the owner, permissions and roots on exact thread requests', () => {
    const result = splitCodexMailArgs(
      [
        'resume',
        id,
        '-c',
        'model_instructions_file="/tmp/fixture identity"',
        '-c',
        'mcp_servers.inkwell.env_http_headers.x-ink-context="INK_CONTEXT"',
        '--add-dir',
        '../studios',
        '--sandbox',
        'read-only',
        '--model',
        'fixture',
        '--no-alt-screen',
      ],
      '/workspace'
    );
    expect(result.serverArgs).toContain('model_instructions_file="/tmp/fixture identity"');
    expect(result.serverArgs).toContain(
      'mcp_servers.inkwell.env_http_headers.x-ink-context="INK_CONTEXT"'
    );
    expect(result.tuiArgs).toEqual(['--no-alt-screen', 'resume', id]);
    expect(result.threadOverrides).toEqual({
      sandbox: 'read-only',
      model: 'fixture',
      runtimeWorkspaceRoots: ['/workspace', '/studios'],
    });
  });
  it('maps yolo only when explicitly supplied and preserves later narrowing', () => {
    expect(splitCodexMailArgs([], '/fixture').threadOverrides).toEqual({});
    expect(
      splitCodexMailArgs(
        ['--dangerously-bypass-approvals-and-sandbox', '--sandbox', 'read-only'],
        '/fixture'
      ).threadOverrides
    ).toEqual({ sandbox: 'read-only', approvalPolicy: 'never' });
  });
  it.each([
    ['--profile', 'custom'],
    ['--remote', 'unix://other'],
    ['--no-daemon'],
    ['exec'],
    ['--sandbox', 'bad'],
    ['resume', 'latest'],
  ])('refuses unimplemented launch syntax rather than ignoring it: %j', (...args) => {
    expect(() => splitCodexMailArgs(args, '/fixture')).toThrow();
  });
  it('preserves ordered feature and config overrides', () => {
    expect(
      splitCodexMailArgs(
        ['--enable', 'fixture', '--disable', 'fixture', '--search', '--config=model="fixture"'],
        '/fixture'
      ).serverArgs
    ).toEqual([
      'app-server',
      '--listen',
      'stdio://',
      '--enable',
      'fixture',
      '--disable',
      'fixture',
      '-c',
      'web_search="live"',
      '--config=model="fixture"',
    ]);
  });
  it.each([false, true])('accepts real interactive adapter output, resume=%s', async (resume) => {
    const dir = mkdtempSync(join(tmpdir(), 'ink-mail-adapter-'));
    dirs.push(dir);
    vi.stubEnv('HOME', dir);
    vi.stubEnv('INK_CODEX_INKMAIL', '1');
    vi.stubEnv('TMPDIR', dir);
    vi.stubEnv('INK_STUDIOS_ROOT', join(dir, 'studios'));
    const { CodexAdapter } = await import('../../backends/codex.js');
    const host: BackendHost = {
      paths: { inkFiles: join(dir, 'files'), studiosRoot: join(dir, 'studios'), tempDir: dir },
      ambientSession: () => ({}),
      claudeSupportsPartialMessages: async () => false,
      skillMcpServers: async () => [],
      sessionEnv: async () => ({}),
      baseEnv: async () => ({ HOME: dir, INK_CODEX_INKMAIL: '1' }),
      inkwellMcpUrl: 'http://127.0.0.1:9/mcp',
      resolveBinary: async () => '/synthetic/codex',
      warn: () => undefined,
    };
    const prepared = await new CodexAdapter().prepare(
      {
        sbSlug: 'fixture',
        inkSessionId: id,
        studioId: id,
        cliAttached: true,
        systemPromptOverride: 'Synthetic fixture identity',
        model: 'fixture-model',
        promptParts: [],
        passthroughArgs: ['--no-alt-screen'],
        dangerous: true,
        ...(resume ? { backendSessionId: id } : {}),
      },
      host
    );
    try {
      const result = splitCodexMailArgs(prepared.args, dir);
      expect(result.tuiArgs).toEqual(
        resume ? ['--no-alt-screen', 'resume', id] : ['--no-alt-screen']
      );
      expect(result.serverArgs).toContain(
        'mcp_servers.inkwell.bearer_token_env_var="INK_ACCESS_TOKEN"'
      );
      expect(result.serverArgs.some((arg) => arg.startsWith('model_instructions_file='))).toBe(
        true
      );
      expect(result.threadOverrides).toMatchObject({
        model: 'fixture-model',
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        runtimeWorkspaceRoots: [dir, join(dir, 'studios')],
      });
      expect(prepared.env).toMatchObject({
        INK_SESSION_ID: id,
        INK_STUDIO_ID: id,
        INK_CHANNEL_HOST: 'codex',
        INK_CODEX_INKMAIL: '0',
      });
    } finally {
      await prepared.cleanup();
    }
  });
});
const legacy = `model="fixture"\n# ink-managed:hooks:start\n[hooks]\nsession_start = "ink hooks on-session-start --backend codex"\nsession_end = "ink hooks on-stop --backend codex"\nuser_prompt = "ink hooks on-prompt --backend codex"\n# ink-managed:hooks:end\n[custom]\nvalue=true\n`;
describe('guarded modern hook migration', () => {
  it('changes only the known managed legacy stanza and is idempotent', () => {
    const result = modernCodexMailHooks(legacy, "'node' '/fixture/cli.js'");
    expect(result.content).toContain('[[hooks.UserPromptSubmit.hooks]]');
    expect(result.content).toContain('[[hooks.Stop.hooks]]');
    expect(result.content).toContain('[custom]\nvalue=true');
    expect(result.content).not.toContain('user_prompt =');
    expect(modernCodexMailHooks(result.content, "'node' '/fixture/cli.js'").content).toBe(
      result.content
    );
  });
  it('upgrades the exact previous unguarded bridge block without touching other config', () => {
    const prefix = "'node' '/fixture/cli.js'";
    const current = modernCodexMailHooks(legacy, prefix);
    const previous = current.content.replaceAll(' --codex-inkmail-only', '');
    expect(modernCodexMailHooks(previous, prefix).content).toBe(current.content);
    expect(current.hooks.every((h) => h.command.endsWith('--codex-inkmail-only'))).toBe(true);
    expect(() =>
      modernCodexMailHooks(previous.replace('timeout = 60', 'timeout = 30'), prefix)
    ).toThrow('modified hook block');
  });
  it('refuses missing, custom, incomplete, or modified blocks', () => {
    for (const value of [
      '',
      legacy.replace('ink hooks on-stop', 'custom-hook'),
      legacy.replace('# ink-managed:hooks:end', ''),
      legacy.replace('[hooks]', '[hooks]\ncustom="keep me"'),
    ]) {
      expect(() => modernCodexMailHooks(value, 'node fixture')).toThrow();
    }
  });
  it.each([false, true])(
    'regenerates the exact known modern shape after launcher relocation, guarded=%s',
    (guarded) => {
      const previous = modernCodexMailHooks(legacy, "'node-old' '/old/cli.js'").content;
      const old = guarded ? previous : previous.replaceAll(' --codex-inkmail-only', '');
      const moved = modernCodexMailHooks(old, "'node-new' '/new/cli.js'");
      expect(moved.content).toBe(modernCodexMailHooks(legacy, "'node-new' '/new/cli.js'").content);
      for (const custom of [
        old.replace('timeout = 60', 'timeout = 30'),
        old.replace('on-stop', 'custom-stop'),
        old.replace('# ink-managed:hooks:end', '# custom\n# ink-managed:hooks:end'),
      ]) {
        expect(() => modernCodexMailHooks(custom, "'node-new' '/new/cli.js'")).toThrow(
          'will not overwrite'
        );
      }
    }
  );
  it('generates guarded session hooks without requiring or writing a project file', () => {
    expect(codexMailHooks().map((h) => h.event)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
    ]);
    expect(codexMailHooks().every((h) => h.command.endsWith('--codex-inkmail-only'))).toBe(true);
  });
  it('requires exactly one enabled and trusted copy of each required handler', () => {
    const expected = modernCodexMailHooks(legacy, 'node fixture').hooks;
    const hooks = expected.map((h) => ({ ...h, enabled: true, trustStatus: 'trusted' }));
    expect(hasTrustedCodexMailHooks({ data: [{ hooks, errors: [] }] }, expected)).toBe(true);
    for (const change of [
      { enabled: false },
      { trustStatus: 'modified' },
      { trustStatus: 'untrusted' },
      { command: 'other' },
    ]) {
      expect(
        hasTrustedCodexMailHooks(
          { data: [{ hooks: [{ ...hooks[0], ...change }, ...hooks.slice(1)], errors: [] }] },
          expected
        )
      ).toBe(false);
    }
    expect(
      hasTrustedCodexMailHooks({ data: [{ hooks: [...hooks, hooks[0]], errors: [] }] }, expected)
    ).toBe(false);
  });
});
