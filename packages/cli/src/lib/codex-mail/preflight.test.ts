import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareCodexMailLaunch, selectCodexMailLaunch } from './preflight.js';
import { codexMailHooks } from './hooks.js';
import { probeCodexMailHooks } from './hook-probe.js';
vi.mock('./hook-probe.js', () => ({ probeCodexMailHooks: vi.fn() }));

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
  vi.mocked(probeCodexMailHooks).mockImplementation(async ({ cwd, serverArgs }) => ({
    enabled: !serverArgs.includes('--disable'),
    sessionHooks: false,
    hooks: {
      data: [
        {
          hooks: serverArgs.some((a) => a.startsWith('hooks.SessionStart='))
            ? codexMailHooks().map((h) => ({ ...h, enabled: true, trustStatus: 'untrusted' }))
            : [],
          errors: [],
        },
      ],
    },
  }));
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
  it('defaults eligible launches to mail with guarded hooks and unchanged user overrides', async () => {
    const f = fixture();
    const args = ['-c', 'model="fixture"', '--sandbox', 'read-only'];
    const result = await selectCodexMailLaunch({ ...f.options, args });
    expect(result.kind).toBe('mail');
    if (result.kind !== 'mail') throw new Error('missing mail plan');
    expect(result.launch.serverArgs.slice(0, 7)).toEqual([
      'app-server',
      '--enable',
      'hooks',
      '--listen',
      'stdio://',
      '-c',
      'model="fixture"',
    ]);
    expect(result.launch.threadOverrides).toEqual({ sandbox: 'read-only' });
    expect(readFileSync(f.path, 'utf8')).toBe(legacy);
    expect(result.launch.serverArgs.filter((a) => a.startsWith('hooks.'))).toHaveLength(3);
    expect(probeCodexMailHooks).toHaveBeenCalledTimes(2);
    expect(args).toEqual(['-c', 'model="fixture"', '--sandbox', 'read-only']);
  });
  it.each([
    { mode: false },
    { backend: 'claude' },
    { backend: 'gemini' },
    { interactive: false },
    { sessionTracked: false },
  ])('leaves opt-out and noninteractive/non-Codex paths untouched: %j', async (override) => {
    const f = fixture();
    const prepare = vi.fn(prepareCodexMailLaunch);
    expect(await selectCodexMailLaunch({ ...f.options, ...override }, prepare)).toEqual({
      kind: 'native',
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(probeCodexMailHooks).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(readFileSync(f.path, 'utf8')).toBe(legacy);
  });
  it.each([undefined, true])(
    'unknown arguments fall back only in automatic mode: %s',
    async (mode) => {
      const f = fixture();
      const args = ['--profile', 'custom'];
      const result = await selectCodexMailLaunch({ ...f.options, args, mode });
      expect(result.kind).toBe(mode ? 'error' : 'native');
      expect('reason' in result && result.reason).toContain('does not yet support');
      expect(spawnSync).not.toHaveBeenCalled();
      expect(readFileSync(f.path, 'utf8')).toBe(legacy);
      expect(args).toEqual(['--profile', 'custom']);
    }
  );
  it.each(['codex-cli 0.159.1', 'codex-cli 0.160.0', 'unrecognized'])(
    'unsupported version %s does not migrate or launch',
    async (stdout) => {
      const f = fixture();
      vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout } as ReturnType<typeof spawnSync>);
      expect(await selectCodexMailLaunch(f.options)).toMatchObject({
        kind: 'native',
        reason: expect.stringContaining('0.159.2'),
      });
      expect(readFileSync(f.path, 'utf8')).toBe(legacy);
    }
  );
  it('refuses missing/mismatched scope before checking versions or writing hooks', async () => {
    const f = fixture();
    for (const scope of [{ sessionId: undefined }, { studioId: 'different' }, { env: {} }]) {
      expect(await selectCodexMailLaunch({ ...f.options, ...scope })).toMatchObject({
        kind: 'native',
        reason: expect.stringContaining('exact attached'),
      });
    }
    expect(spawnSync).not.toHaveBeenCalled();
    expect(readFileSync(f.path, 'utf8')).toBe(legacy);
  });
  it('leaves unrelated custom project config untouched while using native discovery', async () => {
    const f = fixture();
    writeFileSync(f.path, 'custom="keep me"');
    expect(await selectCodexMailLaunch(f.options)).toMatchObject({
      kind: 'mail',
    });
    expect(readFileSync(f.path, 'utf8')).toBe('custom="keep me"');
  });
  it('explicit require rejects an ineligible launch rather than silently ignoring it', async () => {
    const f = fixture();
    expect(
      await selectCodexMailLaunch({ ...f.options, mode: true, interactive: false })
    ).toMatchObject({
      kind: 'error',
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });
  it.each(['trusted', 'untrusted'])(
    'reuses exact existing %s handlers without adding another copy',
    async (trustStatus) => {
      const f = fixture();
      vi.mocked(probeCodexMailHooks).mockResolvedValue({
        enabled: true,
        sessionHooks: false,
        hooks: {
          data: [{ hooks: codexMailHooks().map((h) => ({ ...h, enabled: true, trustStatus })) }],
        },
      });
      const result = await selectCodexMailLaunch(f.options);
      expect(result.kind).toBe('mail');
      if (result.kind !== 'mail') throw new Error('missing plan');
      expect(result.launch.serverArgs.some((a) => a.startsWith('hooks.'))).toBe(false);
      expect(probeCodexMailHooks).toHaveBeenCalledOnce();
      expect(readFileSync(f.path, 'utf8')).toBe(legacy);
    }
  );
  it.each(['different-build', 'unguarded'])(
    'refuses %s commands even when all three events are present and trusted',
    async (mode) => {
      const f = fixture();
      vi.mocked(probeCodexMailHooks).mockResolvedValue({
        enabled: true,
        sessionHooks: false,
        hooks: {
          data: [
            {
              hooks: codexMailHooks().map((h) => ({
                ...h,
                enabled: true,
                trustStatus: 'trusted',
                command:
                  mode === 'different-build'
                    ? h.command.replace(
                        /^.*? hooks /,
                        "'fixture-node' '/fixture/other-build/cli.js' hooks "
                      )
                    : h.command.replace(' --codex-inkmail-only', ''),
              })),
            },
          ],
        },
      });
      expect(await selectCodexMailLaunch(f.options)).toMatchObject({
        kind: 'native',
        reason: expect.stringContaining('conflicting or duplicate'),
      });
      expect(probeCodexMailHooks).toHaveBeenCalledOnce();
      expect(readFileSync(f.path, 'utf8')).toBe(legacy);
    }
  );
  it('preserves an explicit hooks disable override by refusing live mail', async () => {
    const f = fixture();
    expect(
      await selectCodexMailLaunch({ ...f.options, args: ['--disable', 'hooks'] })
    ).toMatchObject({
      kind: 'native',
      reason: expect.stringContaining('disabled by configuration'),
    });
    expect(readFileSync(f.path, 'utf8')).toBe(legacy);
  });
  it.each(['custom', 'duplicate', 'partial', 'error'])(
    'refuses %s effective hook sources without mutation',
    async (mode) => {
      const f = fixture();
      const hooks = codexMailHooks().map((h) => ({ ...h, enabled: true, trustStatus: 'trusted' }));
      vi.mocked(probeCodexMailHooks).mockResolvedValue({
        enabled: true,
        sessionHooks: mode === 'custom',
        hooks: {
          data: [
            {
              hooks:
                mode === 'custom' ? [] : mode === 'partial' ? hooks.slice(1) : [...hooks, hooks[0]],
              errors: mode === 'error' ? [{}] : [],
            },
          ],
        },
      });
      expect(await selectCodexMailLaunch(f.options)).toMatchObject({ kind: 'native' });
      expect(probeCodexMailHooks).toHaveBeenCalledOnce();
      expect(readFileSync(f.path, 'utf8')).toBe(legacy);
    }
  );
  it('fails closed if session hooks do not appear in the second native probe', async () => {
    const f = fixture();
    vi.mocked(probeCodexMailHooks).mockResolvedValue({
      enabled: true,
      sessionHooks: false,
      hooks: { data: [{ hooks: [] }] },
    });
    expect(await selectCodexMailLaunch({ ...f.options, mode: true })).toMatchObject({
      kind: 'error',
      reason: expect.stringContaining('did not load'),
    });
    expect(probeCodexMailHooks).toHaveBeenCalledTimes(2);
    expect(readFileSync(f.path, 'utf8')).toBe(legacy);
  });
});
