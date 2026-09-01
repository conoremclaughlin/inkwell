import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // packages/web resolves '@' to its own src via tsconfig paths, and its
      // local vitest config repeats that. Running its suite from the root
      // needs the same mapping. No other package uses the '@' prefix, so this
      // is unambiguous at the workspace level.
      '@': path.resolve(__dirname, 'packages/web/src'),
    },
  },
  test: {
    // Only run PCP package tests by default. Clawdbot is a submodule with its own test suite.
    include: [
      'packages/api/src/**/*.test.ts',
      'packages/cli/src/**/*.test.ts',
      'packages/create-inkwell/src/**/*.test.ts',
      'packages/shared/src/**/*.test.ts',
      'packages/channel-plugin/**/*.test.ts',
      // packages/web was absent from this list, so its suite only ran if
      // someone happened to invoke vitest from inside packages/web. Six files
      // and 43 assertions — including the auth-flow and key-leak checks — were
      // passing unobserved, which is the same as not having them.
      'packages/web/src/**/*.test.ts',
      'packages/web/src/**/*.test.tsx',
      // Mobile's tests are the pure modules only (URL resolution, display
      // formatting) — no React Native imports, so they run in node like
      // everything else. Screen-level testing happens on a device.
      'packages/mobile/src/**/*.test.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
      'packages/clawdbot/**',
      '**/*.integration.test.ts',
      // Live tests spawn real backend CLIs and talk to a real server.
      // Run them explicitly via `yarn test:live`, not in the default suite.
      '**/*.live.test.ts',
    ],
  },
});
