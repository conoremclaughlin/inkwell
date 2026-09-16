import { describe, it, expect } from 'vitest';
import { resolveApiUrl, isLoopback, hostnameFrom, describeApiUrlProblem } from './resolveApiUrl';

const base = { isDev: true, port: 6001 };

describe('hostnameFrom', () => {
  it.each([
    ['192.168.86.60:8081', '192.168.86.60'],
    ['exp://192.168.86.60:8081', '192.168.86.60'],
    ['exp://192.168.86.60:8081/--/path', '192.168.86.60'],
    ['http://10.0.0.4:19000', '10.0.0.4'],
    ['localhost:8081', 'localhost'],
    ['localhost', 'localhost'],
    ['192.168.86.60:8081/_expo', '192.168.86.60'],
  ])('%s -> %s', (input, expected) => {
    expect(hostnameFrom(input)).toBe(expected);
  });

  it.each([undefined, null, '', '   '])('returns undefined for %s', (input) => {
    expect(hostnameFrom(input)).toBeUndefined();
  });

  it('rejects a bare port with no host', () => {
    expect(hostnameFrom(':8081')).toBeUndefined();
  });
});

describe('resolveApiUrl', () => {
  it('prefers an explicit override over everything else', () => {
    expect(
      resolveApiUrl({
        ...base,
        explicit: 'https://api.example.com',
        metroHostCandidates: ['192.168.1.5:8081'],
        productionApiUrl: 'https://prod.example.com',
      })
    ).toEqual({ url: 'https://api.example.com', source: 'env' });
  });

  it('ignores a blank override rather than treating it as set', () => {
    expect(
      resolveApiUrl({ ...base, explicit: '   ', metroHostCandidates: ['192.168.1.5:8081'] })
    ).toEqual({ url: 'http://192.168.1.5:6001', source: 'metro' });
  });

  it('derives the host from Metro and swaps in the API port', () => {
    expect(resolveApiUrl({ ...base, metroHostCandidates: ['192.168.86.60:8081'] })).toEqual({
      url: 'http://192.168.86.60:6001',
      source: 'metro',
    });
  });

  it('falls through empty candidates to the first usable one', () => {
    // The real failure mode: expoConfig.hostUri is undefined under Expo Go, so
    // reading only that lands on loopback and breaks physical devices.
    expect(
      resolveApiUrl({
        ...base,
        metroHostCandidates: [undefined, null, '', 'exp://192.168.86.60:8081'],
      })
    ).toEqual({ url: 'http://192.168.86.60:6001', source: 'metro' });
  });

  it('keeps autodiscovering in dev even when a production URL is configured', () => {
    expect(
      resolveApiUrl({
        ...base,
        metroHostCandidates: ['10.0.0.4:8081'],
        productionApiUrl: 'https://prod.example.com',
      }).source
    ).toBe('metro');
  });

  it('uses the configured production URL when there is no Metro host', () => {
    expect(
      resolveApiUrl({ ...base, isDev: false, productionApiUrl: 'https://prod.example.com' })
    ).toEqual({ url: 'https://prod.example.com', source: 'config' });
  });

  it('strips a trailing slash so paths do not double up', () => {
    expect(resolveApiUrl({ ...base, explicit: 'https://api.example.com/' }).url).toBe(
      'https://api.example.com'
    );
  });

  it('falls back to loopback when nothing is available', () => {
    expect(resolveApiUrl(base)).toEqual({ url: 'http://127.0.0.1:6001', source: 'fallback' });
  });
});

describe('isLoopback', () => {
  it.each([
    ['http://localhost:6001', true],
    ['http://127.0.0.1:6001', true],
    ['https://localhost', true],
    ['http://192.168.86.60:6001', false],
    ['https://api.example.com', false],
    // Must not match a hostname that merely starts with the loopback name.
    ['http://localhost.evil.com', false],
  ])('%s -> %s', (url, expected) => {
    expect(isLoopback(url)).toBe(expected);
  });
});

describe('describeApiUrlProblem', () => {
  it('flags a release build with no production URL configured', () => {
    const hint = describeApiUrlProblem({ url: 'http://127.0.0.1:6001', source: 'fallback' }, false);
    expect(hint).toMatch(/productionApiUrl/);
  });

  it('explains that loopback is the phone itself', () => {
    const hint = describeApiUrlProblem({ url: 'http://127.0.0.1:6001', source: 'fallback' }, true);
    expect(hint).toMatch(/phone itself/);
  });

  it('has no complaint about a well-formed explicit URL', () => {
    expect(
      describeApiUrlProblem({ url: 'https://api.example.com', source: 'env' }, false)
    ).toBeUndefined();
  });
});

describe('the baked LAN address', () => {
  const base = { isDev: true, port: 3001 };

  it('is used when there is no Metro host — the on-device release case', () => {
    expect(resolveApiUrl({ ...base, lanHost: '192.168.86.60' })).toEqual({
      url: 'http://192.168.86.60:3001',
      source: 'lan',
    });
  });

  it('loses to a live Metro host, so a dev build follows a changing DHCP lease', () => {
    const resolved = resolveApiUrl({
      ...base,
      metroHostCandidates: ['192.168.86.99:8081'],
      lanHost: '192.168.86.60',
    });
    expect(resolved).toEqual({ url: 'http://192.168.86.99:3001', source: 'metro' });
  });

  it('beats productionApiUrl in a dev build, so dev keeps autodiscovering', () => {
    const resolved = resolveApiUrl({
      ...base,
      lanHost: '192.168.86.60',
      productionApiUrl: 'https://api.example.com',
    });
    expect(resolved.source).toBe('lan');
  });

  // app.config.js records a LAN address on whatever machine produced the build,
  // so if LAN outranked production unconditionally, a shipped app would address
  // the builder's laptop and productionApiUrl could never take effect.
  it('LOSES to productionApiUrl in a release build — a shipped app must not point at a laptop', () => {
    const resolved = resolveApiUrl({
      isDev: false,
      port: 3001,
      lanHost: '192.168.1.10',
      productionApiUrl: 'https://api.example.com',
    });
    expect(resolved).toEqual({ url: 'https://api.example.com', source: 'config' });
  });

  it('is still used in a release build when no production URL is configured', () => {
    const resolved = resolveApiUrl({ isDev: false, port: 3001, lanHost: '192.168.1.10' });
    expect(resolved).toEqual({ url: 'http://192.168.1.10:3001', source: 'lan' });
  });

  it('never outranks a live Metro host, in either kind of build', () => {
    for (const isDev of [true, false]) {
      const resolved = resolveApiUrl({
        isDev,
        port: 3001,
        metroHostCandidates: ['192.168.86.99:8081'],
        lanHost: '192.168.1.10',
        productionApiUrl: 'https://api.example.com',
      });
      expect(resolved.source).toBe('metro');
    }
  });

  it('is skipped when app.config found no address, rather than building a broken URL', () => {
    expect(resolveApiUrl({ ...base, lanHost: null }).source).toBe('fallback');
    expect(resolveApiUrl({ ...base, lanHost: '   ' }).source).toBe('fallback');
  });

  it('carries the discovered port, not a hardcoded one', () => {
    const resolved = resolveApiUrl({ ...base, port: 4801, lanHost: '192.168.86.60' });
    expect(resolved.url).toBe('http://192.168.86.60:4801');
  });

  it('explains itself when the build machine may have moved', () => {
    const resolved = resolveApiUrl({ ...base, lanHost: '192.168.86.60' });
    expect(describeApiUrlProblem(resolved, true)).toMatch(/rebuild or set the server URL/i);
  });
});

describe('the discovered port reaches every tier', () => {
  it('applies to the Metro host too', () => {
    const resolved = resolveApiUrl({
      isDev: true,
      port: 4001,
      metroHostCandidates: ['192.168.86.99:8081'],
    });
    expect(resolved.url).toBe('http://192.168.86.99:4001');
  });

  it('applies to the loopback fallback', () => {
    expect(resolveApiUrl({ isDev: true, port: 4001 }).url).toBe('http://127.0.0.1:4001');
  });
});

describe('config values that are not strings', () => {
  // Expo resolves `"productionApiUrl": null` in app.json to `{}`. Optional
  // chaining does not save us there — `{}?.trim()` throws — and the throw
  // happens at module import, killing the app on launch.
  it('treats Expo’s {} for a null config value as absent instead of throwing', () => {
    expect(() =>
      resolveApiUrl({ isDev: false, port: 3001, productionApiUrl: {} as unknown as string })
    ).not.toThrow();
    expect(
      resolveApiUrl({ isDev: false, port: 3001, productionApiUrl: {} as unknown as string }).source
    ).toBe('fallback');
  });

  it.each([{}, [], 42, true, null])('ignores %o in any slot', (value) => {
    const resolved = resolveApiUrl({
      isDev: false,
      port: 3001,
      explicit: value as unknown as string,
      lanHost: value as unknown as string,
      productionApiUrl: value as unknown as string,
    });
    expect(resolved).toEqual({ url: 'http://127.0.0.1:3001', source: 'fallback' });
  });
});
