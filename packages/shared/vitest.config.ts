import { defineConfig } from 'vitest/config';

/**
 * Package-local config so `yarn workspace @inklabs/shared test` (which CI's
 * root `yarn test` fans out to) runs this package's tests. Before it, the
 * package's test script only echoed, and its tests ran only when someone
 * invoked vitest from the repo root.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
