import { defineConfig } from 'vitest/config';

export default defineConfig({
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
