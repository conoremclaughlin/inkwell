import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Live tests spawn real backend CLIs — run them via the root
    // `yarn test:live`, not in the default per-workspace suite.
    exclude: ['node_modules', 'dist', '**/*.live.test.ts'],
  },
});
