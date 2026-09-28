/**
 * The plugin under a print-mode host (task 2f892701).
 *
 * `claude -p` accepts a channel notification and never shows it to the model,
 * so a plugin polling there acked — consumed — messages nobody read, and its
 * cli_poll_at stamp steered the server to inline delivery instead of a queued
 * turn. These tests launch the real plugin process against a stub Inkwell
 * server and compare the two host modes over the same window: the control
 * shows the fetch → push → ack → detach chain, and the print arm must show
 * none of it.
 *
 * The print arm is launched with PRINT_MODE_CHANNEL_ENV from @inklabs/shared
 * (read by path — this package does not depend on shared), so the spawners'
 * constant and the plugin's literal cannot drift apart unnoticed.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server, type IncomingMessage } from 'http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PRINT_MODE_CHANNEL_ENV } from '../shared/src/runner/mcp-config';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const MESSAGE_ID = '00000000-0000-4000-8000-0000000000aa';
const THREAD_KEY = 'pr:1';

// The plugin's first poll runs 2s after connect; at a 200ms interval the
// control completes several fetch/ack cycles inside this window.
const WINDOW_MS = 5000;

interface Recorded {
  path: string;
  tool?: string;
  args?: Record<string, unknown>;
  body: Record<string, unknown>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

function toolResult(payload: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
  });
}

/** An Inkwell stand-in holding one unread task_request on one thread. */
function startStub(recorded: Recorded[]): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const path = req.url ?? '';
    if (path === '/mcp') {
      const params = body.params as { name: string; arguments: Record<string, unknown> };
      recorded.push({ path, tool: params.name, args: params.arguments, body });
      res.setHeader('Content-Type', 'application/json');
      if (params.name === 'get_inbox') {
        res.end(
          toolResult({
            success: true,
            messages: [],
            threadsWithUnread: [{ threadKey: THREAD_KEY, unreadCount: 1 }],
          })
        );
      } else if (params.name === 'get_thread_messages') {
        res.end(
          toolResult({
            success: true,
            messages: [
              {
                id: MESSAGE_ID,
                senderSlug: 'lumen',
                content: 'Please review the fixture change.',
                messageType: 'task_request',
                createdAt: '2026-09-27T16:11:40.000Z',
              },
            ],
          })
        );
      } else {
        res.end(toolResult({ success: true }));
      }
      return;
    }
    recorded.push({ path, body });
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

let home: string;
let stub: { server: Server; url: string };
let recorded: Recorded[];
let child: ChildProcess | null = null;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'inkmail-host-mode-'));
  mkdirSync(join(home, '.ink'), { recursive: true });
  writeFileSync(join(home, '.ink', 'config.json'), JSON.stringify({ email: 'sb@example.com' }));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child = null;
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
});

/**
 * Launch the plugin, complete the MCP handshake the way the host does, hold
 * the window, then close stdin (the host exiting) and wait for the exit.
 */
async function runPlugin(extraEnv: Record<string, string>): Promise<{ stdout: string }> {
  recorded = [];
  stub = await startStub(recorded);
  const proc = spawn(process.execPath, [TSX_CLI, 'index.ts'], {
    cwd: PLUGIN_DIR,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      INK_SERVER_URL: stub.url,
      INK_SB_SLUG: 'wren',
      INK_ACCESS_TOKEN: 'test-token',
      INK_SESSION_ID: SESSION_ID,
      INK_POLL_INTERVAL_MS: '200',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child = proc;
  let stdout = '';
  proc.stdout!.on('data', (chunk) => (stdout += chunk));

  proc.stdin!.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'host-mode-test', version: '0' },
      },
    }) + '\n'
  );
  proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  await new Promise((r) => setTimeout(r, WINDOW_MS));

  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  proc.stdin!.end();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  // The detach post is fire-and-forget before exit; let it land.
  await new Promise((r) => setTimeout(r, 200));
  return { stdout };
}

const tools = () => recorded.filter((r) => r.path === '/mcp').map((r) => r.tool);
const lifecycle = () => recorded.filter((r) => r.path === '/api/hooks/lifecycle');

describe('channel plugin host mode', () => {
  it('control: an interactive host gets the push, and the plugin acks, stamps and detaches', async () => {
    const { stdout } = await runPlugin({});

    expect(tools()).toContain('get_inbox');
    expect(stdout).toContain('notifications/claude/channel');
    expect(stdout).toContain(MESSAGE_ID);
    const acks = recorded.filter((r) => r.tool === 'mark_thread_read');
    expect(acks.length).toBeGreaterThan(0);
    expect(acks[0].args).toMatchObject({ threadKey: THREAD_KEY, throughMessageId: MESSAGE_ID });
    expect(lifecycle().some((r) => typeof r.body.cliPollAt === 'string')).toBe(true);
    expect(lifecycle().some((r) => r.body.cliAttached === false)).toBe(true);
  }, 20_000);

  it('print mode: no fetch, no push, no ack, no cli_poll_at stamp, no detach', async () => {
    const { stdout } = await runPlugin({ ...PRINT_MODE_CHANNEL_ENV });

    expect(recorded).toEqual([]);
    expect(stdout).not.toContain('notifications/claude/channel');
    // The handshake still completes: the host must not see a dead server.
    expect(stdout).toContain('"id":1');
    expect(stdout).toContain('InkMail push is off');
  }, 20_000);
});
