/** Synthetic credentials only. Every credential-file and network operation is mocked. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { selectCredential, getValidAccessToken, getValidDelegatedAccessToken } from './tokens.js';
import { callInkTool } from '../commands/hooks.js';
import { InkClient } from '../lib/ink-client.js';

vi.mock('fs', async (original) => ({
  ...(await original<typeof import('fs')>()),
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() =>
    JSON.stringify({
      access_token: 'synthetic-stored-human',
      refresh_token: 'synthetic-refresh',
      expires_in: 3600,
      issued_at: Date.now(),
      agent_id: 'fixture',
      accessToken: 'synthetic-legacy',
      refreshToken: 'synthetic-legacy-refresh',
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
  ),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  appendFileSync: vi.fn(),
}));
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  spawn: vi.fn(() => {
    throw new Error('No process allowed');
  }),
  execSync: vi.fn(() => {
    throw new Error('No process allowed');
  }),
  execFile: vi.fn(() => {
    throw new Error('No process allowed');
  }),
}));
vi.mock('../lib/sb-debug.js', () => ({ sbDebugLog: vi.fn() }));

const url = 'http://fixture.invalid';
const claims = () => ({
  type: 'mcp_access',
  sub: 'fixture-user',
  email: 'fixture@example.invalid',
  scope: 'mcp:tools',
  sessionId: 'fixture-session',
  sbSlug: 'fixture',
  exp: Math.floor(Date.now() / 1000) + 3600,
});
const jwt = (payload: unknown) =>
  `synthetic.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('INK_RUNNER_AUTH_REQUIRED', '1');
  vi.stubEnv('INK_SESSION_ID', 'fixture-session');
  vi.stubEnv('SB_SLUG', 'fixture');
  vi.stubEnv('INK_ACCESS_TOKEN', undefined);
  vi.stubEnv('INK_SERVER_URL', url);
  vi.stubEnv('HOME', '/synthetic/no-real-home');
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function noStoredEffects() {
  expect(fs.existsSync).not.toHaveBeenCalled();
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(fs.writeFileSync).not.toHaveBeenCalled();
  expect(fs.unlinkSync).not.toHaveBeenCalled();
}

describe('explicit server-runner credentials', () => {
  const invalid = [
    'missing',
    'empty',
    'opaque',
    'null',
    'array',
    'expired',
    'missing-exp',
    'string-exp',
    'wrong-session',
    'unbound',
    'wrong-sb',
    'human',
    'wrong-scope',
    'future-nbf',
  ];
  it.each(invalid)('refuses %s without stored credentials or a bearerless call', async (kind) => {
    const p: Record<string, unknown> = claims();
    if (kind === 'expired') p.exp = 1;
    if (kind === 'missing-exp') delete p.exp;
    if (kind === 'string-exp') p.exp = '9999999999';
    if (kind === 'wrong-session') p.sessionId = 'different';
    if (kind === 'unbound') delete p.sessionId;
    if (kind === 'wrong-sb') p.sbSlug = 'different';
    if (kind === 'human') p.type = 'pcp_admin';
    if (kind === 'wrong-scope') p.scope = 'admin';
    if (kind === 'future-nbf') p.nbf = Math.floor(Date.now() / 1000) + 1800;
    vi.stubEnv(
      'INK_ACCESS_TOKEN',
      kind === 'missing'
        ? undefined
        : kind === 'empty'
          ? ' '
          : kind === 'opaque'
            ? 'opaque'
            : jwt(kind === 'null' ? null : kind === 'array' ? [] : p)
    );
    expect(selectCredential()).toBeNull();
    expect(getValidDelegatedAccessToken('fixture')).toBeNull();
    await expect(getValidAccessToken(url)).rejects.toThrow(/runner|session/i);
    await expect(callInkTool('bootstrap', { sbSlug: 'fixture' })).rejects.toThrow(
      /runner|session/i
    );
    await expect(new InkClient(url).callTool('bootstrap', {})).rejects.toThrow(/runner|session/i);
    noStoredEffects();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('selects the injected token, never the stored delegated token', async () => {
    const token = jwt(claims());
    vi.stubEnv('INK_ACCESS_TOKEN', token);
    expect(selectCredential()).toEqual({ source: 'env', token });
    expect(await getValidAccessToken(url)).toBe(token);
    expect(getValidDelegatedAccessToken('fixture')).toBeNull();
    noStoredEffects();
  });

  it.each(['0', '', 'false', 'unexpected'])('cannot disable the policy with %j', async (value) => {
    vi.stubEnv('INK_RUNNER_AUTH_REQUIRED', value);
    vi.stubEnv('INK_ACCESS_TOKEN', jwt(claims()));
    await expect(getValidAccessToken(url)).rejects.toThrow(/runner|session/i);
    noStoredEffects();
  });

  it('refuses explicit fallback even with an otherwise usable runner token', async () => {
    vi.stubEnv('INK_ACCESS_TOKEN', jwt(claims()));
    await expect(getValidAccessToken(url, { allowEnvToken: false })).rejects.toThrow(
      /runner|session/i
    );
    noStoredEffects();
  });

  it.each([401, 403])('hooks do not retry a refused credential (%s)', async (status) => {
    vi.stubEnv('INK_ACCESS_TOKEN', jwt(claims()));
    fetchMock.mockResolvedValue(new Response('{}', { status }));
    await expect(callInkTool('bootstrap', { sbSlug: 'fixture' })).rejects.toThrow(`${status}`);
    expect(fetchMock).toHaveBeenCalledOnce();
    noStoredEffects();
  });

  it.each([401, 403, 404])(
    'InkClient cannot retry or use legacy authority (%s)',
    async (status) => {
      vi.stubEnv('INK_ACCESS_TOKEN', jwt(claims()));
      fetchMock.mockResolvedValue(new Response('{}', { status }));
      await expect(new InkClient(url).callTool('bootstrap', {})).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledOnce();
      noStoredEffects();
    }
  );

  it('does not infer server admission from an interactive session id', async () => {
    vi.stubEnv('INK_RUNNER_AUTH_REQUIRED', undefined);
    expect(await getValidAccessToken(url)).toBe('synthetic-stored-human');
    expect(getValidDelegatedAccessToken('fixture')).toBe('synthetic-stored-human');
    expect(fs.readFileSync).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
