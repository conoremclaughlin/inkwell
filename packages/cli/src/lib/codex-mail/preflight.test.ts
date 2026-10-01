import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareCodexMailLaunch, selectCodexMailLaunch } from './preflight.js';

// No native provider: version detection only, with an isolated project fixture.
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const dirs: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const legacy = `# ink-managed:hooks:start
[hooks]
session_start = "ink hooks on-session-start --backend codex"
session_end = "ink hooks on-stop --backend codex"
user_prompt = "ink hooks on-prompt --backend codex"
# ink-managed:hooks:end
`;
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'ink-mail-preflight-'));
  dirs.push(cwd);
  mkdirSync(join(cwd, '.codex'));
  const path = join(cwd, '.codex', 'config.toml');
  writeFileSync(path, legacy);
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: 'codex-cli 0.159.2\n' } as ReturnType<
    typeof spawnSync
  >);
  const context = {
    sessionId: 'fixture-session',
    studioId: 'fixture-studio',
    sbSlug: 'fixture',
    runtime: 'codex',
    cliAttached: true,
  };
  const options = {
    binary: 'synthetic-codex',
    args: [] as string[],
    cwd,
    backend: 'codex',
    sessionTracked: true,
    interactive: true,
    sessionId: context.sessionId,
    studioId: context.studioId,
    env: {
      HOME: cwd,
      CODEX_HOME: join(cwd, '.codex'),
      INK_SESSION_ID: context.sessionId,
      INK_STUDIO_ID: context.studioId,
      SB_SLUG: context.sbSlug,
      INK_CONTEXT: Buffer.from(JSON.stringify(context)).toString('base64url'),
    },
  };
  return { options, path };
}
describe('default Codex Inkmail selection', () => {
  it('defaults eligible launches to mail with guarded hooks and unchanged user overrides', () => {
    const f = fixture();
    const args = ['--disable', 'hooks', '-c', 'model="fixture"', '--sandbox', 'read-only'];
    const result = selectCodexMailLaunch({ ...f.options, args });
    expect(result.kind).toBe('mail');
    if (result.kind !== 'mail') throw new Error('missing mail plan');
    expect(result.launch.serverArgs).toEqual([
      'app-server',
      '--enable',
      'hooks',
      '--listen',
      'stdio://',
      '--disable',
      'hooks',
      '-c',
      'model="fixture"',
    ]);
    expect(result.launch.threadOverrides).toEqual({ sandbox: 'read-only' });
    expect(readFileSync(f.path, 'utf8')).toContain('--codex-inkmail-only');
    expect(args).toEqual(['--disable', 'hooks', '-c', 'model="fixture"', '--sandbox', 'read-only']);
  });
  it.each([
    { mode: false },
    { backend: 'claude' },
    { backend: 'gemini' },
    { interactive: false },
    { sessionTracked: false },
  ])('leaves opt-out and noninteractive/non-Codex paths untouched: %j', (override) => {
    const f = fixture();
    const prepare = vi.fn(prepareCodexMailLaunch);
    expect(selectCodexMailLaunch({ ...f.options, ...override }, prepare)).toEqual({
      kind: 'native',
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(readFileSync(f.path, 'utf8')).toBe(legacy);
  });
  it.each([undefined, true])('unknown arguments fall back only in automatic mode: %s', (mode) => {
    const f = fixture();
    const args = ['--profile', 'custom'];
    const result = selectCodexMailLaunch({ ...f.options, args, mode });
    expect(result.kind).toBe(mode ? 'error' : 'native');
    expect('reason' in result && result.reason).toContain('does not yet support');
    expect(spawnSync).not.toHaveBeenCalled();
    expect(readFileSync(f.path, 'utf8')).toBe(legacy);
    expect(args).toEqual(['--profile', 'custom']);
  });
  it.each(['codex-cli 0.159.1', 'codex-cli 0.160.0', 'unrecognized'])(
    'unsupported version %s does not migrate or launch',
    (stdout) => {
      const f = fixture();
      vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout } as ReturnType<typeof spawnSync>);
      expect(selectCodexMailLaunch(f.options)).toMatchObject({
        kind: 'native',
        reason: expect.stringContaining('0.159.2'),
      });
      expect(readFileSync(f.path, 'utf8')).toBe(legacy);
    }
  );
  it('refuses missing/mismatched scope before checking versions or writing hooks', () => {
    const f = fixture();
    for (const scope of [{ sessionId: undefined }, { studioId: 'different' }, { env: {} }]) {
      expect(selectCodexMailLaunch({ ...f.options, ...scope })).toMatchObject({
        kind: 'native',
        reason: expect.stringContaining('exact attached'),
      });
    }
    expect(spawnSync).not.toHaveBeenCalled();
    expect(readFileSync(f.path, 'utf8')).toBe(legacy);
  });
  it('preserves custom config and reports its actionable fallback', () => {
    const f = fixture();
    writeFileSync(f.path, 'custom="keep me"');
    expect(selectCodexMailLaunch(f.options)).toMatchObject({
      kind: 'native',
      reason: expect.stringContaining('standard ink-managed'),
    });
    expect(readFileSync(f.path, 'utf8')).toBe('custom="keep me"');
  });
  it('explicit require rejects an ineligible launch rather than silently ignoring it', () => {
    const f = fixture();
    expect(selectCodexMailLaunch({ ...f.options, mode: true, interactive: false })).toMatchObject({
      kind: 'error',
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
