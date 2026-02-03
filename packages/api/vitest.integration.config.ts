import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    exclude: ['node_modules', 'dist'],
    // Integration tests spawn real Claude Code processes — need long timeouts
    testTimeout: 120000,
    hookTimeout: 30000,
    // Load env vars + integration pre-flight checks
    setupFiles: ['./src/test/setup.ts', './src/test/integration-setup.ts'],
  },
});
