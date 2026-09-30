// Codex live-input experiment. ONLY a synthetic loopback provider, fresh HOME,
// no credentials, no real tools. Uses Node 22, Python stdlib, and existing ws
// dependency for Unix mode. Opt-in; this launches the installed Codex binary.
// Run from repo root: node scripts/probe-codex-live-input.mjs [--unix|--default-socket]
// All generated evidence stays in the private temporary directory, outside git.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const base = path.dirname(fileURLToPath(import.meta.url));
const defaultSocket = process.argv.includes('--default-socket');
const unix = process.argv.includes('--unix') || defaultSocket;
// Darwin's default tmpdir is too long for the default Unix control socket.
const root = fs.mkdtempSync(path.join('/tmp', 'ink-codex-live-'));
const home = path.join(root, 'home'),
  ch = path.join(home, '.codex'),
  work = path.join(root, 'work');
for (const p of [home, ch, work]) fs.mkdirSync(p, { recursive: true });
const env = {
  PATH: process.env.PATH,
  HOME: home,
  CODEX_HOME: ch,
  TMPDIR: root,
  TERM: 'xterm-256color',
  LANG: 'en_US.UTF-8',
};
const records = [],
  requests = [],
  clients = [],
  children = [];
let owner,
  tui,
  tuiText = '',
  held = null,
  holdNext = false;
const report = (check, data = {}) => {
  const row = { check, ...data };
  records.push(row);
  console.log(JSON.stringify(row));
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
function child(args, extra = {}) {
  const p = spawn('codex', args, { env, cwd: work, stdio: ['pipe', 'pipe', 'pipe'], ...extra });
  children.push(p);
  return p;
}
function respond(res, n) {
  const id = `resp_fixture_${n}`,
    item = {
      id: `msg_fixture_${n}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: `FIXTURE_RESPONSE_${n}`, annotations: [] }],
    };
  let seq = 0;
  const event = (type, extra) =>
    res.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: ++seq, ...extra })}\n\n`
    );
  event('response.created', {
    response: { id, object: 'response', status: 'in_progress', output: [] },
  });
  event('response.output_item.added', {
    output_index: 0,
    item: { ...item, status: 'in_progress', content: [] },
  });
  event('response.content_part.added', {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });
  event('response.output_text.delta', {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: item.content[0].text,
  });
  event('response.output_text.done', {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    text: item.content[0].text,
  });
  event('response.content_part.done', {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part: item.content[0],
  });
  event('response.output_item.done', { output_index: 0, item });
  event('response.completed', {
    response: {
      id,
      object: 'response',
      status: 'completed',
      output: [item],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  });
  res.end();
}
const provider = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!req.url.endsWith('/responses')) {
    res.writeHead(404);
    res.end();
    return;
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  report('synthetic_provider_input', {
    n: requests.length,
    markers: [...new Set(JSON.stringify(body.input).match(/SYNTHETIC_[A-Z_]+/g) || [])],
  });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
  res.flushHeaders();
  if (holdNext) {
    holdNext = false;
    held = () => respond(res, requests.indexOf(body) + 1);
  } else respond(res, requests.length);
});

class Rpc {
  pending = new Map();
  events = [];
  id = 0;
  async connect(url) {
    const receive = (text) => {
      const value = JSON.parse(text);
      if (value.id != null && this.pending.has(value.id)) {
        this.pending.get(value.id)(value);
        this.pending.delete(value.id);
      } else this.events.push(value);
    };
    if (url.startsWith('unix://')) {
      // --listen unix:// is WebSocket-over-UDS, NOT the raw stdio proxy stream.
      // Resolve the repo's existing ws dependency; never install globally.
      const WS = createRequire(path.join(process.cwd(), 'package.json'))('ws');
      this.ws = new WS(`ws+unix://${url.slice('unix://'.length)}:/`);
      await new Promise((resolve, reject) => {
        this.ws.once('open', resolve);
        this.ws.once('error', reject);
      });
      this.ws.on('message', (data) => receive(data.toString()));
    } else {
      this.ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        this.ws.addEventListener('open', resolve, { once: true });
        this.ws.addEventListener('error', reject, { once: true });
      });
      this.ws.addEventListener('message', (e) => receive(e.data));
    }
    clients.push(this);
    await this.ok('initialize', {
      clientInfo: { name: 'lumen_synthetic_probe', version: '1' },
      capabilities: { experimentalApi: true },
    });
    this.ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    return this;
  }
  async call(method, params) {
    const id = ++this.id;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`RPC timeout ${method}`));
        }, 10000);
        this.pending.set(id, resolve);
        this.ws.send(JSON.stringify({ id, method, params }));
      });
    } finally {
      clearTimeout(timer);
    }
  }
  async ok(method, params) {
    const r = await this.call(method, params);
    if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
    return r.result;
  }
}

async function queue(endpoint, threadId, marker) {
  const p = child([
    'queue',
    ...(defaultSocket ? [] : ['--remote', endpoint]),
    '--thread',
    threadId,
    '--message',
    marker,
  ]);
  let out = '',
    err = '';
  p.stdout.on('data', (c) => (out += c));
  p.stderr.on('data', (c) => (err += c));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      p.kill('SIGTERM');
      reject(new Error('Queue CLI timeout'));
    }, 12000);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('exit', (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  report('queue_cli', {
    marker,
    code,
    stdout: out.trim().slice(0, 1000),
    stderr: err.trim().slice(0, 1000),
  });
  if (code !== 0) throw new Error('Queue CLI failed');
}

try {
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  fs.writeFileSync(
    path.join(ch, 'config.toml'),
    `model_provider="fixture"\nmodel="fixture-model"\napproval_policy="never"\nsandbox_mode="read-only"\ncheck_for_update_on_startup=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[model_providers.fixture]\nname="Synthetic local provider"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`
  );
  // Trust only our empty fixture directory, in our throwaway user config.
  fs.appendFileSync(
    path.join(ch, 'config.toml'),
    `\n[projects.${JSON.stringify(fs.realpathSync(work))}]\ntrust_level="trusted"\n`
  );
  const reserve = net.createServer();
  await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const socketPath = defaultSocket
    ? path.join(ch, 'app-server-control', 'app-server-control.sock')
    : path.join(root, 'control.sock');
  const endpoint = unix ? `unix://${socketPath}` : `ws://127.0.0.1:${port}`;
  const err = fs.openSync(path.join(root, 'owner.stderr'), 'w');
  owner = child(['app-server', '--listen', endpoint], { stdio: ['ignore', err, err] });
  fs.closeSync(err);
  let connected = false;
  for (let i = 0; i < 150; i++) {
    connected = unix
      ? fs.existsSync(socketPath)
      : await new Promise((r) => {
          const s = net.connect(port, '127.0.0.1');
          s.once('connect', () => {
            s.destroy();
            r(true);
          });
          s.once('error', () => r(false));
        });
    if (connected) break;
    if (owner.exitCode !== null) throw new Error('Owner exited');
    await delay(50);
  }
  if (!connected) throw new Error('Owner not listening');
  report('isolation', {
    root,
    version: execFileSync('codex', ['--version'], { env, cwd: work, encoding: 'utf8' }).trim(),
    ownerPid: owner.pid,
  });
  const a = await new Rpc().connect(endpoint),
    b = await new Rpc().connect(endpoint);
  const started = await a.ok('thread/start', {
    cwd: work,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    baseInstructions: 'Synthetic test. No tools.',
    developerInstructions: 'No tools. Only synthetic text.',
  });
  const tid = started.thread.id;
  await a.ok('turn/start', { threadId: tid, input: [{ type: 'text', text: 'SYNTHETIC_SEED' }] });
  await until(() => a.events.some((e) => e.method === 'turn/completed'), 'seed turn completion');
  report('second_client_same_owner', {
    sameThread: (await b.ok('thread/resume', { threadId: tid })).thread.id === tid,
  });
  // Protocol queue alone, without any UI. Observe whether it starts itself.
  await b.ok('thread/queue/add', {
    threadId: tid,
    clientUserMessageId: 'fixture-idle',
    input: [{ type: 'text', text: 'SYNTHETIC_IDLE' }],
  });
  await delay(1500);
  report('queue_without_ui', {
    providerRequests: requests.length,
    queued: (await a.ok('thread/queue/list', { threadId: tid })).data.length,
  });
  // Native Codex TUI connects to the same owner, not a second execution owner.
  tui = spawn(
    'python3',
    [
      '-u',
      path.join(base, 'fixtures/codex-live-input-pty.py'),
      'codex',
      ...(defaultSocket ? [] : ['--remote', endpoint]),
      '--no-alt-screen',
      'resume',
      tid,
    ],
    { env, cwd: work, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  children.push(tui);
  let buffer = '';
  tui.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const x = JSON.parse(line);
      if (x.pid) report('tui_child', x);
      if (x.output) tuiText += x.output;
    }
  });
  await delay(4000);
  fs.writeFileSync(path.join(root, 'tui.txt'), tuiText);
  report('tui_attached_snapshot', {
    alive: tui.exitCode === null,
    providerRequests: requests.length,
    textTail: tuiText.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').slice(-1800),
  });
  if (requests.length === 1) {
    // Protocol queue/start is separate from queue acceptance; explicitly exercise it.
    report('explicit_queue_start', await b.call('thread/queue/start', { threadId: tid }));
  }
  await until(
    () => a.events.filter((e) => e.method === 'turn/completed').length >= 2,
    'idle turn completion'
  );
  const completedBefore = a.events.filter((e) => e.method === 'turn/completed').length;
  holdNext = true;
  const busy = await a.ok('turn/start', {
    threadId: tid,
    input: [{ type: 'text', text: 'SYNTHETIC_BUSY' }],
  });
  await until(() => held !== null, 'held provider request');
  await queue(endpoint, tid, 'SYNTHETIC_QUEUED_BUSY');
  assert.equal((await a.ok('thread/queue/list', { threadId: tid })).data.length, 1);
  const duplicateParams = {
    threadId: tid,
    clientUserMessageId: 'fixture-duplicate',
    input: [{ type: 'text', text: 'SYNTHETIC_DUPLICATE' }],
  };
  await b.ok('thread/queue/add', duplicateParams);
  await b.ok('thread/queue/add', duplicateParams);
  const duplicateRows = (await b.ok('thread/queue/list', { threadId: tid })).data.filter(
    (row) => row.clientUserMessageId === 'fixture-duplicate'
  );
  report('repeated_client_message_id', { queuedEntries: duplicateRows.length });
  // Remove only these unconsumed synthetic queue entries before releasing work.
  for (const row of duplicateRows)
    await b.ok('thread/queue/delete', { threadId: tid, queuedSubmissionId: row.id });
  const wrong = await b.call('turn/steer', {
    threadId: tid,
    expectedTurnId: 'wrong-turn',
    input: [{ type: 'text', text: 'SYNTHETIC_WRONG' }],
  });
  report('wrong_turn_rejected', { rejected: Boolean(wrong.error) });
  assert.ok(wrong.error);
  const steer = await b.call('turn/steer', {
    threadId: tid,
    expectedTurnId: busy.turn.id,
    input: [{ type: 'text', text: 'SYNTHETIC_STEER' }],
  });
  report('steer_accepted', { accepted: steer.result?.turnId === busy.turn.id });
  assert.equal(steer.result?.turnId, busy.turn.id);
  held();
  held = null;
  await until(
    () => a.events.filter((e) => e.method === 'turn/completed').length >= completedBefore + 1,
    'busy completion'
  );
  await delay(2500);
  report('after_busy', {
    requestCount: requests.length,
    queued: (await a.ok('thread/queue/list', { threadId: tid })).data.length,
    statuses: a.events
      .filter((e) => e.method === 'turn/completed')
      .map((e) => e.params.turn.status),
    tuiAlive: tui.exitCode === null,
  });
  await queue(endpoint, tid, 'SYNTHETIC_QUEUED_IDLE');
  await delay(2500);
  report('after_idle_cli_queue', {
    requestCount: requests.length,
    queued: (await a.ok('thread/queue/list', { threadId: tid })).data.length,
  });
  const markers = ['SYNTHETIC_STEER', 'SYNTHETIC_QUEUED_BUSY', 'SYNTHETIC_QUEUED_IDLE'];
  for (const marker of markers) {
    assert.ok(
      requests.some((r) => JSON.stringify(r.input).includes(marker)),
      `${marker} absent from provider input`
    );
    assert.ok(tuiText.includes(marker), `${marker} absent from native TUI`);
    assert.ok(
      a.events.some(
        (e) =>
          e.method === 'item/completed' &&
          e.params.threadId === tid &&
          e.params.item.type === 'userMessage' &&
          JSON.stringify(e.params.item).includes(marker)
      ),
      `${marker} missing exact-thread user item receipt`
    );
  }
  assert.equal(tui.exitCode, null);
  assert.equal((await a.ok('thread/queue/list', { threadId: tid })).data.length, 0);
  assert.ok(
    a.events
      .filter((e) => e.method === 'turn/completed')
      .every((e) => e.params.turn.status === 'completed')
  );
  report('assertions_passed', {
    transport: defaultSocket
      ? 'default local socket'
      : unix
        ? 'websocket over unix'
        : 'loopback websocket',
    providerInput: true,
    nativeTui: true,
    exactThreadItems: true,
    busyQueueWaited: true,
  });
  fs.writeFileSync(path.join(root, 'events.json'), JSON.stringify(a.events, null, 2));
} catch (e) {
  report('error', { message: e.message });
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(root, 'tui.txt'), tuiText);
  if (tui && tui.exitCode === null) {
    tui.stdin.write('{"stop":true}\n');
    await delay(250);
  }
  for (const c of clients) c.ws.close();
  // Every process object here was spawned by this script; no pattern kills.
  for (const p of [...children].reverse())
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
  await delay(600);
  for (const p of children) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  await delay(100);
  provider.closeAllConnections();
  provider.close();
  fs.writeFileSync(path.join(root, 'requests.json'), JSON.stringify(requests, null, 2));
  report('cleanup', {
    ownedProcessesExited: children.every((p) => p.exitCode !== null || p.signalCode !== null),
  });
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(records, null, 2));
}
