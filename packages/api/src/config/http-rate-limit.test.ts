import { describe, expect, it } from 'vitest';
import { httpRateLimitEnvSchema } from './http-rate-limit';

describe('HTTP rate-limit environment configuration', () => {
  it('defines the default budgets and direct-loopback exemption', () => {
    expect(httpRateLimitEnvSchema.parse({})).toEqual({
      INK_HTTP_RATE_LIMIT_MAX: 1200,
      INK_HTTP_RATE_LIMIT_WINDOW_MS: 60_000,
      INK_OAUTH_RATE_LIMIT_MAX: 60,
      INK_OAUTH_RATE_LIMIT_WINDOW_MS: 60_000,
      INK_RATE_LIMIT_EXEMPT_LOOPBACK: true,
    });
  });

  it('accepts independent budget/window overrides and an explicit exemption opt-out', () => {
    expect(
      httpRateLimitEnvSchema.parse({
        INK_HTTP_RATE_LIMIT_MAX: '2400',
        INK_HTTP_RATE_LIMIT_WINDOW_MS: '120000',
        INK_OAUTH_RATE_LIMIT_MAX: '30',
        INK_OAUTH_RATE_LIMIT_WINDOW_MS: '30000',
        INK_RATE_LIMIT_EXEMPT_LOOPBACK: 'false',
      })
    ).toEqual({
      INK_HTTP_RATE_LIMIT_MAX: 2400,
      INK_HTTP_RATE_LIMIT_WINDOW_MS: 120_000,
      INK_OAUTH_RATE_LIMIT_MAX: 30,
      INK_OAUTH_RATE_LIMIT_WINDOW_MS: 30_000,
      INK_RATE_LIMIT_EXEMPT_LOOPBACK: false,
    });
  });

  describe.each([
    'INK_HTTP_RATE_LIMIT_MAX',
    'INK_HTTP_RATE_LIMIT_WINDOW_MS',
    'INK_OAUTH_RATE_LIMIT_MAX',
    'INK_OAUTH_RATE_LIMIT_WINDOW_MS',
  ])('%s', (key) => {
    it.each([
      '',
      ' ',
      '0',
      '-1',
      '1.5',
      'Infinity',
      'NaN',
      '1e3',
      '0x10',
      '10requests',
      '9007199254740992',
    ])('rejects invalid value %j instead of silently disabling protection', (value) => {
      expect(httpRateLimitEnvSchema.safeParse({ [key]: value }).success).toBe(false);
    });
  });

  it.each(['INK_HTTP_RATE_LIMIT_WINDOW_MS', 'INK_OAUTH_RATE_LIMIT_WINDOW_MS'])(
    'bounds %s to Node timer capacity',
    (key) => {
      expect(httpRateLimitEnvSchema.safeParse({ [key]: '2147483647' }).success).toBe(true);
      expect(httpRateLimitEnvSchema.safeParse({ [key]: '2147483648' }).success).toBe(false);
    }
  );

  it.each(['', '0', '1', 'yes', 'FALSE'])(
    'rejects ambiguous exemption value %j rather than coercing it to true',
    (value) => {
      expect(
        httpRateLimitEnvSchema.safeParse({ INK_RATE_LIMIT_EXEMPT_LOOPBACK: value }).success
      ).toBe(false);
    }
  );
});
