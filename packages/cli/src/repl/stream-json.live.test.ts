/**
 * Claude stream-json — live E2E.
 *
 * Proves the ink CLI's claude adapter now runs `--output-format stream-json`
 * and ink parses it correctly: the assistant reply is extracted as clean text
 * (NOT the raw NDJSON event stream), backend tool calls surface live on the
 * event feed, and usage is captured. This is the foundation for live CLI/web
 * streaming + the token-flow idle timeout.
 *
 * DETERMINISTIC assertions (independent of LLM phrasing): the emitted `result`
 * line's text is the reply and is NOT raw NDJSON; a tools-on turn emits
 * `tool_call` events. A codeword substring check confirms real extraction.
 *
 * Opt-in: requires a live Inkwell server AND the real Claude CLI. Runs only when
 * INK_LIVE_RUN_CLAUDE (or CLAUDE_LIVE_READY) is set, via `yarn test:live`.
 */

import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
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

function buildFixtureDir(serverUrl: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ink-live-streamjson-')));
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

function runInkTurn(cwd: string, message: string, tools: 'off' | 'on') {
  const args = [
    'chat',
    '--non-interactive',
    '--session-id',
    randomUUID(),
    '--model',
    MODEL,
    ...(tools === 'off' ? ['--tools', 'off'] : []),
    '--message',
    message,
  ];
  return spawnSync(INK_BIN, args, {
    cwd,
    encoding: 'utf-8',
    timeout: TIMEOUT_MS,
    env: { ...process.env },
  });
}

/** Pull the final `{"type":"result",...}` NDJSON line ink emits. */
function resultLine(stdout: string): { text?: string; usage?: Record<string, unknown> } | null {
  const lines = stdout.split('\n').filter((l) => l.trim().startsWith('{"type":"result"'));
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

describe.sequential('claude stream-json (live)', () => {
  let reachable = false;
  let fixtureDir: string | null = null;

  beforeAll(async () => {
    reachable = await serverReachable(SERVER_URL);
    if (reachable) fixtureDir = buildFixtureDir(SERVER_URL);
  });

  afterAll(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  it.skipIf(!process.env.INK_LIVE_RUN_CLAUDE && !process.env.CLAUDE_LIVE_READY)(
    'extracts the assistant reply as clean text, not raw NDJSON',
    async () => {
      if (!reachable || !fixtureDir) return;
      const codeword = `PONG-${randomUUID().slice(0, 6).toUpperCase()}`;
      const run = runInkTurn(fixtureDir, `Reply with exactly one word: ${codeword}`, 'off');
      expect(run.status, `turn failed:\n${run.stderr}\n${run.stdout}`).toBe(0);

      const result = resultLine(run.stdout);
      expect(result, 'ink should emit a result line with parsed text').toBeTruthy();
      // The reply is the codeword — proving stream-json text extraction works.
      expect(result!.text).toContain(codeword);
      // And it is NOT the raw NDJSON event stream leaking through as the reply.
      expect(result!.text ?? '').not.toContain('"type":"assistant"');
      expect(result!.text ?? '').not.toContain('"output-format"');
    }
  );

  it.skipIf(!process.env.INK_LIVE_RUN_CLAUDE && !process.env.CLAUDE_LIVE_READY)(
    'surfaces backend tool calls live on the event feed',
    async () => {
      if (!reachable || !fixtureDir) return;
      const run = runInkTurn(
        fixtureDir,
        'Call the get_timezone tool, then reply with ONLY my timezone string.',
        'on'
      );
      expect(run.status, `turn failed:\n${run.stderr}\n${run.stdout}`).toBe(0);
      // At least one backend tool_call event was emitted mid-turn (the whole
      // point of streaming — before this the feed was silent during generation).
      const backendToolCalls = run.stdout
        .split('\n')
        .filter((l) => l.includes('"type":"tool_call"') && l.includes('"layer":"backend"'));
      expect(
        backendToolCalls.length,
        `no backend tool_call events:\n${run.stdout}`
      ).toBeGreaterThan(0);
    }
  );
});
