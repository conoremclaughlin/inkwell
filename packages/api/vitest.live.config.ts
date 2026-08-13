import { defineConfig } from 'vitest/config';

/**
 * LIVE test project — suites that call a real LLM backend and consume real
 * tokens. Mirrors packages/cli/vitest.live.config.ts: live suites are
 * collected ONLY here, never by the default or DB-integration configs, and
 * each file additionally gates on its explicit env flag (INK_LIVE_TESTS=1).
 * Both layers are deliberate cost protection — see the CI test-tier policy
 * comments in src/test/integration-setup.ts.
 *
 * Run: yarn workspace @inklabs/api test:live
 * (the script runs with this package as cwd, so the src/** globs resolve;
 * a repo-root `npx vitest --config packages/api/...` collects nothing)
 *
 * Setup is live-setup.ts ONLY — env loading with no fake credential
 * fallbacks and no DB safety guard. setup.ts's fake Supabase values would
 * make DB-dependent live gates look configured, and integration-setup.ts's
 * guard would abort non-DB live suites (mlx-tts) before their own
 * INK_LIVE_TESTS gate runs (Lumen, PR #439 round 3).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.live.test.ts', 'src/**/*.live.integration.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 300000,
    hookTimeout: 30000,
    setupFiles: ['./src/test/live-setup.ts'],
  },
});
