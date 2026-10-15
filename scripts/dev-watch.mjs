#!/usr/bin/env node
/**
 * The dev API server's watcher: runs one entry under tsx's loader, restarts it
 * when a watched file changes, and restarts it after any exit it didn't ask
 * for. It replaces `tsx watch` for `server:dev` (task ff78e1dd).
 *
 * Why not `tsx watch`. On 2026-10-15 the server segfaulted inside V8's garbage
 * collector, and :3001 stayed down for 90 minutes. tsx watch (4.23.13, and
 * 4.23.15, the latest) decides its child is still running from
 * `child.exitCode === null`. A child killed by a signal keeps `exitCode` null
 * (only `signalCode` is set), and an `exit` listener added after it died never
 * fires. So after the crash every rerun and every Ctrl-C waited for an exit
 * that had already happened. tsx also never restarts a child that dies on its
 * own: it waits for a file change.
 *
 * What this does instead:
 *   - Each run's exit is captured once, when it is spawned, so a run that has
 *     already died is never waited on.
 *   - An exit it didn't ask for (a signal, or any exit code) restarts the
 *     server after a backoff: 1s, doubling to 30s, back to 1s once a run
 *     lasted a minute. A crash loop retries slowly and never spins.
 *   - A change under a watched folder restarts it at once and resets the
 *     backoff. Bursts are coalesced (a shared rebuild writes dozens of files).
 *   - SIGINT, SIGTERM and SIGHUP are passed to the server, which shuts down on
 *     its own; after the stop timeout it is killed. A second signal kills it
 *     at once. Then this process exits 128 + the signal number.
 *
 * Usage:
 *   node scripts/dev-watch.mjs [--watch <dir>]... <entry> [args...]
 *
 * Ignored inside a watched folder: dot-segments, node_modules, and test files
 * (`*.test.*`, `*.spec.*`), which the server never imports.
 *
 * DEV_WATCH_STOP_TIMEOUT_MS (default 5000, as tsx) and
 * DEV_WATCH_RESTART_DELAY_MS (default 1000, the first backoff step) exist for
 * the tests.
 */
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { constants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STOP_TIMEOUT_MS = positiveInt(process.env.DEV_WATCH_STOP_TIMEOUT_MS, 5_000);
const RESTART_DELAY_MS = positiveInt(process.env.DEV_WATCH_RESTART_DELAY_MS, 1_000);
const MAX_RESTART_DELAY_MS = 30_000;
const HEALTHY_RUN_MS = 60_000;
const CHANGE_DEBOUNCE_MS = 200;

function positiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function log(message) {
  console.log(`[dev-watch] ${new Date().toLocaleTimeString()} ${message}`);
}

function parseArgs(argv) {
  const watchDirs = [];
  let index = 0;
  while (argv[index] === '--watch') {
    if (argv[index + 1] === undefined) throw new Error('--watch needs a folder');
    watchDirs.push(argv[index + 1]);
    index += 2;
  }
  const [entry, ...entryArgs] = argv.slice(index);
  if (!entry || entry.startsWith('--')) {
    throw new Error('usage: dev-watch.mjs [--watch <dir>]... <entry> [args...]');
  }
  return { watchDirs, entry, entryArgs };
}

/** Whether a path inside a watched folder is one the server never loads. */
export function isIgnoredPath(relativePath) {
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => segment.startsWith('.') || segment === 'node_modules')) {
    return true;
  }
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(segments[segments.length - 1] ?? '');
}

/** The wait before restart number `failures` (1-based) in a row. */
export function restartDelay(failures, baseMs = RESTART_DELAY_MS) {
  return Math.min(MAX_RESTART_DELAY_MS, baseMs * 2 ** Math.max(0, failures - 1));
}

function describeExit({ code, signal, error }) {
  if (error) return `failed to start (${error.message})`;
  return signal ? `died by ${signal}` : `exited with code ${code}`;
}

function main() {
  const { watchDirs, entry, entryArgs } = parseArgs(process.argv.slice(2));
  const tsxLoader = import.meta.resolve('tsx');

  /** The current run: its process, its exit (captured at spawn), and whether we stopped it. */
  let current = null;
  let failures = 0;
  let restartTimer = null;
  let exiting = false;
  let restartQueued = false;
  let restartChain = Promise.resolve();

  function startServer() {
    const proc = spawn(process.execPath, ['--import', tsxLoader, entry, ...entryArgs], {
      stdio: 'inherit',
    });
    const run = { proc, startedAt: Date.now(), stopping: false };
    run.exited = new Promise((resolve) => {
      proc.once('exit', (code, signal) => resolve({ code, signal }));
      proc.once('error', (error) => resolve({ code: null, signal: null, error }));
    });
    current = run;
    run.exited.then((result) => {
      if (current === run) current = null;
      if (run.stopping || exiting) return;
      failures = Date.now() - run.startedAt >= HEALTHY_RUN_MS ? 1 : failures + 1;
      const delay = restartDelay(failures);
      log(`server ${describeExit(result)}; restarting in ${delay / 1000}s`);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!exiting && current === null) startServer();
      }, delay);
    });
  }

  /** Stop the current run with `signal`, killing it if it outlives the timeout. */
  async function stopServer(signal) {
    const run = current;
    if (run === null) return;
    run.stopping = true;
    run.proc.kill(signal);
    const killTimer = setTimeout(() => {
      log(`server did not exit within ${STOP_TIMEOUT_MS / 1000}s; killing it`);
      run.proc.kill('SIGKILL');
    }, STOP_TIMEOUT_MS);
    await run.exited;
    clearTimeout(killTimer);
  }

  function requestRestart(reason) {
    if (exiting || restartQueued) return;
    restartQueued = true;
    restartChain = restartChain.then(async () => {
      restartQueued = false;
      if (exiting) return;
      if (restartTimer !== null) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      failures = 0;
      log(`${reason}; restarting`);
      await stopServer('SIGTERM');
      if (!exiting) startServer();
    });
  }

  let changeTimer = null;
  let firstChange = null;
  const watchers = [];
  for (const dir of watchDirs) {
    try {
      const watcher = watch(path.resolve(dir), { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const relative = filename.toString();
        if (isIgnoredPath(relative)) return;
        firstChange ??= path.join(dir, relative);
        if (changeTimer !== null) clearTimeout(changeTimer);
        changeTimer = setTimeout(() => {
          const changed = firstChange;
          changeTimer = null;
          firstChange = null;
          requestRestart(`change in ${changed}`);
        }, CHANGE_DEBOUNCE_MS);
      });
      watcher.on('error', (error) => log(`stopped watching ${dir}: ${error.message}`));
      watchers.push(watcher);
    } catch (error) {
      log(`not watching ${dir}: ${error.message}`);
    }
  }

  async function shutdown(signal) {
    const exitCode = 128 + constants.signals[signal];
    if (exiting) {
      current?.proc.kill('SIGKILL');
      process.exit(exitCode);
    }
    exiting = true;
    if (restartTimer !== null) clearTimeout(restartTimer);
    if (changeTimer !== null) clearTimeout(changeTimer);
    for (const watcher of watchers) watcher.close();
    await stopServer(signal);
    process.exit(exitCode);
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => void shutdown(signal));
  }

  startServer();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`[dev-watch] ${error.message}`);
    process.exit(2);
  }
}
