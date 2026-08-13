import { defineConfig } from 'vitest/config';

/**
 * LIVE test project — suites that call a real LLM backend and consume real
 * tokens. Mirrors packages/cli/vitest.live.config.ts: live suites are
 * collected ONLY here, never by the default or DB-integration configs, and
 * each file additionally gates on its explicit env flag (INK_LIVE_TESTS=1).
 * Both layers are deliberate cost protection — see the CI test-tier policy
 * comments in src/test/integration-setup.ts.
 *
 * Run: INK_LIVE_TESTS=1 npx vitest run --config packages/api/vitest.live.config.ts
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.live.test.ts', 'src/**/*.live.integration.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 300000,
    hookTimeout: 30000,
    setupFiles: ['./src/test/setup.ts', './src/test/integration-setup.ts'],
  },
});
