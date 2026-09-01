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
