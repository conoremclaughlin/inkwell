import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only run PCP package tests by default. Clawdbot is a submodule with its own test suite.
    include: [
      'packages/api/src/**/*.test.ts',
      'packages/cli/src/**/*.test.ts',
      'packages/create-inkwell/src/**/*.test.ts',
      'packages/shared/src/**/*.test.ts',
      'packages/channel-plugin/**/*.test.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
      'packages/clawdbot/**',
      '**/*.integration.test.ts',
      // Live tests spawn real backend CLIs and talk to a real server.
      // Run them explicitly via `yarn test:live`, not in the default suite.
      '**/*.live.test.ts',
    ],
  },
});
