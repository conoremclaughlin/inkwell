/**
 * Provider session reuse — live cross-process E2E.
 *
 * This is the real Myra codepath: two SEPARATE `ink chat --non-interactive`
 * processes (like two heartbeats) sharing one PCP session id must resume the
 * SAME native Claude session, so the conversation is one coherent jsonl instead
 * of fragmenting into a new file per message. Unit tests cover the decision and
 * recovery logic in isolation; this asserts the actual wiring end-to-end —
 * `chat.ts` persisting the `backend_session` marker on seed and recovering it on
 * reattach across two real processes against the real Claude backend.
 *
 * Codifies the manual validation from the Stage 2 work (#446). The core
 * assertions are DETERMINISTIC (exactly one native jsonl created across both
 * invocations; the transcript's backend_session marker matches it) and do NOT
 * depend on LLM phrasing; the codeword-recall assertion is a substring check,
 * robust to wording.
 *
 * Opt-in: requires a live Inkwell server AND the real Claude CLI. Runs only when
 * INK_LIVE_RUN_CLAUDE (or CLAUDE_LIVE_READY) is set, via `yarn test:live`.
 * Excluded from `yarn test`.
 *
 * Environment:
 *   INK_LIVE_RUN_CLAUDE / CLAUDE_LIVE_READY — enable this test (costs Claude API)
 *   INK_LIVE_BACKEND_CLI — override `ink` bin path (default: `ink` on PATH)
 *   INK_SERVER_URL       — override server (default: http://localhost:3001)
 *   INK_LIVE_MODEL       — override model (default: claude-sonnet-5)
 */

import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER_URL = process.env.INK_SERVER_URL || 'http://localhost:3001';
const INK_BIN = process.env.INK_LIVE_BACKEND_CLI || 'ink';
const MODEL = process.env.INK_LIVE_MODEL || 'claude-sonnet-5';
const TIMEOUT_MS = Number(process.env.INK_LIVE_TIMEOUT_MS || 150_000);

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

/** Minimal fixture cwd: only the inkwell MCP server + a main-studio identity. */
function buildFixtureDir(serverUrl: string): string {
  // realpath so the cwd matches how Claude keys its project dir. On macOS
  // os.tmpdir() is /var/... but process.cwd() (and Claude's jsonl path) resolves
  // the /private/var/... symlink — without this the project dir wouldn't match.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ink-live-reuse-')));
  mkdirSync(join(root, '.ink'), { recursive: true });
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

/** Claude stores its jsonl at ~/.claude/projects/<cwd with '/'→'-'>/<id>.jsonl. */
function claudeProjectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/\//g, '-'));
}

function listJsonls(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((f) => f.endsWith('.jsonl')));
}

function runInkTurn(cwd: string, sessionId: string, message: string) {
  return spawnSync(
    INK_BIN,
    [
      'chat',
      '--non-interactive',
      '--session-id',
      sessionId,
      '--model',
      MODEL,
      '--tools',
      'off',
      '--message',
      message,
    ],
    { cwd, encoding: 'utf-8', timeout: TIMEOUT_MS, env: { ...process.env } }
  );
}

/** The provider session id ink persisted for this pcp session (transcript marker). */
function backendSessionMarkerId(cwd: string, pcpSessionId: string): string | undefined {
  const replDir = join(cwd, '.ink', 'runtime', 'repl');
  if (!existsSync(replDir)) return undefined;
  const files = readdirSync(replDir).filter(
    (f) => f.startsWith(`${pcpSessionId}-`) && f.endsWith('.jsonl')
  );
  let last: string | undefined;
  for (const f of files) {
    for (const line of readFileSync(join(replDir, f), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { type?: string; id?: string };
        if (e.type === 'backend_session' && typeof e.id === 'string') last = e.id;
      } catch {
        /* ignore non-JSON */
      }
    }
  }
  return last;
}

describe.sequential('provider session reuse (live, cross-process)', () => {
  let reachable = false;
  let fixtureDir: string | null = null;

  beforeAll(async () => {
    reachable = await serverReachable(SERVER_URL);
    if (!reachable) {
      // eslint-disable-next-line no-console
      console.warn(
        `[live] Skipping session-reuse e2e: no Inkwell server at ${SERVER_URL}. ` +
          `Start one with \`yarn dev\` or set INK_SERVER_URL.`
      );
      return;
    }
    fixtureDir = buildFixtureDir(SERVER_URL);
  });

  afterAll(() => {
    if (fixtureDir) {
      // Clean both the fixture (ink transcript) and the per-run Claude project
      // dir it seeded, so live runs don't accumulate jsonls under ~/.claude.
      rmSync(claudeProjectDir(fixtureDir), { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!process.env.INK_LIVE_RUN_CLAUDE && !process.env.CLAUDE_LIVE_READY)(
    'two separate ink processes resume ONE native Claude session (the Myra heartbeat case)',
    async () => {
      if (!reachable || !fixtureDir) return;

      const pcpSessionId = randomUUID();
      const codeword = `WREN-LIVE-${randomUUID().slice(0, 8).toUpperCase()}`;
      const projDir = claudeProjectDir(fixtureDir);
      const before = listJsonls(projDir);

      // ── Process 1: plant the codeword (seeds a fresh native session) ──
      const plant = runInkTurn(
        fixtureDir,
        pcpSessionId,
        `Do not use any tools. Remember this codeword: ${codeword}. Reply with just OK.`
      );
      expect(plant.status, `inv1 failed:\n${plant.stderr}\n${plant.stdout}`).toBe(0);

      const afterPlant = listJsonls(projDir);
      const seeded = [...afterPlant].filter((f) => !before.has(f));
      // DETERMINISTIC: exactly one native session file was created.
      expect(seeded, 'exactly one native Claude jsonl should be seeded').toHaveLength(1);
      const seededJsonl = seeded[0]!;

      // The transcript marker ink persisted must match the seeded jsonl id.
      const markerId = backendSessionMarkerId(fixtureDir, pcpSessionId);
      expect(markerId, 'backend_session marker should be persisted on seed').toBe(
        seededJsonl.replace(/\.jsonl$/, '')
      );

      // ── Process 2: recall the codeword (a SEPARATE process, same pcp session) ──
      const recall = runInkTurn(
        fixtureDir,
        pcpSessionId,
        `Do not use any tools. What codeword did I give you earlier? Reply with ONLY the codeword.`
      );
      expect(recall.status, `inv2 failed:\n${recall.stderr}\n${recall.stdout}`).toBe(0);

      const afterRecall = listJsonls(projDir);
      const createdByRecall = [...afterRecall].filter((f) => !afterPlant.has(f));
      // DETERMINISTIC + the crux: process 2 RESUMED the same native session —
      // no new jsonl. Before Stage 2 this created a second file (the opacity).
      expect(
        createdByRecall,
        'process 2 must resume the same native session, not create a new jsonl'
      ).toHaveLength(0);

      // Cross-process continuity: the resumed session remembered the codeword
      // even though process 2 sent only the delta (never re-sent the codeword).
      expect(
        recall.stdout,
        `recall did not surface the codeword; stdout:\n${recall.stdout}`
      ).toContain(codeword);
    }
  );
});
