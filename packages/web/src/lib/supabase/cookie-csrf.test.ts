import { describe, expect, it } from 'vitest';
import { hasSameOrigin } from './cookie-csrf';

const url = 'http://192.0.2.10:4002/api/admin/tasks';
describe('web cookie provenance', () => {
  it('supports the actual LAN host and port without trusting forwarded hosts', () => {
    expect(hasSameOrigin({ url, headers: new Headers({ origin: 'http://192.0.2.10:4002' }) })).toBe(
      true
    );
    expect(
      hasSameOrigin({ url, headers: new Headers({ referer: 'http://192.0.2.10:4002/tasks' }) })
    ).toBe(true);
  });

  it("uses the actual HTTP Host, not Next's bind address or forwarded host", () => {
    const requestUrl = 'http://0.0.0.0:4002/api/admin/tasks';
    expect(
      hasSameOrigin({
        url: requestUrl,
        headers: new Headers({ host: 'localhost:4002', origin: 'http://localhost:4002' }),
      })
    ).toBe(true);
    expect(
      hasSameOrigin({
        url: requestUrl,
        headers: new Headers({ host: 'localhost:4002', referer: 'http://localhost:4002/tasks' }),
      })
    ).toBe(true);
    for (const origin of [
      'http://0.0.0.0:4002',
      'http://localhost:3002',
      'https://localhost:4002',
      'https://attacker.example',
    ]) {
      expect(
        hasSameOrigin({
          url: requestUrl,
          headers: new Headers({
            host: 'localhost:4002',
            origin,
            'x-forwarded-host': new URL(origin).host,
          }),
        })
      ).toBe(false);
    }
  });

  it.each([
    '',
    'localhost:4002/path',
    'localhost:4002/',
    'localhost:4002?x=y',
    'localhost:4002#x',
    'user@localhost:4002',
    'localhost:4002,attacker.example',
    'local host:4002',
    'localhost:4002\\attacker.example',
    'localhost:99999',
    'a'.repeat(513),
  ])('rejects malformed HTTP Host %j without URL-authority reinterpretation', (host) => {
    expect(
      hasSameOrigin({ url, headers: new Headers({ host, origin: 'http://localhost:4002' }) })
    ).toBe(false);
  });
  it.each([
    {},
    { origin: 'null' },
    { origin: 'https://attacker.example' },
    { origin: 'http://192.0.2.10:4003' },
    { origin: 'http://192.0.2.10:4002.attacker.example' },
    { origin: 'https://192.0.2.10:4002' },
    { origin: 'null', referer: 'http://192.0.2.10:4002/' },
    { origin: 'https://attacker.example', 'x-forwarded-host': 'attacker.example' },
    { origin: 'http://192.0.2.10:4002', 'sec-fetch-site': 'cross-site' },
    { origin: 'http://192.0.2.10:4002', 'sec-fetch-site': 'same-site' },
  ])('rejects absent, opaque, conflicting, or foreign provenance: %j', (headers) => {
    expect(hasSameOrigin({ url, headers: new Headers(headers as Record<string, string>) })).toBe(
      false
    );
  });
});
