import { defineConfig } from 'vitest/config';

/**
 * Package-local config so `yarn workspace @inklabs/mobile test` (which CI's
 * root `yarn test` fans out to) discovers this package's tests. Without it
 * Vitest found only the repo-root config, whose include globs are relative to
 * the repo root and match nothing from here — 57 tests skipped, exit 0.
 * The root config still includes these files for `npx vitest run` at the root.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
