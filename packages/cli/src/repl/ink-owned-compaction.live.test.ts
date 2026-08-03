/**
 * ink-owned compaction — live E2E (the Myra boundary case).
 *
 * The keystone principle (task 17d212ff): **ink runs compaction, not the
 * provider.** When a session's context crosses ink's per-model working budget,
 * ink summarizes the oldest entries into a new start state AND rolls the native
 * provider session — so the provider never runs its OWN compaction, and the next
 * turn seeds a fresh native jsonl from ink's summary.
 *
 * This test forces that boundary deterministically on the non-interactive
 * (server / Myra heartbeat) path: pre-seed a transcript with enough entries to
 * blow past a tiny `--max-context-tokens`, run ONE real `ink chat` turn, and
 * assert that INK owned the compaction:
 *
 *   1. a `compaction` event is appended to the transcript with removedCount > 0
 *      (ink summarized — the provider did not);
 *   2. a fresh `backend_session` marker is persisted AFTER the compaction (the
 *      native provider session was rolled, seeding a new jsonl);
 *   3. the turn still exits 0 (continuity across the boundary).
 *
 * All three are DETERMINISTIC and independent of LLM phrasing.
 *
 * Opt-in like the other live tests: requires a live Inkwell server AND the real
 * Claude CLI. Runs only when INK_LIVE_RUN_CLAUDE (or CLAUDE_LIVE_READY) is set,
 * via `yarn test:live`. Excluded from `yarn test`.
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

// The protected tail kept verbatim after a compaction is 12 entries
// (AUTO_COMPACT_KEEP_RECENT_ENTRIES in chat.ts). Seed MORE than that so there is
// something older than the tail to compact (cutoff > 0).
const SEED_ENTRY_COUNT = 16;

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
  // realpath so the cwd matches how Claude keys its project dir (macOS symlinks
  // /var → /private/var). See session-reuse.live.test.ts for the full rationale.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ink-live-compact-')));
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

/**
 * Pre-seed a repl transcript for `sessionId` with enough sizeable user/assistant
 * entries that a small --max-context-tokens is guaranteed to be exceeded on the
 * next turn's pre-turn budget check. Returns the seeded file path.
 */
function seedTranscript(cwd: string, sessionId: string): string {
  const replDir = join(cwd, '.ink', 'runtime', 'repl');
  mkdirSync(replDir, { recursive: true });
  const file = join(replDir, `${sessionId}-seed.jsonl`);
  // ~2,500 chars per entry ⇒ ~625 tokens each ⇒ 16 entries ≈ 10K tokens, far
  // above the tiny budget we run with, so compaction is deterministic.
  const filler = 'lorem ipsum dolor sit amet '.repeat(96); // ~2,592 chars
  const lines: string[] = [];
  for (let i = 0; i < SEED_ENTRY_COUNT; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    lines.push(
      JSON.stringify({
        type: role,
        content: `[seed ${i}] ${filler}`,
        eid: i + 1,
        ...(role === 'assistant' ? { success: true } : {}),
      })
    );
  }
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/** Claude stores its jsonl at ~/.claude/projects/<cwd with '/'→'-'>/<id>.jsonl. */
function claudeProjectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/\//g, '-'));
}

function listJsonls(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((f) => f.endsWith('.jsonl')));
}

/** Every transcript event for this pcp session, across all its jsonl files, in order. */
function readSessionEvents(cwd: string, sessionId: string): Array<Record<string, unknown>> {
  const replDir = join(cwd, '.ink', 'runtime', 'repl');
  if (!existsSync(replDir)) return [];
  const files = readdirSync(replDir)
    .filter((f) => f.startsWith(`${sessionId}-`) && f.endsWith('.jsonl'))
    .sort();
  const events: Array<Record<string, unknown>> = [];
  for (const f of files) {
    for (const line of readFileSync(join(replDir, f), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* ignore non-JSON */
      }
    }
  }
  return events;
}

function runInkTurn(cwd: string, sessionId: string, message: string, maxContextTokens: number) {
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
      '--max-context-tokens',
      String(maxContextTokens),
      '--message',
      message,
    ],
    { cwd, encoding: 'utf-8', timeout: TIMEOUT_MS, env: { ...process.env } }
  );
}

describe.sequential('ink-owned compaction (live, non-interactive Myra path)', () => {
  let reachable = false;
  let fixtureDir: string | null = null;

  beforeAll(async () => {
    reachable = await serverReachable(SERVER_URL);
    if (!reachable) {
      // eslint-disable-next-line no-console
      console.warn(
        `[live] Skipping ink-owned compaction e2e: no Inkwell server at ${SERVER_URL}. ` +
          `Start one with \`yarn dev\` or set INK_SERVER_URL.`
      );
      return;
    }
    fixtureDir = buildFixtureDir(SERVER_URL);
  });

  afterAll(() => {
    if (fixtureDir) {
      rmSync(claudeProjectDir(fixtureDir), { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!process.env.INK_LIVE_RUN_CLAUDE && !process.env.CLAUDE_LIVE_READY)(
    'ink compacts at its own budget boundary and rolls the native session',
    async () => {
      if (!reachable || !fixtureDir) return;

      const sessionId = randomUUID();
      const projDir = claudeProjectDir(fixtureDir);
      const before = listJsonls(projDir);

      // Pre-seed a large transcript, then run ONE turn with a tiny budget so the
      // pre-turn budget check is guaranteed to trip ink-owned compaction.
      seedTranscript(fixtureDir, sessionId);
      const run = runInkTurn(fixtureDir, sessionId, 'Reply with just OK.', 2_000);

      // (3) Continuity: the turn survived the compaction boundary.
      expect(run.status, `turn failed:\n${run.stderr}\n${run.stdout}`).toBe(0);

      const events = readSessionEvents(fixtureDir, sessionId);

      // (1) INK owned the compaction — a compaction event was written, and it
      // actually removed entries (the provider never got the chance to compact).
      const compactions = events.filter((e) => e.type === 'compaction');
      expect(
        compactions.length,
        'ink should have written a compaction event at the budget boundary'
      ).toBeGreaterThan(0);
      const removed = compactions.reduce(
        (n, e) => n + (typeof e.removedCount === 'number' ? e.removedCount : 0),
        0
      );
      expect(removed, 'compaction should have removed at least one old entry').toBeGreaterThan(0);

      // (2) The native provider session was rolled at the boundary: a fresh
      // backend_session marker exists AND a new native jsonl was seeded.
      const backendMarkers = events.filter((e) => e.type === 'backend_session');
      expect(
        backendMarkers.length,
        'a backend_session marker should be persisted after the roll'
      ).toBeGreaterThan(0);

      const afterJsonls = listJsonls(projDir);
      const created = [...afterJsonls].filter((f) => !before.has(f));
      expect(
        created.length,
        'ink-owned compaction should seed a fresh native jsonl (rolled session)'
      ).toBeGreaterThan(0);

      // The last backend_session marker should point at a native jsonl that exists.
      const lastMarker = backendMarkers[backendMarkers.length - 1] as { id?: unknown };
      if (typeof lastMarker.id === 'string') {
        expect(afterJsonls.has(`${lastMarker.id}.jsonl`)).toBe(true);
      }
    }
  );
});
