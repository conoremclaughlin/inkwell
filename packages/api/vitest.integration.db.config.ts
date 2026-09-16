import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    exclude: [
      'node_modules',
      'dist',
      // Runtime/CLI E2E tests run in vitest.integration.runtime.config.ts
      'src/services/sessions/codex-runner.integration.test.ts',
      // LIVE suites consume real LLM tokens and run ONLY via
      // vitest.live.config.ts with their explicit env gates — never collected
      // by the DB project, so the config separation matches the env gating
      // (Lumen, PR #439 round 2).
      'src/**/*.live.integration.test.ts',
    ],
    testTimeout: 120000,
    hookTimeout: 30000,
    setupFiles: ['./src/test/setup.ts', './src/test/integration-setup.ts'],
  },
});
