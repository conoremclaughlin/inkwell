import { defineConfig } from 'vitest/config';

/**
 * Live tests (*.live.test.ts) spawn a real backend CLI (claude, codex, gemini)
 * non-interactively and exercise its ability to talk to a running PCP MCP
 * server. They verify things that unit tests cannot:
 *
 *  - Header injection via .mcp.json / --config
 *  - Env-var substitution by the backend runtime
 *  - End-to-end identity/session context propagation
 *
 * Requirements to run:
 *  - The relevant backend CLI installed on PATH (`claude`, `codex`, `gemini`)
 *  - A running PCP server (defaults to http://localhost:3001) OR the test
 *    brings up its own on PCP_PORT_BASE
 *  - Valid auth for the CLI (already logged in)
 *
 * These are slow and stateful — keep them out of the default `yarn test` run.
 */
export default defineConfig({
  test: {
    include: ['packages/**/*.live.test.ts'],
    exclude: ['node_modules', 'dist', 'packages/clawdbot/**'],
    // Live backends can take a while to cold-start and produce a response.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
