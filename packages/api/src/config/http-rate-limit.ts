import { z } from 'zod';

function positiveInteger(defaultValue: number, maximum = Number.MAX_SAFE_INTEGER) {
  return z
    .string()
    .regex(/^[0-9]+$/, 'Must be a positive decimal integer')
    .default(String(defaultValue))
    .transform(Number)
    .pipe(z.number().int().positive().max(maximum));
}

/** Pure schema: importing it must not load dotenv or require database credentials. */
export const httpRateLimitEnvSchema = z.object({
  INK_HTTP_RATE_LIMIT_MAX: positiveInteger(1200),
  INK_HTTP_RATE_LIMIT_WINDOW_MS: positiveInteger(60_000, 2_147_483_647),
  INK_OAUTH_RATE_LIMIT_MAX: positiveInteger(60),
  INK_OAUTH_RATE_LIMIT_WINDOW_MS: positiveInteger(60_000, 2_147_483_647),
  INK_RATE_LIMIT_EXEMPT_LOOPBACK: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export type HttpRateLimitConfig = z.infer<typeof httpRateLimitEnvSchema>;
