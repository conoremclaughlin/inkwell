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
