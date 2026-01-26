import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: ['node_modules', 'dist'],
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
