import { describe, expect, it } from 'vitest';
import { CODEX_CONFIG_REFUSALS, judgeCodexMcpList } from './codex-mcp-list.js';

/**
 * The literal stdout of `codex mcp list --json` from codex-cli 0.158.0 over a
 * synthetic fixture: loopback URLs, fake header values, `/usr/bin/true` as
 * the only command (Myra, #701 7ca2a2d1). Nothing here came from a real config.
 */
const MEASURED_0_158 = [
  {
    name: 'synthetic_bearer',
    enabled: true,
    disabled_reason: null,
    transport: {
      type: 'streamable_http',
      url: 'http://127.0.0.1:9/bearer',
      bearer_token_env_var: 'SYNTHETIC_BEARER_ENV_NAME',
      http_headers: null,
      env_http_headers: null,
      http_headers_helper: null,
    },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: 'bearer_token',
  },
  {
    name: 'synthetic_env',
    enabled: true,
    disabled_reason: null,
    transport: {
      type: 'streamable_http',
      url: 'http://127.0.0.1:9/env',
      bearer_token_env_var: null,
      http_headers: null,
      env_http_headers: { 'X-Synthetic-Env': 'SYNTHETIC_HEADER_ENV_NAME' },
      http_headers_helper: null,
    },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: 'unknown',
  },
  {
    name: 'synthetic_helper',
    enabled: true,
    disabled_reason: null,
    transport: {
      type: 'streamable_http',
      url: 'http://127.0.0.1:9/helper',
      bearer_token_env_var: null,
      http_headers: null,
      env_http_headers: null,
      http_headers_helper: '<redacted>',
    },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: 'unknown',
  },
  {
    name: 'synthetic_project',
    enabled: true,
    disabled_reason: null,
    transport: {
      type: 'streamable_http',
      url: 'http://127.0.0.1:9/project',
      bearer_token_env_var: null,
      http_headers: null,
      env_http_headers: null,
      http_headers_helper: null,
    },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: 'unknown',
  },
  {
    name: 'synthetic_static',
    enabled: true,
    disabled_reason: null,
    transport: {
      type: 'streamable_http',
      url: 'http://127.0.0.1:9/static',
      bearer_token_env_var: null,
      http_headers: { 'X-Synthetic-Static': 'synthetic-static-value' },
      env_http_headers: null,
      http_headers_helper: null,
    },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: 'unknown',
  },
  {
    name: 'synthetic_stdio',
    enabled: true,
    disabled_reason: null,
    transport: {
      type: 'stdio',
      command: '/usr/bin/true',
      args: ['synthetic-arg'],
      env: null,
      env_vars: [],
      cwd: null,
    },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: 'unsupported',
  },
];

/** This session's Inkwell server, as its host gives it. */
const INKWELL = 'http://localhost:3001/mcp';

type Entry = (typeof MEASURED_0_158)[number];

const withoutHelper = () => MEASURED_0_158.filter((entry) => entry.name !== 'synthetic_helper');

function http(name: string, url: string, overrides: Record<string, unknown> = {}): Entry {
  return {
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
  } as Entry;
}

const judge = (entries: unknown, inkwell = INKWELL) =>
  judgeCodexMcpList(JSON.stringify(entries), inkwell);

describe('judgeCodexMcpList, on the 0.158.0 listing', () => {
  it('admits the measured listing once its helper server is gone', () => {
    expect(judge(withoutHelper())).toBeUndefined();
  });

  it('refuses the measured listing as printed: it has a header helper', () => {
    expect(judge(MEASURED_0_158)).toBe(CODEX_CONFIG_REFUSALS.helper);
  });

  it('admits an Inkwell server with only env-drawn routing and a bearer env var', () => {
    const inkwell = http('inkwell', 'http://127.0.0.1:3001/mcp', {
      bearer_token_env_var: 'INK_ACCESS_TOKEN',
      env_http_headers: { 'x-ink-context': 'INK_CONTEXT', 'x-ink-session-id': 'INK_SESSION_ID' },
    });
    expect(judge([...withoutHelper(), inkwell])).toBeUndefined();
  });
});

describe('judgeCodexMcpList, refusals', () => {
  it.each([['x-ink-session-id'], ['X-Ink-Studio-Id'], ['X-INK-CONTEXT']])(
    'refuses a static %s on any server, with the repair',
    (header) => {
      const baked = http('someone_else', 'https://mcp.example.com/', {
        http_headers: { [header]: 'synthetic-session' },
      });
      expect(judge([...withoutHelper(), baked])).toBe(CODEX_CONFIG_REFUSALS.staticRouting);
    }
  );

  it('refuses a static routing header on a disabled server too', () => {
    const disabled = {
      ...http('inkwell', INKWELL, { http_headers: { 'x-ink-session-id': 'synthetic-session' } }),
      enabled: false,
      disabled_reason: 'synthetic',
    };
    expect(judge([disabled])).toBe(CODEX_CONFIG_REFUSALS.staticRouting);
  });

  it('refuses env-drawn routing for a server that is not Inkwell', () => {
    const foreign = http('someone_else', 'https://mcp.example.com/', {
      env_http_headers: { 'X-Ink-Context': 'INK_CONTEXT' },
    });
    expect(judge([foreign])).toBe(CODEX_CONFIG_REFUSALS.foreignRouting);
  });

  it('refuses a static Authorization for Inkwell, and admits one for another origin', () => {
    const toInkwell = http('inkwell', 'http://[::1]:3001/mcp', {
      http_headers: { authorization: 'Bearer synthetic-token' },
    });
    const toOtherPort = http('other', 'http://localhost:3002/mcp', {
      http_headers: { Authorization: 'Bearer synthetic-token' },
    });
    expect(judge([toInkwell])).toBe(CODEX_CONFIG_REFUSALS.staticAuthorization);
    expect(judge([toOtherPort])).toBeUndefined();
  });

  it('refuses any server with a header helper, Inkwell or not', () => {
    const helper = http('someone_else', 'https://mcp.example.com/', {
      http_headers_helper: '<redacted>',
    });
    expect(judge([helper])).toBe(CODEX_CONFIG_REFUSALS.helper);
  });

  it('refuses an `inkwell` server that points somewhere else: the adapter would hand it the session', () => {
    // The config's own `inkwell` entry does not decide what Inkwell is.
    const moved = http('inkwell', 'https://inkwell.example.com/mcp');
    const stdio = { ...MEASURED_0_158[5]!, name: 'inkwell' };
    expect(judge([moved])).toBe(CODEX_CONFIG_REFUSALS.inkwellElsewhere);
    expect(judge([stdio])).toBe(CODEX_CONFIG_REFUSALS.inkwellElsewhere);
  });

  it('prefers the actionable routing refusal when there are several', () => {
    const helper = http('a', 'https://mcp.example.com/', { http_headers_helper: '<redacted>' });
    const baked = http('b', 'https://mcp.example.com/', {
      http_headers: { 'x-ink-studio-id': 'synthetic-studio' },
    });
    expect(judge([helper, baked])).toBe(CODEX_CONFIG_REFUSALS.staticRouting);
  });

  it('refuses when the host gives no readable Inkwell URL, and when a server URL is unreadable', () => {
    expect(judge(withoutHelper(), 'not a url')).toBe(CODEX_CONFIG_REFUSALS.unreadableInkwellUrl);
    expect(judge([http('broken', 'not a url')])).toBe(CODEX_CONFIG_REFUSALS.unreadableUrl);
  });
});

describe('judgeCodexMcpList, loopback aliases are one origin', () => {
  it.each([
    'http://localhost:3001/mcp',
    'http://127.0.0.1:3001/mcp',
    'http://127.1.2.3:3001/mcp',
    'http://[::1]:3001/mcp',
    'http://[::ffff:127.0.0.1]:3001/mcp',
    'http://0.0.0.0:3001/mcp',
    'http://studio.localhost:3001/mcp',
    'http://2130706433:3001/mcp',
    'HTTP://LOCALHOST:3001/other-path',
  ])('%s is Inkwell', (url) => {
    const withAuth = http('x', url, { http_headers: { Authorization: 'Bearer synthetic-token' } });
    expect(judge([withAuth])).toBe(CODEX_CONFIG_REFUSALS.staticAuthorization);
  });

  it.each([
    'http://localhost:3002/mcp',
    'https://localhost:3001/mcp',
    'http://10.0.0.1:3001/mcp',
    'http://localhost.example.com:3001/mcp',
  ])('%s is not', (url) => {
    const withAuth = http('x', url, { http_headers: { Authorization: 'Bearer synthetic-token' } });
    expect(judge([withAuth])).toBeUndefined();
  });

  it('folds default ports, on the host side as well', () => {
    const withAuth = http('x', 'https://ink.example.com:443/mcp', {
      http_headers: { Authorization: 'Bearer synthetic-token' },
    });
    expect(judgeCodexMcpList(JSON.stringify([withAuth]), 'https://ink.example.com/mcp')).toBe(
      CODEX_CONFIG_REFUSALS.staticAuthorization
    );
  });
});

describe('judgeCodexMcpList, drift from 0.158.0 is refused, not guessed at', () => {
  const measuredHttp = () => structuredClone(MEASURED_0_158[0]!) as Record<string, any>;

  it.each<[string, () => unknown]>([
    ['an object instead of an array', () => ({ servers: [] })],
    ['an entry without a name', () => [{ ...measuredHttp(), name: undefined }]],
    ['an entry without a transport', () => [{ ...measuredHttp(), transport: undefined }]],
    ['an unknown transport type', () => [{ ...measuredHttp(), transport: { type: 'sse' } }]],
    [
      'an HTTP transport missing a measured key',
      () => {
        const entry = measuredHttp();
        delete entry.transport.http_headers_helper;
        return [entry];
      },
    ],
    [
      'header maps that are not objects',
      () => {
        const entry = measuredHttp();
        entry.transport.http_headers = ['x-ink-session-id'];
        return [entry];
      },
    ],
    [
      'a URL that is not a string',
      () => {
        const entry = measuredHttp();
        entry.transport.url = 9;
        return [entry];
      },
    ],
  ])('%s', (_label, build) => {
    expect(judge(build())).toBe(CODEX_CONFIG_REFUSALS.drift);
  });

  it('refuses output that is not JSON', () => {
    expect(judgeCodexMcpList('codex: unknown subcommand', INKWELL)).toBe(
      CODEX_CONFIG_REFUSALS.drift
    );
  });
});

describe('judgeCodexMcpList never repeats what the listing printed', () => {
  const SECRET = 'synthetic-secret-4f1c9e';
  const fixed = new Set<string>(Object.values(CODEX_CONFIG_REFUSALS));

  it.each<[string, string]>([
    [
      'a static header value',
      JSON.stringify([
        http('inkwell', INKWELL, {
          http_headers: { Authorization: `Bearer ${SECRET}`, 'x-ink-context': SECRET },
        }),
      ]),
    ],
    ['malformed JSON around a value', `[{"name": "x", "transport": {"http_headers": "${SECRET}"`],
    ['a value in a drifted entry', JSON.stringify([{ name: SECRET, transport: SECRET }])],
  ])('%s', (_label, stdout) => {
    const reason = judgeCodexMcpList(stdout, INKWELL);
    expect(reason).toBeDefined();
    expect(fixed.has(reason!)).toBe(true);
    expect(reason).not.toContain(SECRET);
  });
});
