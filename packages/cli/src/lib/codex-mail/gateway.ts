import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

export type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { code: number; message: string };
};
export interface CodexMailRpc {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, any>>;
}

/** One native TUI, one execution owner. Proxying its stdio protocol gives an
 * exact thread binding from that TUI's start/resume response, not a rollout
 * scan or a guess from the daemon's list of threads. Approvals and all other
 * native protocol traffic are forwarded unchanged. */
export async function startCodexMailGateway(options: {
  binary: string;
  serverArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  threadOverrides: Record<string, unknown>;
  onBound(threadId: string): Promise<void>;
  onEvent(message: RpcMessage): void;
  onUnhealthy(): void;
  onStderr(chunk: Buffer): void;
}) {
  if (process.platform === 'win32') throw new Error('Codex Inkmail currently needs a Unix socket');
  const dir = mkdtempSync(join(tmpdir(), 'ink-mail-'));
  chmodSync(dir, 0o700);
  const socketPath = join(dir, 's');
  if (Buffer.byteLength(socketPath) >= 100) {
    rmSync(dir, { recursive: true });
    throw new Error('Temporary directory is too long for a private Codex socket');
  }
  const http = createServer();
  const wss = new WebSocketServer({ server: http, maxPayload: 32 * 1024 * 1024 });
  let native: WebSocket | undefined;
  let stopped = false;
  let healthy = true;
  let initialized = false;
  let serial = 0;
  const pending = new Map<
    string,
    {
      resolve(value: Record<string, any>): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  const nativeRequests = new Map<
    string,
    { id: string | number; method: string; bindsThread: boolean }
  >();
  const guardian = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./guardian.js', import.meta.url)),
      options.binary,
      ...options.serverArgs,
    ],
    { cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const closed = new Promise<void>((resolve) => guardian.once('close', () => resolve()));
  function fail() {
    if (!healthy) return;
    healthy = false;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Codex Inkmail connection lost; delivery is unconfirmed'));
    }
    pending.clear();
    if (!stopped) options.onUnhealthy();
  }
  guardian.on('error', fail);
  guardian.on('close', fail);
  guardian.stdin.on('error', fail);
  guardian.stderr.on('data', options.onStderr);
  const send = (message: RpcMessage) => {
    if (!healthy || stopped) throw new Error('Codex Inkmail owner is unavailable');
    guardian.stdin.write(JSON.stringify(message) + '\n');
  };
  const forward = (message: RpcMessage) => {
    if (native?.readyState === WebSocket.OPEN) native.send(JSON.stringify(message));
  };
  const lines = createInterface({ input: guardian.stdout });
  // Serial response handling prevents two native thread switches overtaking
  // their durable Inkwell binding update.
  let handling = Promise.resolve();
  lines.on('line', (line) => {
    handling = handling
      .then(async () => {
        const message: RpcMessage = JSON.parse(line);
        const key = String(message.id);
        const ours = pending.get(key);
        if (ours && !message.method) {
          pending.delete(key);
          clearTimeout(ours.timer);
          if (message.error)
            ours.reject(new Error(`Codex ${message.error.code}: ${message.error.message}`));
          else ours.resolve(message.result ?? {});
          return;
        }
        // Timed-out bridge responses must never leak into the native id space.
        if (!message.method && key.startsWith('ink:')) return;
        const request = nativeRequests.get(key);
        if (request && !message.method) {
          nativeRequests.delete(key);
          message.id = request.id;
          if (!message.error && request.method === 'initialize') initialized = true;
          if (!message.error && request.bindsThread && message.result?.thread?.ephemeral !== true) {
            const threadId = message.result?.thread?.id;
            if (typeof threadId !== 'string') throw new Error('Missing native thread identity');
            await options.onBound(threadId);
          }
        }
        options.onEvent(message);
        forward(message);
      })
      .catch(() => {
        fail();
        native?.close(1011, 'Inkmail bridge failed');
      });
  });
  wss.on('connection', (ws) => {
    if (native || stopped || !healthy) {
      ws.close(1008, 'One terminal per Inkmail owner');
      return;
    }
    native = ws;
    ws.on('error', fail);
    ws.on('close', fail);
    ws.on('message', (data) => {
      try {
        const message: RpcMessage = JSON.parse(data.toString());
        if (message.method && message.id !== undefined) {
          const key = `tui:${++serial}`;
          const bindsThread =
            ['thread/start', 'thread/resume'].includes(message.method) &&
            message.params?.ephemeral !== true;
          nativeRequests.set(key, { id: message.id, method: message.method, bindsThread });
          message.id = key;
          if (message.method === 'initialize') {
            message.params = {
              ...message.params,
              capabilities: {
                ...message.params?.capabilities,
                experimentalApi: true,
              },
            };
          }
          if (bindsThread) {
            const p = message.params ?? {};
            message.params = { ...p, ...options.threadOverrides };
            // Additional CLI roots augment native runtime roots, never remove
            // roots selected by the TUI. Config's writable_roots stay intact.
            if (Array.isArray(options.threadOverrides.runtimeWorkspaceRoots)) {
              message.params.runtimeWorkspaceRoots = [
                ...new Set([
                  ...(Array.isArray(p.runtimeWorkspaceRoots) ? p.runtimeWorkspaceRoots : []),
                  ...options.threadOverrides.runtimeWorkspaceRoots,
                ]),
              ];
            }
          }
        }
        send(message);
      } catch {
        fail();
        ws.close(1011, 'Inkmail bridge failed');
      }
    });
  });
  const stop = async () => {
    if (stopped) return closed;
    stopped = true;
    fail();
    native?.terminate();
    wss.close();
    http.close();
    // EOF also works on abrupt parent death: only this wrapper owns the
    // write end, and the guardian kills/reaps its own live child.
    guardian.stdin.end();
    await closed;
    lines.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(socketPath, resolve);
    });
    chmodSync(socketPath, 0o600);
    if (!healthy) throw new Error('Codex App Server failed to start');
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    endpoint: `unix://${socketPath}`,
    isHealthy: () => healthy && initialized && native?.readyState === WebSocket.OPEN,
    stop,
    request(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
      if (!initialized || !healthy || stopped)
        return Promise.reject(new Error('Codex is not attached'));
      return new Promise((resolve, reject) => {
        const id = `ink:${++serial}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Codex request timed out; do not assume it was rejected'));
        }, 10_000);
        pending.set(id, { resolve, reject, timer });
        try {
          send({ id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
  };
}
