import { defineConfig } from 'vitest/config';

// The plugin lives at the package root (index.ts is executed directly via
// tsx — no src/ tree), so the root config's `src/**` include never matches.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
