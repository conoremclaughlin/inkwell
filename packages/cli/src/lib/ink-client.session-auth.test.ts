import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { InkClient } from './ink-client.js';
import { getValidAccessToken, selectCredential } from '../auth/tokens.js';

const jwt = (exp: number) =>
  `fixture.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
let home: string;
let configPath: string;
let originalAuth: string;
let originalConfig: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'ink-session-auth-')));
  await mkdir(join(home, '.ink'));
  configPath = join(home, '.ink', 'config.json');
  originalAuth = JSON.stringify({
    access_token: 'stored-human',
    refresh_token: 'stored-refresh',
    issued_at: 0,
    expires_in: 1,
    scope: 'mcp:tools',
  });
  originalConfig = JSON.stringify({
    accessToken: 'legacy-human',
    refreshToken: 'legacy-refresh',
    clientId: 'fixture',
    tokenExpiresAt: '2099-01-01T00:00:00Z',
  });
  await writeFile(join(home, '.ink', 'auth.json'), originalAuth);
  await writeFile(configPath, originalConfig);
  vi.stubEnv('HOME', home);
  vi.stubEnv('INK_SESSION_ID', 'fixture-session');
  vi.stubEnv('INK_ACCESS_TOKEN', jwt(9999999999));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('refused', { status: 401 }))
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(home, { recursive: true, force: true });
});
const unchanged = async () => {
  expect(await readFile(join(home, '.ink', 'auth.json'), 'utf8')).toBe(originalAuth);
  expect(await readFile(configPath, 'utf8')).toBe(originalConfig);
};
describe('session-bound client authority', () => {
  it('does not retry a revoked scoped token with stored or legacy human credentials', async () => {
    await expect(
      new InkClient('http://127.0.0.1:9999', configPath).callTool('recall', {})
    ).rejects.toThrow(/401.*\nRe-admit/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({
      Authorization: `Bearer ${process.env.INK_ACCESS_TOKEN}`,
    });
    await unchanged();
  });
  it('refuses an expired session token before reading or refreshing the human login', async () => {
    vi.stubEnv('INK_ACCESS_TOKEN', jwt(1));
    expect(selectCredential()).toBeNull();
    expect(await getValidAccessToken('http://127.0.0.1:9999')).toBeNull();
    await expect(
      new InkClient('http://127.0.0.1:9999', configPath).callTool('recall', {})
    ).rejects.toThrow(/re-admit/);
    expect(fetch).not.toHaveBeenCalled();
    await unchanged();
  });
  it('does not permit explicit env-skip fallback to cross a session binding', async () => {
    expect(await getValidAccessToken('http://127.0.0.1:9999', { allowEnvToken: false })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    await unchanged();
  });
  it('does not drop authentication through the legacy endpoint when scoped MCP is unavailable', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response('not found', { status: 404 }));
    await expect(
      new InkClient('http://127.0.0.1:9999', configPath).callTool('recall', {})
    ).rejects.toThrow(/Session-scoped/);
    expect(fetch).toHaveBeenCalledTimes(1);
    await unchanged();
  });
  it('keeps the unscoped human login path available', async () => {
    vi.stubEnv('INK_SESSION_ID', '');
    vi.stubEnv('INK_ACCESS_TOKEN', jwt(1));
    await writeFile(
      join(home, '.ink', 'auth.json'),
      JSON.stringify({
        access_token: 'stored-human',
        issued_at: Date.now(),
        expires_in: 3600,
        refresh_token: 'stored-refresh',
      })
    );
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: '{"ok":true}' }] },
        })
      )
    );
    expect(await new InkClient('http://127.0.0.1:9999', configPath).callTool('recall', {})).toEqual(
      { ok: true }
    );
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer stored-human',
    });
  });
});
