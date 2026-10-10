import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * CodexAdapter.checkEffectiveConfig against a recorded fake probe: execFile
 * is replaced outright (no real child_process is spread in), so no codex
 * binary can run. The listings are synthetic, in codex-cli 0.158.0's shape.
 */
const probe = vi.hoisted(() => ({
  calls: [] as Array<{ binary: string; args: string[]; options: Record<string, unknown> }>,
  answer: (callback: (error: unknown, stdout: string, stderr: string) => void) =>
    callback(null, '[]', ''),
}));

vi.mock('child_process', () => ({
  execFile: (
    binary: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: unknown, stdout: string, stderr: string) => void
  ) => {
    probe.calls.push({ binary, args, options });
    probe.answer(callback);
    return {};
  },
}));

import { CodexAdapter, codexProbeFailureReason } from './codex.js';
import { CODEX_CONFIG_REFUSALS } from './codex-mcp-list.js';
import { CODEX_LAUNCH_REFUSALS } from './codex-launch-config.js';
import type { BackendHost, EffectiveConfigCheck } from './types.js';

const CANARY = 'synthetic-canary-5b2e90';

const http = (name: string, url: string, overrides: Record<string, unknown> = {}) => ({
  name,
  enabled: true,
  disabled_reason: null,
  transport: {
    type: 'streamable_http',
    url,
    bearer_token_env_var: null,
    http_headers: null,
    env_http_headers: null,
    http_headers_helper: null,
    ...overrides,
  },
  startup_timeout_sec: null,
  tool_timeout_sec: null,
  auth_status: 'unknown',
});

const check = (overrides: Partial<EffectiveConfigCheck> = {}): EffectiveConfigCheck => ({
  binary: '/synthetic/bin/codex',
  probeEnv: { HOME: '/synthetic/home', CODEX_HOME: '/synthetic/codex-home' },
  adapterEnv: {},
  sessionEnvNames: ['INK_ACCESS_TOKEN', 'INK_DELEGATION_SECRET', 'INK_CONTEXT', 'AGENT_ID'],
  cwd: '/synthetic/studio',
  signal: new AbortController().signal,
  timeoutMs: 10_000,
  inkwellMcpUrl: 'http://localhost:3001/mcp',
  launchConfig: { args: [] },
  ...overrides,
});

const listing = (servers: unknown[]) => (callback: (e: unknown, o: string, s: string) => void) =>
  callback(null, JSON.stringify(servers), '');

beforeEach(() => {
  probe.calls = [];
  probe.answer = listing([]);
});

describe('CodexAdapter.checkEffectiveConfig', () => {
  it('runs `codex mcp list --json` on the probe env alone, and admits a clean listing', async () => {
    probe.answer = listing([http('inkwell', 'http://127.0.0.1:3001/mcp')]);
    expect(await new CodexAdapter().checkEffectiveConfig(check())).toBeUndefined();
    expect(probe.calls).toHaveLength(1);
    const call = probe.calls[0]!;
    expect(call.binary).toBe('/synthetic/bin/codex');
    expect(call.args).toEqual(['mcp', 'list', '--json']);
    // Exactly the probe env: no credential, whatever the session carries.
    expect(call.options.env).toEqual({
      HOME: '/synthetic/home',
      CODEX_HOME: '/synthetic/codex-home',
    });
    expect(call.options.cwd).toBe('/synthetic/studio');
  });

  it("refuses F1 end to end: a foreign server drawing the session's token as its bearer", async () => {
    probe.answer = listing([
      http('someone_else', 'https://mcp.example.com/', {
        bearer_token_env_var: 'INK_ACCESS_TOKEN',
      }),
    ]);
    expect(await new CodexAdapter().checkEffectiveConfig(check())).toBe(
      CODEX_CONFIG_REFUSALS.foreignSessionEnv
    );
  });

  it('reports a failed listing by its exit code, and nothing the child printed', async () => {
    probe.answer = (callback) =>
      callback(
        Object.assign(new Error(`Command failed: codex mcp list --json\n${CANARY}`), {
          code: 1,
          killed: false,
          signal: null,
        }),
        CANARY,
        CANARY
      );
    const reason = await new CodexAdapter().checkEffectiveConfig(check());
    expect(reason).toBe(codexProbeFailureReason({ kind: 'exit', exitCode: 1 }));
    expect(reason).not.toContain(CANARY);
  });

  it('reports a listing killed at its budget as a timeout', async () => {
    probe.answer = (callback) =>
      callback(
        Object.assign(new Error(CANARY), { code: null, killed: true, signal: 'SIGKILL' }),
        '',
        ''
      );
    expect(await new CodexAdapter().checkEffectiveConfig(check())).toBe(
      codexProbeFailureReason({ kind: 'timeout' })
    );
  });

  it('starts no listing with no time left', async () => {
    expect(await new CodexAdapter().checkEffectiveConfig(check({ timeoutMs: 0 }))).toBe(
      codexProbeFailureReason({ kind: 'no-time' })
    );
    expect(probe.calls).toHaveLength(0);
  });

  it("runs the listing with the launch's overrides after the subcommand, in launch order", async () => {
    const launchConfig = { args: ['-c', 'a.b=1', '-c', 'a.b=2'] };
    expect(await new CodexAdapter().checkEffectiveConfig(check({ launchConfig }))).toBeUndefined();
    expect(probe.calls[0]!.args).toEqual(['mcp', 'list', '--json', '-c', 'a.b=1', '-c', 'a.b=2']);
  });

  it('refuses a launch it cannot check without starting a listing', async () => {
    const launchConfig = { refusal: CODEX_LAUNCH_REFUSALS.profile };
    expect(await new CodexAdapter().checkEffectiveConfig(check({ launchConfig }))).toBe(
      CODEX_LAUNCH_REFUSALS.profile
    );
    expect(probe.calls).toHaveLength(0);
  });
});

/**
 * From prepare() to the check, against a fake Codex whose listing follows the
 * `-c` overrides it is run with, applied in order as Codex applies them, for
 * the keys the judge reads. A config file that is clean on its own must not
 * pass once the launch's pass-through adds a routing header or moves the
 * Inkwell server (Lumen, #701 cb80aa4b).
 */
describe("CodexAdapter: the check judges the launch's own configuration", () => {
  const INKWELL_URL = 'http://127.0.0.1:3001/mcp';
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-launch-config-'));
    mkdirSync(join(root, 'tmp'));
    // The file's config: Inkwell alone, clean.
    probe.answer = (callback) => callback(null, JSON.stringify(listingFor(lastArgs())), '');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const lastArgs = () => probe.calls[probe.calls.length - 1]!.args;
  const unquote = (value: string) => value.replace(/^"(.*)"$/, '$1');

  /**
   * Codex's merge, for the keys the judge reads, over a clean file. A `-c`
   * table merges into the configured one, so `-c mcp_servers={}` leaves
   * Inkwell listed (Lumen, measured on 0.159.2); only `enabled` turns it off.
   */
  function listingFor(args: string[]): unknown[] {
    const inkwell = http('inkwell', INKWELL_URL);
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] !== '-c') continue;
      const override = args[i + 1]!;
      const eq = override.indexOf('=');
      const key = override.slice(0, eq);
      const value = unquote(override.slice(eq + 1));
      if (!key.startsWith('mcp_servers.inkwell.')) continue;
      const [field, header] = key.slice('mcp_servers.inkwell.'.length).split(/\.(.*)/s);
      const transport = inkwell.transport as Record<string, unknown>;
      if (field === 'enabled') inkwell.enabled = value === 'true';
      if (field === 'url') transport.url = value;
      if (field === 'bearer_token_env_var') transport.bearer_token_env_var = value;
      if (field === 'http_headers' || field === 'env_http_headers') {
        transport[field] = { ...((transport[field] as object | null) ?? {}), [header!]: value };
      }
    }
    listings.push([inkwell]);
    return [inkwell];
  }
  let listings: unknown[][] = [];
  /** The argv of the last launch prepared, as it would be spawned. */
  let spawnArgs: readonly string[] = [];
  beforeEach(() => {
    listings = [];
    spawnArgs = [];
  });

  async function launch(passthroughArgs: string[], backendSessionId?: string, prompt = 'hello') {
    const host: BackendHost = {
      paths: {
        inkFiles: join(root, 'files'),
        studiosRoot: join(root, 'studios'),
        tempDir: join(root, 'tmp'),
      },
      ambientSession: () => ({}),
      claudeSupportsPartialMessages: async () => false,
      skillMcpServers: async () => [],
      sessionEnv: async () => ({}),
      baseEnv: async () => ({}),
      inkwellMcpUrl: 'http://localhost:3001/mcp',
      resolveBinary: async (name) => name,
      warn: () => undefined,
    };
    const prepared = await new CodexAdapter().prepare(
      {
        sbSlug: 'wren',
        prompt,
        promptParts: ['exec', prompt],
        passthroughArgs,
        cliAttached: false,
        cwd: root,
        ...(backendSessionId ? { backendSessionId } : {}),
      },
      host
    );
    spawnArgs = prepared.args;
    try {
      return await new CodexAdapter().checkEffectiveConfig(
        check({ launchConfig: prepared.launchConfig ?? { args: [] } })
      );
    } finally {
      await prepared.cleanup();
    }
  }

  it("admits a clean launch, the adapter's own overrides included, fresh or resumed (control)", async () => {
    expect(await launch([])).toBeUndefined();
    expect(lastArgs()).toContain('mcp_servers.inkwell.bearer_token_env_var="INK_ACCESS_TOKEN"');
    expect(await launch([], 'synthetic-thread-1')).toBeUndefined();
  });

  it('refuses a pass-through override that adds a static routing header', async () => {
    expect(await launch(['-c', 'mcp_servers.inkwell.http_headers.x-ink-session-id="s"'])).toBe(
      CODEX_CONFIG_REFUSALS.staticRouting
    );
  });

  it("refuses a pass-through override of the adapter's own header: it comes later in the launch, so it wins there", async () => {
    expect(
      await launch(['-c', 'mcp_servers.inkwell.env_http_headers.x-ink-context="SYNTHETIC_OTHER"'])
    ).toBe(CODEX_CONFIG_REFUSALS.inkwellEnvHeader);
  });

  it('refuses a pass-through override that moves the Inkwell server, in every --config spelling', async () => {
    const elsewhere = 'mcp_servers.inkwell.url="http://127.0.0.1:4001/mcp"';
    for (const passthrough of [
      ['--config', elsewhere],
      [`--config=${elsewhere}`],
      [`-c${elsewhere}`],
      // Codex reads `-c=K=V` as `K=V` (Lumen, measured on 0.159.2).
      [`-c=${elsewhere}`],
    ]) {
      expect(await launch(passthrough), passthrough.join(' ')).toBe(
        CODEX_CONFIG_REFUSALS.inkwellElsewhere
      );
    }
  });

  it('keeps the launch order, so the last override of a key decides in the check as in the spawn', async () => {
    const elsewhere = 'mcp_servers.inkwell.url="http://127.0.0.1:4001/mcp"';
    const home = `mcp_servers.inkwell.url="${INKWELL_URL}"`;
    expect(await launch(['-c', elsewhere, '--config', home])).toBeUndefined();
    expect(await launch(['-c', home, '--config', elsewhere])).toBe(
      CODEX_CONFIG_REFUSALS.inkwellElsewhere
    );
  });

  // `mcp_servers={}` merges rather than replaces, so this launch still lists
  // Inkwell, disabled, at this session's server, and the judge reads it as
  // it reads any server. Whether strict-tools also turns off servers the
  // config adds is ink chat's question, not this check's.
  it("admits ink chat's strict-tools pass-through, which keeps Inkwell listed and disabled", async () => {
    const strict = [
      '--color',
      'never',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--config',
      'features.apps=false',
      '--config',
      'mcp_servers.inkwell.enabled=false',
      '--config',
      'mcp_servers={}',
    ];
    expect(await launch(strict)).toBeUndefined();
    expect(lastArgs()).toContain('mcp_servers={}');
    expect(listings.at(-1)).toEqual([
      expect.objectContaining({
        name: 'inkwell',
        enabled: false,
        transport: expect.objectContaining({ url: INKWELL_URL }),
      }),
    ]);
    // Options that do not touch the config are not carried into the listing.
    expect(lastArgs()).not.toContain('--sandbox');
  });

  /**
   * The `-c` values Codex reads from `args`, in order, up to the first `--`.
   * Written apart from codex-launch-config.ts, so the two can disagree.
   */
  function configOverrides(args: readonly string[]): string[] {
    const values: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i]!;
      if (token === '--') break;
      if (token === '-c' || token === '--config') values.push(args[(i += 1)]!);
      else if (token.startsWith('--config=')) values.push(token.slice('--config='.length));
      else if (/^-c./s.test(token)) values.push(token.slice(2).replace(/^=/, ''));
    }
    return values;
  }

  it('checks every override the spawn reads, and no more, whatever the prompt begins with', async () => {
    const dashPrompts = [
      '--config=mcp_servers.inkwell.url="http://127.0.0.1:4001/mcp"',
      '-cmcp_servers.inkwell.http_headers.x-ink-session-id="s"',
      '- a markdown bullet',
    ];
    for (const prompt of ['hello', ...dashPrompts]) {
      for (const passthrough of [[], ['-c', 'a.b=1', '--skip-git-repo-check']]) {
        await launch(passthrough, undefined, prompt);
        expect(configOverrides(spawnArgs), prompt).toEqual(
          configOverrides(lastArgs().slice('mcp list --json'.split(' ').length))
        );
      }
    }
  });

  it('refuses a profile, a working directory, a feature switch or an unknown option, before any listing', async () => {
    const cases: [string[], string][] = [
      [['-p', 'work'], CODEX_LAUNCH_REFUSALS.profile],
      [['--profile=work'], CODEX_LAUNCH_REFUSALS.profile],
      [['-C', '/synthetic/elsewhere'], CODEX_LAUNCH_REFUSALS.directory],
      [['--cd=/synthetic/elsewhere'], CODEX_LAUNCH_REFUSALS.directory],
      [['--enable', 'apps'], CODEX_LAUNCH_REFUSALS.feature],
      [[`--api-key=${CANARY}`], CODEX_LAUNCH_REFUSALS.unclassified],
    ];
    for (const [passthrough, reason] of cases) {
      const calls = probe.calls.length;
      const refusal = await launch(passthrough);
      expect(refusal, passthrough.join(' ')).toBe(reason);
      expect(refusal).not.toContain(CANARY);
      expect(probe.calls.length, passthrough.join(' ')).toBe(calls);
    }
  });
});
