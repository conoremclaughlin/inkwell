/** All children run the harmless bounded fake owner, never a provider or
 * executor. The SIGKILL targets a direct node wrapper ChildProcess, not npx. */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import WebSocket from 'ws';
// Exercise the production built gateway + directly runnable guardian.
// Build CLI before running this suite (no global link change).
import { startCodexMailGateway } from '../../../dist/lib/codex-mail/gateway.js';

const fake = fileURLToPath(new URL('./fixtures/fake-owner.cjs', import.meta.url));
const guardian = fileURLToPath(
  new URL('../../../dist/lib/codex-mail/guardian.js', import.meta.url)
);
const dirs: string[] = [];
const children: ChildProcess[] = [];
const sockets: WebSocket[] = [];
const gateways: Awaited<ReturnType<typeof startCodexMailGateway>>[] = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('fixture timeout');
    await delay(20);
  }
}
function temp() {
  const d = mkdtempSync(join(tmpdir(), 'ink-guardian-'));
  dirs.push(d);
  return d;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const gateway of gateways.splice(0)) await gateway.stop();
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function setup() {
  const dir = temp();
  const bound: string[] = [],
    events: any[] = [];
  let unhealthy = false;
  const gateway = await startCodexMailGateway({
    binary: process.execPath,
    serverArgs: [fake],
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: dir },
    threadOverrides: { sandbox: 'read-only', runtimeWorkspaceRoots: [dir] },
    onBound: async (id) => {
      bound.push(id);
    },
    onEvent: (e) => events.push(e),
    onUnhealthy: () => {
      unhealthy = true;
    },
    onStderr: () => {},
  });
  gateways.push(gateway);
  const ws = new WebSocket(`ws+unix://${gateway.endpoint.slice(7)}:/`);
  sockets.push(ws);
  const received: any[] = [];
  ws.on('message', (data) => received.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let id = 0;
  const call = async (method: string, params: any = {}) => {
    const key = ++id;
    ws.send(JSON.stringify({ id: key, method, params }));
    await until(() => received.some((r) => r.id === key));
    return received.find((r) => r.id === key);
  };
  await call('initialize', { capabilities: {}, clientInfo: { name: 'fixture' } });
  return { gateway, ws, call, received, events, bound, dir, unhealthy: () => unhealthy };
}
describe('owned native Codex gateway', () => {
  it('keeps exact native ids and binds only persistent threads, not TUI title agents', async () => {
    const f = await setup();
    const response = await f.call('thread/start', {
      cwd: f.dir,
      runtimeWorkspaceRoots: ['/fixture-extra'],
    });
    expect(response.result.received).toMatchObject({
      sandbox: 'read-only',
      runtimeWorkspaceRoots: ['/fixture-extra', f.dir],
    });
    await f.call('thread/start', { ephemeral: true });
    expect(f.bound).toEqual(['fixture-thread']);
    const opaque = { unexpected: ['preserve', { nested: true }], flag: null };
    expect((await f.call('future/unknown-method', opaque)).result.received).toEqual(opaque);
    const result = await f.gateway.request('thread/queue/list', { threadId: 'fixture-thread' });
    expect(result.received).toEqual({ threadId: 'fixture-thread' });
    expect(f.received.some((m) => String(m.id).startsWith('ink:'))).toBe(false);
    expect(statSync(f.gateway.endpoint.slice(7)).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(f.gateway.endpoint.slice(7))).mode & 0o777).toBe(0o700);
  });
  it('passes approval request/response unchanged and never answers on the human behalf', async () => {
    const f = await setup();
    await f.gateway.request('fixture/approval', {});
    await until(() => f.received.some((m) => m.id === 77));
    expect(f.received.find((m) => m.id === 77).method).toBe(
      'item/commandExecution/requestApproval'
    );
    expect(f.events.some((m) => m.method === 'fixture/approvalResult')).toBe(false);
    // Same numeric id in the opposite direction must not collide.
    f.ws.send(JSON.stringify({ id: 77, method: 'future/unknown-method', params: { keep: true } }));
    f.ws.send(JSON.stringify({ id: 77, result: { decision: 'decline' } }));
    await until(() => f.events.some((m) => m.method === 'fixture/approvalResult'));
    expect(f.events.find((m) => m.method === 'fixture/approvalResult').params.decision).toBe(
      'decline'
    );
  });
  it('rejects a second frontend without replacing the first owner', async () => {
    const f = await setup();
    const other = new WebSocket(`ws+unix://${f.gateway.endpoint.slice(7)}:/`);
    sockets.push(other);
    const code = await new Promise<number>((resolve) => other.on('close', resolve));
    expect(code).toBe(1008);
    expect(f.gateway.isHealthy()).toBe(true);
    await f.call('thread/start', {});
    expect(f.bound).toEqual(['fixture-thread']);
  });
  it('owner death makes delivery unhealthy even while terminal connection remains open', async () => {
    const f = await setup();
    expect(f.gateway.isHealthy()).toBe(true);
    await expect(f.gateway.request('fixture/exit', {})).rejects.toThrow();
    await until(f.unhealthy);
    expect(f.gateway.isHealthy()).toBe(false);
    await expect(f.gateway.request('thread/queue/add', {})).rejects.toThrow();
  });
  it.each([true, false])(
    'abrupt direct-node wrapper death, guardian=%s (false is negative control)',
    async (useGuardian) => {
      const dir = temp(),
        pidPath = join(dir, 'owner.pid'),
        wrapperPath = join(dir, 'wrapper.cjs');
      const args = useGuardian ? [guardian, process.execPath, fake, pidPath] : [fake, pidPath];
      writeFileSync(
        wrapperPath,
        `const {spawn}=require('node:child_process');\nconst p=spawn(process.execPath,${JSON.stringify(args)},{detached:true,stdio:['pipe','ignore','ignore'],env:{PATH:process.env.PATH,HOME:${JSON.stringify(dir)}}});\nsetTimeout(()=>process.exit(0),15000);\n`
      );
      const wrapper = spawn(process.execPath, [wrapperPath], {
        env: { PATH: process.env.PATH, HOME: dir },
        stdio: 'ignore',
      });
      children.push(wrapper);
      await until(() => existsSync(pidPath));
      const ownerPid = Number(readFileSync(pidPath, 'utf8'));
      expect(alive(ownerPid)).toBe(true);
      wrapper.kill('SIGKILL'); // exact child handle created above
      await until(() => wrapper.signalCode === 'SIGKILL');
      if (useGuardian) await until(() => !alive(ownerPid), 5000);
      else {
        await delay(300);
        expect(alive(ownerPid)).toBe(true); // This assertion catches a missing guardian.
        // Fixture self-exits; no kill-by-pattern or unverified orphan PID.
        await until(() => !alive(ownerPid), 12000);
      }
    },
    20_000
  );
});
