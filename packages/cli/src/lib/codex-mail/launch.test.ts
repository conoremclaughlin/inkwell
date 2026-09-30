import { describe, expect, it } from 'vitest';
import { splitCodexMailArgs } from './launch.js';
import { hasTrustedCodexMailHooks, modernCodexMailHooks } from './hooks.js';

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
});
const legacy = `model="fixture"\n# ink-managed:hooks:start\n[hooks]\nsession_start = "ink hooks on-session-start --backend codex"\nsession_end = "ink hooks on-stop --backend codex"\nuser_prompt = "ink hooks on-prompt --backend codex"\n# ink-managed:hooks:end\n[custom]\nvalue=true\n`;
describe('opt-in modern hook migration', () => {
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
