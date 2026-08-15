#!/usr/bin/env node
/**
 * Antigravity MCP bridge — stdio in, Streamable HTTP out.
 *
 * Every other runner injects per-session MCP auth through a mechanism the CLI
 * gives it: Claude has `--mcp-config`, Codex has `-c mcp_servers.*.env_http_headers`,
 * Gemini has `GEMINI_CLI_SYSTEM_SETTINGS_PATH`. `agy` has none of those. It reads
 * MCP config from exactly one host-global file (`~/.gemini/config/mcp_config.json`),
 * with no flag override, no per-workspace file that actually loads, and — verified
 * empirically, not assumed — no `${VAR}` or `$VAR` interpolation. Both forms arrive
 * at the server as literal text.
 *
 * A host-global static file cannot carry a per-session bearer token or an
 * `x-ink-context` whose sessionId changes every turn. Concurrent SBs would
 * overwrite each other's credentials.
 *
 * What `agy` does do is spawn stdio MCP servers as child processes, and those
 * children inherit its environment. So the credential travels in env — which is
 * already per-spawn and already race-free — and this bridge turns it back into
 * the headers the Ink MCP server expects. The global config stays static
 * (`command` + `args` only), so writing it is idempotent and nothing races.
 *
 * Deliberately dependency-free and plain .mjs: it is spawned as a bare `node`
 * child by a closed-source Go binary, so it cannot rely on the API package's
 * module graph, its build output, or a TypeScript loader being present.
 */

import { createInterface } from 'node:readline';

const MCP_URL = process.env.INK_MCP_URL || 'http://localhost:3001/mcp';

/** Streamable HTTP hands out a session id on initialize; every later request must echo it. */
let mcpSessionId;

/**
 * agy probes a server with a non-standard `server/discover` before `initialize`.
 * The Ink MCP server would reject it, and a rejection here reads to agy as a
 * dead server, so answer it locally and forward everything else untouched.
 */
const LOCAL_METHODS = new Set(['server/discover']);

function outboundHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    // Streamable HTTP may answer either way; the server picks.
    Accept: 'application/json, text/event-stream',
  };
  if (process.env.INK_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${process.env.INK_ACCESS_TOKEN}`;
  }
  if (process.env.INK_CONTEXT) headers['x-ink-context'] = process.env.INK_CONTEXT;
  // Legacy individual headers — fallbacks for when the context token is absent.
  if (process.env.INK_SESSION_ID) headers['x-ink-session-id'] = process.env.INK_SESSION_ID;
  if (process.env.INK_STUDIO_ID) headers['x-ink-studio-id'] = process.env.INK_STUDIO_ID;
  if (process.env.AGENT_ID) headers['x-ink-agent-id'] = process.env.AGENT_ID;
  if (mcpSessionId) headers['mcp-session-id'] = mcpSessionId;
  return headers;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** An SSE body carries the JSON-RPC payload in `data:` lines; take the last complete one. */
function parseSse(text) {
  let last;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      last = JSON.parse(payload);
    } catch {
      // Partial or non-JSON data line — keep whatever last parsed cleanly.
    }
  }
  return last;
}

async function forward(message) {
  const isNotification = message.id === undefined || message.id === null;

  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: outboundHeaders(),
    body: JSON.stringify(message),
  });

  // Capture the session id the moment the server issues it.
  const issued = response.headers.get('mcp-session-id');
  if (issued) mcpSessionId = issued;

  // 202 with no body is the correct answer to a notification.
  if (isNotification) return undefined;

  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`empty response body (HTTP ${response.status})`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    const parsed = parseSse(text);
    if (!parsed) throw new Error(`no JSON-RPC payload in SSE body (HTTP ${response.status})`);
    return parsed;
  }

  return JSON.parse(text);
}

async function handle(message) {
  try {
    const result = await forward(message);
    if (result !== undefined) write(result);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[ink-bridge] ${message.method} failed: ${detail}\n`);
    // Only a request can carry an error back; a failed notification has no
    // envelope to answer on, and inventing an id would corrupt the stream.
    if (message.id !== undefined && message.id !== null) {
      write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: `Ink MCP bridge: ${detail}` },
      });
    }
  }
}

/**
 * Everything queues behind `initialize`, and only behind `initialize`.
 *
 * Streamable HTTP issues the session id on the initialize response, and every
 * later request has to carry it. stdin is a pipe, so a client can push the
 * whole handshake down it before we have answered anything — leaving later
 * requests to go out with no session id, which the server sees as an unrelated
 * caller. Gating on the handshake fixes that; gating on *every* request would
 * also fix it, but would serialise concurrent tool calls behind the slowest
 * one for no reason.
 */
let handshake = Promise.resolve();

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    // Unparseable input has no id to answer against; dropping it is the only
    // correct move, but say so on stderr rather than failing silently.
    process.stderr.write(`[ink-bridge] dropped non-JSON stdin line\n`);
    return;
  }

  if (LOCAL_METHODS.has(message.method)) {
    if (message.id !== undefined && message.id !== null) {
      write({ jsonrpc: '2.0', id: message.id, result: {} });
    }
    return;
  }

  // Assigned synchronously, before any await, so a request arriving on the
  // very next line already sees the gate it needs to wait on.
  const priorHandshake = handshake;
  const work = (async () => {
    await priorHandshake;
    await handle(message);
  })();

  if (message.method === 'initialize') {
    handshake = work;
  }
});

rl.on('close', () => process.exit(0));
