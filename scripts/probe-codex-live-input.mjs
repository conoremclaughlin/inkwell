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
const permissionsProbe = process.argv.includes('--permissions-probe');
const wrapperMode = process.argv.includes('--wrapper');
const gatewayMode = process.argv.includes('--gateway');
const launchOverrides = process.argv.includes('--launch-overrides') || gatewayMode;
let gateway;
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
const inkCalls = [];
let mailboxUnread = true;
const fixtureSession = '00000000-0000-4000-8000-000000000001';
const fixtureStudio = '00000000-0000-4000-8000-000000000002';
const fixtureMessage = '00000000-0000-4000-8000-000000000003';
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
  if (wrapperMode && (req.url === '/mcp' || req.url === '/api/hooks/lifecycle')) {
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    inkCalls.push({
      path: req.url,
      body,
      sessionHeader: req.headers['x-ink-session-id'],
      studioHeader: req.headers['x-ink-studio-id'],
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/hooks/lifecycle') {
      res.end(
        JSON.stringify({
          success: true,
          studioLeaseHeld: true,
          turnEpoch: '00000000-0000-4000-8000-000000000004',
        })
      );
      return;
    }
    const name = body.params?.name;
    let result = { success: true };
    if (name === 'get_inbox')
      result = {
        success: true,
        messages: [],
        threadsWithUnread: mailboxUnread ? [{ threadKey: 'thread:fixture', unreadCount: 1 }] : [],
      };
    if (name === 'get_thread_messages')
      result = {
        success: true,
        messages: mailboxUnread
          ? [
              {
                id: fixtureMessage,
                senderSlug: 'fixture-peer',
                content: 'SYNTHETIC_WRAPPER_MAIL',
                createdAt: new Date().toISOString(),
                messageType: 'message',
              },
            ]
          : [],
      };
    if (name === 'mark_thread_read') mailboxUnread = false;
    if (name === 'get_session')
      result = {
        success: true,
        session: { id: fixtureSession, activeThreadKey: 'thread:fixture' },
      };
    if (name === 'list_sessions') result = { success: true, sessions: [] };
    if (name === 'bootstrap')
      result = { success: true, identityFiles: { self: 'Synthetic fixture identity.' } };
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
      })
    );
    return;
  }
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
  if (permissionsProbe) {
    for (const p of ['baseline', 'extra']) fs.mkdirSync(path.join(root, p));
    fs.appendFileSync(
      path.join(ch, 'config.toml'),
      `\n[sandbox_workspace_write]\nwritable_roots=[${JSON.stringify(path.join(root, 'baseline'))}]\nexclude_slash_tmp=true\nexclude_tmpdir_env_var=true\n`
    );
  }
  // Trust only our empty fixture directory, in our throwaway user config.
  fs.appendFileSync(
    path.join(ch, 'config.toml'),
    `\n[projects.${JSON.stringify(fs.realpathSync(work))}]\ntrust_level="trusted"\n`
  );
  if (launchOverrides) {
    const hookPath = path.join(root, 'record-hook.cjs');
    fs.writeFileSync(
      hookPath,
      `const fs=require('fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>fs.appendFileSync(${JSON.stringify(path.join(root, 'hooks.jsonl'))},JSON.stringify({event:process.argv[2],input,cwd:process.cwd()})+'\\n'));`
    );
    fs.appendFileSync(path.join(ch, 'config.toml'), '\n[features]\nhooks=true\n');
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
      fs.appendFileSync(
        path.join(ch, 'config.toml'),
        '\n[[hooks.' +
          event +
          ']]\n[[hooks.' +
          event +
          '.hooks]]\ntype="command"\ncommand=' +
          JSON.stringify(process.execPath + ' ' + hookPath + ' ' + event) +
          '\n'
      );
    }
  }
  const reserve = net.createServer();
  await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const socketPath = defaultSocket
    ? path.join(ch, 'app-server-control', 'app-server-control.sock')
    : path.join(root, 'control.sock');
  const endpoint = unix ? `unix://${socketPath}` : `ws://127.0.0.1:${port}`;
  const err = fs.openSync(path.join(root, 'owner.stderr'), 'w');
  const instructionsPath = path.join(root, 'instructions.txt');
  fs.writeFileSync(instructionsPath, 'SYNTHETIC_INSTRUCTIONS: Only synthetic text. No tools.');
  if (wrapperMode) {
    fs.closeSync(err);
    fs.mkdirSync(path.join(work, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(work, '.ink'), { recursive: true });
    fs.writeFileSync(
      path.join(work, '.ink', 'identity.json'),
      JSON.stringify({ sbSlug: 'fixture', studioId: fixtureStudio })
    );
    fs.writeFileSync(
      path.join(work, '.codex', 'config.toml'),
      `# ink-managed:hooks:start
[hooks]
session_start = "ink hooks on-session-start --backend codex"
session_end = "ink hooks on-stop --backend codex"
user_prompt = "ink hooks on-prompt --backend codex"
# ink-managed:hooks:end
`
    );
    fs.mkdirSync(path.join(home, '.ink'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.ink', 'config.json'),
      JSON.stringify({ email: 'fixture@example.com', sbMapping: { codex: 'fixture' } })
    );
    const inkUrl = `http://127.0.0.1:${provider.address().port}`;
    Object.assign(env, {
      INK_SERVER_URL: inkUrl,
      INK_ACCESS_TOKEN: 'synthetic-fixture-token',
      SB_SLUG: 'fixture',
      INK_SESSION_ID: fixtureSession,
      INK_STUDIO_ID: fixtureStudio,
      INK_RUNTIME_LINK_ID: 'fixture-generation',
      INK_CONTEXT: Buffer.from(
        JSON.stringify({
          sessionId: fixtureSession,
          studioId: fixtureStudio,
          sbSlug: 'fixture',
          cliAttached: true,
          runtime: 'codex',
        })
      ).toString('base64url'),
    });
    const driver = path.join(root, 'wrapper.mjs');
    const moduleUrl = new URL('../packages/cli/dist/lib/codex-mail/interactive.js', import.meta.url)
      .href;
    fs.writeFileSync(
      driver,
      `import {runCodexMailInteractive} from ${JSON.stringify(moduleUrl)};
import fs from 'node:fs';
const result=await runCodexMailInteractive({binary:'codex',args:['-c',${JSON.stringify('model_instructions_file=' + JSON.stringify(instructionsPath))},'--sandbox','read-only','--add-dir',${JSON.stringify(work)},'--no-alt-screen'],cwd:${JSON.stringify(work)},env:process.env,sbSlug:'fixture',sessionId:${JSON.stringify(fixtureSession)},studioId:${JSON.stringify(fixtureStudio)},onBound:async(id)=>fs.writeFileSync(${JSON.stringify(path.join(root, 'bound.txt'))},id),onStderr:(c)=>process.stderr.write(c)});
process.exitCode=result.code??1;`
    );
    tui = spawn(
      'python3',
      ['-u', path.join(base, 'fixtures/codex-live-input-pty.py'), process.execPath, driver],
      { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    children.push(tui);
    let buffer = '';
    tui.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const row = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (row.output) tuiText += row.output;
      }
    });
    await until(() => tuiText.includes('Hooks need review'), 'wrapper hook review', 20000);
    await delay(500);
    tui.stdin.write(JSON.stringify({ write: '\u001b[B\r' }) + '\n');
    await until(() => fs.existsSync(path.join(root, 'bound.txt')), 'wrapper exact binding', 30000);
    await until(() => !mailboxUnread, 'wrapper exact mailbox ACK', 45000);
    await until(
      () => requests.some((r) => JSON.stringify(r.input).includes('SYNTHETIC_WRAPPER_MAIL')),
      'wrapper provider context',
      15000
    );
    await until(
      () => inkCalls.some((c) => c.path === '/api/hooks/lifecycle' && c.body.cliPollAt),
      'wrapper freshness'
    );
    assert.ok(tuiText.includes('SYNTHETIC_WRAPPER_MAIL'));
    const reads = inkCalls.filter((c) =>
      ['get_inbox', 'get_thread_messages'].includes(c.body.params?.name)
    );
    assert.ok(
      reads.length > 0 && reads.every((c) => c.body.params.arguments.markRead === false),
      'hook consumed mailbox'
    );
    assert.ok(
      reads.every((c) => c.sessionHeader === fixtureSession && c.studioHeader === fixtureStudio),
      'scope missing'
    );
    assert.ok(
      inkCalls.some((c) => c.path === '/api/hooks/lifecycle' && c.body.event === 'prompt'),
      'missing real prompt hook'
    );
    await until(
      () => inkCalls.some((c) => c.path === '/api/hooks/lifecycle' && c.body.event === 'stop'),
      'real stop hook'
    );
    assert.ok(
      inkCalls.some((c) => c.body.cliAttached === true),
      'missing attachment'
    );
    report('wrapper_assertions_passed', {
      root,
      mailboxAck: true,
      scopedFetch: true,
      promptAndStop: true,
      freshness: true,
    });
    // Exit the actual native TUI normally, allowing the runner to stop its owner.
    tui.stdin.write(JSON.stringify({ write: '\u0004' }) + '\n');
    await until(() => tui.exitCode !== null, 'wrapper normal exit', 15000);
    fs.writeFileSync(path.join(root, 'ink-calls.json'), JSON.stringify(inkCalls, null, 2));
  } else if (gatewayMode) {
    const { startCodexMailGateway } =
      await import('../packages/cli/dist/lib/codex-mail/gateway.js');
    const { CodexMailDelivery, PendingCodexDelivery } =
      await import('../packages/cli/dist/lib/codex-mail/delivery.js');
    const events = [];
    let tid,
      delivery,
      unhealthy = false;
    gateway = await startCodexMailGateway({
      binary: 'codex',
      cwd: work,
      env,
      serverArgs: [
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        `model_instructions_file=${JSON.stringify(instructionsPath)}`,
      ],
      threadOverrides: {
        model: 'fixture-model',
        sandbox: permissionsProbe ? 'workspace-write' : 'read-only',
        approvalPolicy: 'never',
        runtimeWorkspaceRoots: permissionsProbe ? [work, path.join(root, 'extra')] : [work],
      },
      onBound: async (id) => {
        tid = id;
      },
      onEvent: (e) => {
        events.push(e);
        delivery?.observe(e);
      },
      onUnhealthy: () => {
        unhealthy = true;
      },
      onStderr: (c) => fs.appendFileSync(path.join(root, 'owner.stderr'), c),
    });
    fs.closeSync(err);
    tui = spawn(
      'python3',
      [
        '-u',
        path.join(base, 'fixtures/codex-live-input-pty.py'),
        'codex',
        '--remote',
        gateway.endpoint,
        '--no-alt-screen',
      ],
      { env, cwd: work, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    children.push(tui);
    let buffer = '';
    tui.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const row = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (row.output) tuiText += row.output;
        if (row.pid) report('tui_child', { pid: row.pid });
      }
    });
    await until(() => tuiText.includes('Hooks need review') || tid, 'native startup');
    if (!tid) {
      await delay(500);
      tui.stdin.write(JSON.stringify({ write: '\u001b[B\r' }) + '\n');
    }
    await until(() => tid, 'exact native thread binding', 20000);
    report('gateway_binding', { root, tid, healthy: gateway.isHealthy() });
    const config = await gateway.request('config/read', { cwd: work, includeLayers: false });
    assert.equal(config.config?.features?.hooks, true, 'effective hook feature missing');
    const hookMetadata = await gateway.request('hooks/list', { cwds: [work] });
    assert.ok(
      hookMetadata.data[0].hooks.every(
        (h) => h.enabled && ['trusted', 'managed'].includes(h.trustStatus)
      ),
      'hooks not trusted'
    );
    if (permissionsProbe) {
      const response = events.find((e) => e.result?.sandbox && e.result?.thread?.id === tid);
      assert.equal(response.result.sandbox.type, 'workspaceWrite');
      const roots = response.result.sandbox.writableRoots.map((p) => fs.realpathSync(p));
      assert.ok(
        roots.includes(fs.realpathSync(path.join(root, 'baseline'))),
        'lost configured roots'
      );
      assert.ok(roots.includes(fs.realpathSync(path.join(root, 'extra'))), 'lost additional root');
      report('permissions_preserved', { baseline: true, additionalRoot: true });
    }
    await delay(1500);
    tui.stdin.write(JSON.stringify({ write: 'SYNTHETIC_HUMAN' }) + '\n');
    await delay(500);
    tui.stdin.write(JSON.stringify({ write: '\r' }) + '\n');
    await until(
      () => requests.some((r) => JSON.stringify(r.input).includes('SYNTHETIC_HUMAN')),
      'native human turn'
    );
    await until(() => events.some((e) => e.method === 'turn/completed'), 'native turn completion');
    delivery = new CodexMailDelivery({
      directory: path.join(root, 'journal'),
      scope: 'fixture-session',
      threadId: tid,
      rpc: gateway,
    });
    const deliver = async (id, text) => {
      for (let n = 0; n < 10; n++) {
        try {
          await delivery.deliver(id, text, { sender: 'fixture', thread_key: 'thread:fixture' });
          return;
        } catch (error) {
          if (!(error instanceof PendingCodexDelivery) && !error.message.includes('uncertain'))
            throw error;
          await delay(300);
        }
      }
      throw new Error('No exact mail receipt');
    };
    await deliver('fixture-idle', 'SYNTHETIC_QUEUED_IDLE');
    await until(
      () => requests.some((r) => JSON.stringify(r.input).includes('SYNTHETIC_QUEUED_IDLE')),
      'idle mail input'
    );
    await delay(500);
    holdNext = true;
    await gateway.request('turn/start', {
      threadId: tid,
      input: [{ type: 'text', text: 'SYNTHETIC_BUSY' }],
    });
    await until(() => held, 'busy turn held');
    await assert.rejects(
      delivery.deliver('fixture-busy', 'SYNTHETIC_QUEUED_BUSY', {
        sender: 'fixture',
        thread_key: 'thread:fixture',
      }),
      PendingCodexDelivery
    );
    assert.equal((await gateway.request('thread/queue/list', { threadId: tid })).data.length, 1);
    held();
    held = null;
    await deliver('fixture-busy', 'SYNTHETIC_QUEUED_BUSY');
    await until(
      () => requests.some((r) => JSON.stringify(r.input).includes('SYNTHETIC_QUEUED_BUSY')),
      'busy mail input'
    );
    await delay(500);
    // Reconstruct delivery after the context receipt, before Inkwell ACK:
    // retry succeeds from the durable receipt without a second user item.
    delivery = new CodexMailDelivery({
      directory: path.join(root, 'journal'),
      scope: 'fixture-session',
      threadId: tid,
      rpc: gateway,
    });
    await deliver('fixture-idle', 'SYNTHETIC_QUEUED_IDLE');
    const hookRows = fs
      .readFileSync(path.join(root, 'hooks.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    for (const marker of ['SYNTHETIC_HUMAN', 'SYNTHETIC_QUEUED_IDLE', 'SYNTHETIC_QUEUED_BUSY']) {
      assert.ok(tuiText.includes(marker), marker + ' missing in native TUI');
      assert.ok(
        hookRows.some((r) => r.event === 'UserPromptSubmit' && r.input.includes(marker)),
        marker + ' missing prompt hook'
      );
    }
    assert.ok(
      hookRows.some((r) => r.event === 'SessionStart'),
      'missing SessionStart'
    );
    assert.ok(hookRows.filter((r) => r.event === 'Stop').length >= 4, 'missing Stop');
    assert.equal(
      events.filter(
        (e) =>
          e.method === 'item/completed' &&
          e.params?.threadId === tid &&
          e.params?.item?.type === 'userMessage' &&
          JSON.stringify(e.params.item).includes('SYNTHETIC_QUEUED_IDLE')
      ).length,
      1
    );
    assert.ok(
      requests
        .filter((r) => JSON.stringify(r.input).includes('SYNTHETIC_HUMAN'))
        .every((r) => r.instructions?.includes('SYNTHETIC_INSTRUCTIONS'))
    );
    assert.equal(unhealthy, false);
    fs.writeFileSync(path.join(root, 'events.json'), JSON.stringify(events, null, 2));
    report('gateway_assertions_passed', {
      root,
      nativeTui: true,
      exactBinding: true,
      journalRetry: true,
      hookEvents: hookRows.map((r) => r.event),
    });
  } else {
    owner = child(
      [
        'app-server',
        '--listen',
        endpoint,
        ...(launchOverrides
          ? [
              '-c',
              `model_instructions_file=${JSON.stringify(instructionsPath)}`,
              '--disable',
              'web_search_request',
            ]
          : []),
      ],
      { stdio: ['ignore', err, err] }
    );
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
      ...(launchOverrides ? {} : { baseInstructions: 'Synthetic test. No tools.' }),
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
    if (wrapperMode)
      fs.writeFileSync(path.join(root, 'ink-calls.json'), JSON.stringify(inkCalls, null, 2));
    if (launchOverrides) {
      // Trust only the synthetic hooks we just wrote inside the fixture HOME.
      if (tuiText.includes('Hooks need review')) {
        tui.stdin.write(JSON.stringify({ write: '\u001b[B\r' }) + '\n');
        await delay(1500);
      }
      tui.stdin.write(JSON.stringify({ write: 'SYNTHETIC_HUMAN\r' }) + '\n');
      await delay(2500);
    }
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
    if (launchOverrides) {
      assert.ok(
        requests
          .filter((r) => JSON.stringify(r.input).includes('SYNTHETIC_SEED'))
          .every((r) => r.instructions?.includes('SYNTHETIC_INSTRUCTIONS')),
        'lost owner instructions'
      );
      report('hook_observations', {
        lines: fs.existsSync(path.join(root, 'hooks.jsonl'))
          ? fs.readFileSync(path.join(root, 'hooks.jsonl'), 'utf8')
          : 'none',
      });
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
  }
} catch (e) {
  report('error', { message: e.message });
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(root, 'tui.txt'), tuiText);
  if (wrapperMode)
    fs.writeFileSync(path.join(root, 'ink-calls.json'), JSON.stringify(inkCalls, null, 2));
  if (tui && tui.exitCode === null) {
    tui.stdin.write('{"stop":true}\n');
    await delay(250);
  }
  for (const c of clients) c.ws.close();
  await gateway?.stop();
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
