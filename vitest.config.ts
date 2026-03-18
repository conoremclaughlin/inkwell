import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only run PCP package tests by default. Clawdbot is a submodule with its own test suite.
    include: [
      'packages/api/src/**/*.test.ts',
      'packages/cli/src/**/*.test.ts',
      'packages/create-pcp/src/**/*.test.ts',
      'packages/shared/src/**/*.test.ts',
    ],
    exclude: ['node_modules', 'dist', 'packages/clawdbot/**', '**/*.integration.test.ts'],
  },
});
