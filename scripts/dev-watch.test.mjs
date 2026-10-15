#!/usr/bin/env node
/**
 * Regression coverage for scripts/dev-watch.mjs, the dev API server's watcher
 * (task ff78e1dd).
 *
 * On 2026-10-15 the server died by a signal under `tsx watch`, which then
 * waited forever for an exit that had already happened: no restart, and no
 * way to stop it with Ctrl-C. These pin the properties that outage needed:
 *
 *   - a run that dies by a signal, or exits with a code, is restarted after
 *     the backoff, without any file change;
 *   - a signal sent during that backoff stops the watcher at once, and no
 *     new run starts;
 *   - a change in a watched folder restarts the run and the old run gets
 *     SIGTERM; a test file there does not;
 *   - a run that ignores SIGTERM is killed after the stop timeout;
 *   - SIGINT reaches the run, and the watcher exits 130.
 *
 * Each case runs the real watcher on a fixture entry in its own temporary
 * folder. The watcher is started as a process-group leader, so cleanup can
 * signal exactly the group it started and nothing else.
 *
 * Run: node --test scripts/dev-watch.test.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isIgnoredPath, restartDelay } from './dev-watch.mjs';

const WATCHER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dev-watch.mjs');
const started = [];

after(() => {
  for (const watcher of started) {
    if (watcher.exitCode === null && watcher.signalCode === null) {
      try {
        process.kill(-watcher.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
});

/**
 * A fixture entry. Each run appends `start <n>` to runs.log; then `behaviour`
 * decides what run number n does. It logs `term <n>` on SIGTERM and
 * `int <n>` on SIGINT before exiting 0, unless told to ignore SIGTERM.
 */
function fixture(behaviour) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-watch-'));
  mkdirSync(path.join(dir, 'src'));
  const entry = path.join(dir, 'server.mjs');
  writeFileSync(
    entry,
    `import { appendFileSync, readFileSync, existsSync } from 'node:fs';
const log = ${JSON.stringify(path.join(dir, 'runs.log'))};
const prior = existsSync(log) ? readFileSync(log, 'utf8').split('\\n').filter((l) => l.startsWith('start')).length : 0;
const run = prior + 1;
appendFileSync(log, 'start ' + run + '\\n');
const behaviour = ${JSON.stringify(behaviour)};
const mine = behaviour[run] ?? behaviour.default ?? 'stay';
if (mine !== 'ignore-term') {
  process.on('SIGTERM', () => { appendFileSync(log, 'term ' + run + '\\n'); process.exit(0); });
} else {
  process.on('SIGTERM', () => appendFileSync(log, 'ignored-term ' + run + '\\n'));
}
process.on('SIGINT', () => { appendFileSync(log, 'int ' + run + '\\n'); process.exit(0); });
if (mine === 'sigkill') process.kill(process.pid, 'SIGKILL');
if (mine === 'exit1') process.exit(1);
setInterval(() => {}, 1000);
`
  );
  return { dir, entry, log: path.join(dir, 'runs.log') };
}

function startWatcher(fx, env = {}) {
  const watcher = spawn(
    process.execPath,
    [WATCHER, '--watch', path.join(fx.dir, 'src'), fx.entry],
    {
      cwd: fx.dir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: fx.dir,
        DEV_WATCH_RESTART_DELAY_MS: '300',
        DEV_WATCH_STOP_TIMEOUT_MS: '1500',
        ...env,
      },
    }
  );
  started.push(watcher);
  watcher.output = '';
  watcher.stdout.on('data', (chunk) => (watcher.output += chunk));
  watcher.stderr.on('data', (chunk) => (watcher.output += chunk));
  watcher.exited = new Promise((resolve) =>
    watcher.once('exit', (code, signal) => resolve({ code, signal }))
  );
  return watcher;
}

const lines = (fx) => (existsSync(fx.log) ? readFileSync(fx.log, 'utf8').trim().split('\n') : []);

async function until(predicate, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function exitsWithin(watcher, ms) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
  return Promise.race([watcher.exited, timeout]);
}

describe('restart without a file change', () => {
  it('restarts a run that died by a signal, after the backoff', async (t) => {
    const fx = fixture({ 1: 'sigkill' });
    t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
    const watcher = startWatcher(fx);
    await until(() => lines(fx).includes('start 2'), 'the second run');
    assert.match(watcher.output, /server died by SIGKILL; restarting in 0\.3s/);
    watcher.kill('SIGTERM');
    assert.deepEqual(await exitsWithin(watcher, 4000), { code: 143, signal: null });
  });

  it('restarts a run that exited with a code, with a growing backoff', async (t) => {
    const fx = fixture({ default: 'exit1', 3: 'stay' });
    t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
    const watcher = startWatcher(fx);
    await until(() => lines(fx).includes('start 3'), 'the third run');
    assert.match(watcher.output, /exited with code 1; restarting in 0\.3s/);
    assert.match(watcher.output, /exited with code 1; restarting in 0\.6s/);
    watcher.kill('SIGTERM');
    await exitsWithin(watcher, 4000);
  });

  it('a signal during the backoff stops the watcher at once, and no run starts', async (t) => {
    const fx = fixture({ 1: 'sigkill' });
    t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
    const watcher = startWatcher(fx, { DEV_WATCH_RESTART_DELAY_MS: '3000' });
    await until(() => /restarting in 3s/.test(watcher.output), 'the crash to be seen');
    watcher.kill('SIGINT');
    assert.deepEqual(await exitsWithin(watcher, 1500), { code: 130, signal: null });
    await new Promise((resolve) => setTimeout(resolve, 3500));
    assert.deepEqual(lines(fx), ['start 1']);
  });
});

describe('file changes', () => {
  it('a change restarts the run, and the old run gets SIGTERM', async (t) => {
    const fx = fixture({});
    t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
    const watcher = startWatcher(fx);
    await until(() => lines(fx).includes('start 1'), 'the first run');
    await new Promise((resolve) => setTimeout(resolve, 300));
    writeFileSync(path.join(fx.dir, 'src', 'module.ts'), 'export const x = 1;\n');
    await until(() => lines(fx).includes('start 2'), 'the restart');
    assert.deepEqual(lines(fx).slice(0, 3), ['start 1', 'term 1', 'start 2']);
    assert.match(watcher.output, /change in .*module\.ts; restarting/);
    watcher.kill('SIGTERM');
    await exitsWithin(watcher, 4000);
  });

  it('a test file or a dot-folder in a watched folder does not restart the run', async (t) => {
    const fx = fixture({});
    t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
    const watcher = startWatcher(fx);
    await until(() => lines(fx).includes('start 1'), 'the first run');
    await new Promise((resolve) => setTimeout(resolve, 300));
    writeFileSync(path.join(fx.dir, 'src', 'module.test.ts'), 'it();\n');
    mkdirSync(path.join(fx.dir, 'src', '.cache'));
    writeFileSync(path.join(fx.dir, 'src', '.cache', 'x.json'), '{}\n');
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.deepEqual(lines(fx), ['start 1']);
    watcher.kill('SIGTERM');
    await exitsWithin(watcher, 4000);
  });

  it('a run that ignores SIGTERM is killed after the stop timeout, and the next run starts', async (t) => {
    const fx = fixture({ 1: 'ignore-term' });
    t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
    const watcher = startWatcher(fx);
    await until(() => lines(fx).includes('start 1'), 'the first run');
    await new Promise((resolve) => setTimeout(resolve, 300));
    writeFileSync(path.join(fx.dir, 'src', 'module.ts'), 'export const y = 2;\n');
    await until(() => lines(fx).includes('start 2'), 'the run after the kill');
    assert.deepEqual(lines(fx).slice(0, 3), ['start 1', 'ignored-term 1', 'start 2']);
    assert.match(watcher.output, /did not exit within 1\.5s; killing it/);
    watcher.kill('SIGTERM');
    await exitsWithin(watcher, 4000);
  });
});

describe('stopping', () => {
  it('SIGINT reaches the run, and the watcher exits 130 without restarting it', async (t) => {
    const fx = fixture({});
    t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
    const watcher = startWatcher(fx);
    await until(() => lines(fx).includes('start 1'), 'the first run');
    watcher.kill('SIGINT');
    assert.deepEqual(await exitsWithin(watcher, 3000), { code: 130, signal: null });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(lines(fx), ['start 1', 'int 1']);
  });
});

describe('the pure parts', () => {
  it('ignores dot-segments, node_modules and test files, and nothing else', () => {
    for (const ignored of [
      '.cache/x.json',
      'a/.git/HEAD',
      'node_modules/x/index.js',
      'mcp/server.test.ts',
      'x.spec.mjs',
    ]) {
      assert.equal(isIgnoredPath(ignored), true, ignored);
    }
    for (const watched of ['server.ts', 'mcp/tools/index.ts', 'cjs/index.d.ts', 'testing.ts']) {
      assert.equal(isIgnoredPath(watched), false, watched);
    }
  });

  it('backs off 1s, doubling to a 30s cap', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7].map((failures) => restartDelay(failures, 1000)),
      [1000, 2000, 4000, 8000, 16000, 30000, 30000]
    );
  });
});
