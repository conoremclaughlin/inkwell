import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.live.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 180_000,
    hookTimeout: 30_000,
  },
});
