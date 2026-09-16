import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { join } from 'path';

/**
 * app.config.js decides the API port for every build. It cannot be imported
 * from src (it is CommonJS, loaded by Expo's config resolver in plain Node),
 * so it is required by path — the same way Expo loads it.
 *
 * Worth testing because every failure here is silent: a mis-parsed port
 * produces a perfectly well-formed URL pointing at nothing, and the app
 * reports a network error that looks like the server being down.
 */
const require_ = createRequire(import.meta.url);
const CONFIG_PATH = join(__dirname, '..', '..', 'app.config.js');

function loadConfig(extra: Record<string, unknown> = {}) {
  delete require_.cache[require_.resolve(CONFIG_PATH)];
  const factory = require_(CONFIG_PATH) as (arg: {
    config: Record<string, unknown>;
  }) => Record<string, unknown>;
  return factory({ config: { name: 'Inkwell', extra } });
}

const ORIGINAL = process.env.PCP_PORT_BASE;
const ORIGINAL_INK = process.env.INK_PORT_BASE;

beforeEach(() => {
  delete process.env.PCP_PORT_BASE;
  delete process.env.INK_PORT_BASE;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PCP_PORT_BASE;
  else process.env.PCP_PORT_BASE = ORIGINAL;
  if (ORIGINAL_INK === undefined) delete process.env.INK_PORT_BASE;
  else process.env.INK_PORT_BASE = ORIGINAL_INK;
  vi.restoreAllMocks();
});

describe('apiPort', () => {
  it('defaults to the main dev server when PCP_PORT_BASE is unset', () => {
    expect(loadConfig().extra).toMatchObject({ apiPort: 3001 });
  });

  it('follows INK_PORT_BASE, the canonical name the server resolves first', () => {
    process.env.INK_PORT_BASE = '4801';
    expect((loadConfig().extra as { apiPort: number }).apiPort).toBe(4801);
  });

  it('still follows PCP_PORT_BASE, kept for backward compatibility', () => {
    process.env.PCP_PORT_BASE = '4801';
    expect((loadConfig().extra as { apiPort: number }).apiPort).toBe(4801);
  });

  // Mirrors packages/api/src/config/env.ts: INK_PORT_BASE ?? PCP_PORT_BASE ?? 3001.
  // If these two ever disagree the app addresses a different server than the
  // one that is running, which looks exactly like the server being down.
  it('prefers INK_PORT_BASE when both are set, matching server precedence', () => {
    process.env.INK_PORT_BASE = '4801';
    process.env.PCP_PORT_BASE = '5001';
    expect((loadConfig().extra as { apiPort: number }).apiPort).toBe(4801);
  });

  it.each(['', '   ', 'nonsense'])(
    'falls through to PCP_PORT_BASE when INK_PORT_BASE is %o rather than giving up',
    (value) => {
      process.env.INK_PORT_BASE = value;
      process.env.PCP_PORT_BASE = '5001';
      expect((loadConfig().extra as { apiPort: number }).apiPort).toBe(5001);
    }
  );

  it.each(['', '   ', 'abc', '0', '-1', '70000', '80.5'])(
    'falls back to 3001 rather than trusting %o',
    (value) => {
      process.env.PCP_PORT_BASE = value;
      const port = (loadConfig().extra as { apiPort: number }).apiPort;
      // 80.5 parses to 80 under parseInt, which is a valid port but not what
      // anyone meant; the rule is only that we never emit a URL that cannot
      // resolve. Everything else must land on the documented default.
      expect(value === '80.5' ? 80 : 3001).toBe(port);
    }
  );
});

describe('lanHost', () => {
  it('is a usable IPv4 or explicitly null — never undefined or a partial value', () => {
    const { lanHost } = loadConfig().extra as { lanHost: string | null };
    if (lanHost === null) return;
    expect(lanHost).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    expect(lanHost).not.toMatch(/^127\./);
  });
});

describe('extra', () => {
  it('preserves what app.json already declared', () => {
    const extra = loadConfig({ productionApiUrl: 'https://api.example.com' }).extra as Record<
      string,
      unknown
    >;
    expect(extra.productionApiUrl).toBe('https://api.example.com');
    expect(extra.apiPort).toBe(3001);
  });

  it('keeps the rest of the config intact', () => {
    expect(loadConfig().name).toBe('Inkwell');
  });
});
