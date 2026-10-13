import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { createCliBackendHost } from './cli-host.js';

// The CLI host answers from its own process, as the adapters did before the
// port. Its `claude --help` probe is not exercised here: it runs a real
// binary, and it moved unchanged from the adapter.
describe('the CLI backend host', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads the ambient session and its paths when asked, not when made', () => {
    const host = createCliBackendHost();
    vi.stubEnv('INK_SESSION_ID', 'sess-ambient');
    vi.stubEnv('INK_STUDIO_ID', 'studio-ambient');
    vi.stubEnv('INK_STUDIOS_ROOT', '/synthetic/studios');
    expect(host.ambientSession()).toEqual({
      inkSessionId: 'sess-ambient',
      studioId: 'studio-ambient',
    });
    expect(host.paths.studiosRoot).toBe('/synthetic/studios');

    vi.stubEnv('INK_STUDIOS_ROOT', '');
    expect(host.paths.studiosRoot).toBe(join(homedir(), '.ink', 'studios'));
    expect(host.paths.inkFiles).toBe(join(homedir(), '.ink', 'files'));
  });

  it('hands over its own session credentials by name, and nothing else', async () => {
    vi.stubEnv('INK_ACCESS_TOKEN', 'synthetic-token');
    vi.stubEnv('JWT_SECRET', 'synthetic-secret');
    const env = await createCliBackendHost().sessionEnv({ hardTimeoutMs: 1 });
    expect(env.INK_ACCESS_TOKEN).toBe('synthetic-token');
    expect('JWT_SECRET' in env).toBe(false);
  });

  it('spawns a binary by its name, through PATH', async () => {
    expect(await createCliBackendHost().resolveBinary('claude')).toBe('claude');
  });
});
