/**
 * Fake environment values for unit tests.
 *
 * One module so no test ever writes a literal next to a name like JWT_SECRET
 * again. That shape is what a secret scanner matches, and every ad-hoc dodge it
 * produced — `'x'.repeat(40)`, `'not-a-real-secret-'.padEnd(40, 'x')` — was
 * somebody working around the alarm instead of removing its cause. Twelve test
 * files had drifted onto the same 51-character look-alike string.
 *
 * Nothing under test reads these values. `ink-tokens` only needs `jwt.sign` and
 * `jwt.verify` to agree on the same string, so the values are chosen to be
 * unmistakably fake to a person, a reviewer and a scanner alike.
 */

import { httpRateLimitEnvSchema } from '../config/http-rate-limit';

/** Short and self-describing. Used wherever the env schema is mocked away. */
const FAKE = 'test-fake-secret';

/**
 * The one place length matters: `env.ts` declares `JWT_SECRET: z.string().min(32)`,
 * and `setup.ts` feeds the REAL module through `process.env`. Everywhere else the
 * schema never runs. Spelled out rather than padded, so it still reads as a fake.
 */
const FAKE_MIN32 = 'test-fake-secret-min-32-characters';

// Guard the guard: if this ever drops below the schema's floor, every suite that
// parses the real env would fail far from here, with a confusing message.
if (FAKE_MIN32.length < 32) {
  throw new Error(`fake-env: FAKE_MIN32 must be >= 32 chars, got ${FAKE_MIN32.length}`);
}

/** Spread into a `vi.mock('.../config/env')` factory; add per-test fields after it. */
export const fakeEnv = {
  ...httpRateLimitEnvSchema.parse({}),
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SECRET_KEY: FAKE,
  SUPABASE_PUBLISHABLE_KEY: FAKE,
  JWT_SECRET: FAKE_MIN32,
};

/**
 * A deliberately DIFFERENT fake, for controls that must prove a wrong secret is
 * rejected. Exists so those tests stop reaching for an ad-hoc literal, which is
 * how `'not-the-secret-at-all-but-long-enough-to-sign'` and
 * `'not-a-real-secret-'.padEnd(40, 'x')` got written.
 */
export const fakeWrongValue = 'test-fake-secret-a-different-one';

/** For `process.env` defaults, where the real schema does parse. */
export const fakeProcessEnv = {
  SUPABASE_PUBLISHABLE_KEY: FAKE,
  SUPABASE_SECRET_KEY: FAKE,
  JWT_SECRET: FAKE_MIN32,
};
