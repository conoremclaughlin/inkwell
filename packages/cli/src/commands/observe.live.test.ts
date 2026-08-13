/**
 * ink observe — live no-fork e2e (spec:observer-attach acceptance criterion).
 *
 * Two observers attached to one real server-spawned working session render
 * exactly the sequence the ledger recorded, and the session neither knows nor
 * cares. First proven manually 2026-08-07 against session 900abaf0 on an
 * isolated branch server (turn-4 window, eids 53–62, byte-identical views).
 *
 * Opt-in — requires an environment prepared per the procedure below (v1 scope:
 * only server-spawned sessions reach the bus, so the harness cannot spawn the
 * writer itself):
 *
 *   1. Build this branch's CLI:  yarn workspace @inklabs/cli build
 *   2. Start an isolated branch server with the worktree ink FIRST on PATH
 *      (resolve-binary is PATH-based and caches per process):
 *        PATH="<worktree>/node_modules/.bin:$PATH" \
 *        ENABLE_HEARTBEAT_SERVICE=false ENABLE_TELEGRAM=false \
 *        ENABLE_WHATSAPP=false ENABLE_DISCORD=false \
 *        PCP_PORT_BASE=4001 yarn workspace @inklabs/api server
 *   3. Drive one turn through the server (send_to_inbox with a threadKey and
 *      an ink-backed session), wait for "ink chat non-interactive exit".
 *   4. Run:  INK_LIVE_OBSERVE=1 \
 *            INK_OBSERVE_SERVER=http://localhost:4001 \
 *            INK_OBSERVE_SESSION_ID=<sessionId> \
 *            INK_OBSERVE_LEDGER_PATH=<absolute ledger jsonl> \
 *            npx vitest run --config vitest.integration.config.ts \
 *              packages/cli/src/commands/observe.live.test.ts
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ENABLED = process.env.INK_LIVE_OBSERVE === '1';
const SERVER = process.env.INK_OBSERVE_SERVER || 'http://localhost:4001';
const SESSION_ID = process.env.INK_OBSERVE_SESSION_ID || '';
const LEDGER_PATH = process.env.INK_OBSERVE_LEDGER_PATH || '';
const CLI = join(process.cwd(), 'packages/cli/dist/cli.js');

/** Must mirror OBSERVER_PROJECTION_TYPES (bus) and OBS_PROJECTION_TYPES (CLI). */
const PROJECTION = new Set([
  'user',
  'system_turn',
  'auto_turn',
  'assistant',
  'inbox',
  'backend_tool',
  'backend_text',
  'local_tool_call',
  'pcp_tool',
  'backend_session',
  'compaction',
  'session_pause',
  'session_end',
]);

function runObserver(): string {
  return execFileSync(
    'node',
    [CLI, 'observe', SESSION_ID, '--server', SERVER, '--from-start', '--no-follow'],
    { encoding: 'utf-8', timeout: 60_000, env: { ...process.env, INK_SERVER_URL: SERVER } }
  );
}

const renderedEids = (output: string): number[] =>
  output
    .split('\n')
    .filter((l) => /^#\d+ /.test(l.replace(/\[[0-9;]*m/g, '')))
    .map((l) => Number.parseInt(l.replace(/\[[0-9;]*m/g, '').slice(1), 10));

describe.sequential('observer attach — live no-fork acceptance', () => {
  it.skipIf(!ENABLED || !SESSION_ID || !LEDGER_PATH)(
    'two observers render exactly the ledger projection, identically',
    () => {
      const ledgerEids = readFileSync(LEDGER_PATH, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as { eid?: number; type?: string };
          } catch {
            return {};
          }
        })
        .filter((e) => typeof e.eid === 'number' && PROJECTION.has(e.type ?? ''))
        .map((e) => e.eid as number);
      expect(ledgerEids.length).toBeGreaterThan(0);

      const a = runObserver();
      const b = runObserver();

      // N observers, one ledger, identical views.
      expect(renderedEids(a)).toEqual(renderedEids(b));
      // The rendered sequence IS the ledger's observer projection — gapless,
      // duplicate-free, nothing invented, nothing missing.
      expect(renderedEids(a)).toEqual(ledgerEids);
    }
  );
});
