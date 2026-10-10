import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Match the root and CLI projects: exercise current shared source, not
      // the last build. Source-level provider mocks must intercept the same
      // module the host loads, or a fake-child test can prepare real files.
      '@inklabs/shared/node-host': path.resolve(__dirname, '../shared/src/node-host/index.ts'),
      '@inklabs/shared/runtime': path.resolve(__dirname, '../shared/src/runtime/index.ts'),
      '@inklabs/shared/providers': path.resolve(__dirname, '../shared/src/providers/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    // LIVE suites (real LLM tokens) run ONLY via vitest.live.config.ts —
    // excluded here so the unit project can never collect them, matching the
    // per-file env gates (cost protection, deliberate; see
    // src/test/integration-setup.ts).
    exclude: ['node_modules', 'dist', 'src/**/*.integration.test.ts', 'src/**/*.live.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules',
        'dist',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/test-*.ts',
        'src/scripts/**',
      ],
    },
    // Load env vars for tests
    setupFiles: ['./src/test/setup.ts'],
  },
});
