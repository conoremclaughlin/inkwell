import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // The agent loop lives in @inklabs/shared/runtime, and the wiring tests
      // here drive it. Resolved through the package's dist, they would run the
      // loop as of the last shared build rather than its source. The root
      // vitest.config.ts carries the same mapping and says why.
      '@inklabs/shared/runtime': path.resolve(__dirname, '../shared/src/runtime/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Live tests spawn real backend CLIs — run them via the root
    // `yarn test:live`, not in the default per-workspace suite.
    exclude: ['node_modules', 'dist', '**/*.integration.test.ts', '**/*.live.test.ts'],
  },
});
