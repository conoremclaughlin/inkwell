/**
 * Live backend reflection test for the Claude adapter.
 *
 * Spawns `ink -b claude -p "<prompt>"` against a real running Inkwell server
 * and the real Claude Code CLI. Asserts that the headers the CLI injects
 * actually arrive at the server's middleware — this is the chain that
 * unit tests can't cover:
 *
 *     adapter args/env → claude runtime → .mcp.json substitution
 *         → HTTP Authorization/x-ink-context headers
 *             → server middleware → RequestContext
 *                 → debug_request → stdout
 *
 * Opt-in via `yarn test:live`. Excluded from `yarn test`.
 *
 * Environment:
 *   INK_LIVE_BACKEND_CLI — override `ink` bin path (default: `ink` on PATH)
 *   INK_SERVER_URL       — override server (default: http://localhost:3001)
 *   INK_LIVE_TIMEOUT_MS  — override timeout (default: 120000)
 *
 * The test runs from a temp fixture directory containing only the inkwell
 * MCP server — NOT the project's `.mcp.json` — because other servers
 * (inkmail, playwright, supabase) are not needed for this check and some
 * (inkmail's channel plugin) block `-p` mode from exiting cleanly.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnAndReflect } from './spawn-reflect.js';

const DEFAULT_SERVER_URL = process.env.INK_SERVER_URL || 'http://localhost:3001';
const TIMEOUT_MS = Number(process.env.INK_LIVE_TIMEOUT_MS || 120_000);

async function serverReachable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const res = await fetch(`${url}/mcp`, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Build a minimal fixture dir: only the inkwell MCP server, plus an
 * identity.json that resolves to `main` studio. Returns its path.
 */
function buildFixtureDir(serverUrl: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ink-live-claude-'));
  mkdirSync(join(root, '.ink'), { recursive: true });
  // Both headers are declared as templates so claude resolves them at MCP
  // connect time from its spawn env:
  //   - INK_ACCESS_TOKEN:  set by the ink CLI via resolvePcpAuthEnv
  //   - INK_CONTEXT:       set by the claude backend adapter (encoded token)
  //
  // NOTE: in a real session, the ink CLI would layer x-ink-context on top of
  // the fixture via `injectSessionHeaders`, but that helper short-circuits
  // when no PCP sessionId exists. Declaring the header up-front in the
  // fixture keeps the test self-contained and still exercises the full
  // claude → server header chain.
  writeFileSync(
    join(root, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          inkwell: {
            type: 'http',
            url: `${serverUrl}/mcp`,
            headers: {
              Authorization: 'Bearer ${INK_ACCESS_TOKEN}',
              'x-ink-context': '${INK_CONTEXT}',
            },
          },
        },
      },
      null,
      2
    )
  );
  writeFileSync(
    join(root, '.ink', 'identity.json'),
    JSON.stringify({ agentId: 'wren', studioId: 'main', context: 'main' })
  );
  return root;
}

describe.sequential('claude backend header injection (live)', () => {
  let reachable = false;
  let fixtureDir: string | null = null;

  beforeAll(async () => {
    reachable = await serverReachable(DEFAULT_SERVER_URL);
    if (!reachable) {
      // eslint-disable-next-line no-console
      console.warn(
        `[live] Skipping: no Inkwell server at ${DEFAULT_SERVER_URL}. ` +
          `Start one with \`yarn dev\` or set INK_SERVER_URL.`
      );
      return;
    }
    fixtureDir = buildFixtureDir(DEFAULT_SERVER_URL);
  });

  afterAll(() => {
    if (fixtureDir) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!process.env.CLAUDE_LIVE_READY && !process.env.INK_LIVE_RUN_CLAUDE)(
    'reflects x-ink-context headers back through the running server',
    async () => {
      if (!reachable || !fixtureDir) {
        return;
      }

      const { reflected, rawStdout, rawStderr, exitCode } = await spawnAndReflect({
        backend: 'claude',
        cwd: fixtureDir,
        timeoutMs: TIMEOUT_MS,
      });

      expect(exitCode, `stderr:\n${rawStderr}\nstdout:\n${rawStdout}`).toBe(0);

      // The server-side context must be non-null — if it's null, headers
      // didn't arrive and middleware had nothing to populate.
      expect(
        reflected.requestContext,
        'requestContext was null — headers did not reach server'
      ).not.toBeNull();

      const ctx = reflected.requestContext!;
      // runtime and cliAttached are the smoking-gun fields: they come ONLY
      // from decoding the x-ink-context token. If they're present, the CLI
      // → claude → .mcp.json → server middleware chain is working.
      expect(ctx.runtime, 'runtime field should be "claude" from the x-ink-context token').toBe(
        'claude'
      );
      expect(ctx.cliAttached, 'cliAttached should be true for a CLI-spawned session').toBe(true);
      // studioId in our fixture is "main" (non-UUID) which the server maps to
      // studioHint rather than studioId. Either way, it must round-trip.
      expect(
        ctx.studioHint || ctx.studioId,
        'studio scope should round-trip via x-ink-context'
      ).toBe('main');
      // userId proves Authorization (Bearer ${INK_ACCESS_TOKEN}) resolved
      // and the server validated the signed JWT.
      expect(ctx.userId, 'userId should be resolved from Authorization Bearer token').toBeTruthy();

      expect(reflected.transport).toBe('http');
    }
  );
});
