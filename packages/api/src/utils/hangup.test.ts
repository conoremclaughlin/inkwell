import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleHangup, HANGUP_REASON } from './hangup';

describe('handleHangup', () => {
  it('starts the shutdown with a reason that names the signal', () => {
    const shutdown = vi.fn();
    handleHangup(shutdown, [new EventEmitter(), new EventEmitter()]);
    expect(shutdown).toHaveBeenCalledWith(HANGUP_REASON);
    expect(HANGUP_REASON).toMatch(/^SIGHUP\b/);
  });

  it('takes the error a console stream raises once its terminal is gone', () => {
    const stdout = new EventEmitter();
    const eio = Object.assign(new Error('write EIO'), { code: 'EIO' });
    // Control: with nobody listening, an emitted error is thrown, which in the
    // server means an uncaught exception and winston exiting mid-shutdown.
    expect(() => stdout.emit('error', eio)).toThrow('write EIO');

    handleHangup(vi.fn(), [stdout]);
    expect(() => stdout.emit('error', eio)).not.toThrow();
  });
});

/**
 * The real thing, end to end: a separate process, a real SIGHUP, and a console
 * that is gone by the time the shutdown writes to it. The child exits 1 on any
 * uncaught exception, standing in for winston's exitOnError, and records how
 * far its shutdown got in a file, since its stdout is exactly what is broken.
 */
describe('handleHangup in a process whose console has gone', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const CHILD = `
    const { appendFileSync } = require('fs');
    const out = process.env.HANGUP_OUT;
    process.on('uncaughtException', (err) => {
      appendFileSync(out, 'uncaught ' + (err.code || err.message) + '\\n');
      process.exit(1);
    });
    const shutdown = (reason) => {
      process.stdout.write('Shutting down Inkwell Server...\\n');
      setTimeout(() => {
        appendFileSync(out, 'shutdown complete: ' + reason + '\\n');
        process.exit(0);
      }, 300);
    };
    const { handleHangup } = require(process.env.HANGUP_MODULE);
    process.on('SIGHUP', () =>
      process.env.HANGUP_UNGUARDED ? shutdown('unguarded') : handleHangup(shutdown)
    );
    appendFileSync(out, 'ready\\n');
    setInterval(() => {}, 1000);
  `;

  async function hangUp(unguarded: boolean): Promise<{ code: number | null; record: string }> {
    const dir = mkdtempSync(path.join(tmpdir(), 'ink-hangup-'));
    dirs.push(dir);
    const out = path.join(dir, 'record.txt');
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', CHILD], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        HANGUP_OUT: out,
        HANGUP_MODULE: path.join(__dirname, 'hangup.ts'),
        ...(unguarded ? { HANGUP_UNGUARDED: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code))
    );
    try {
      const deadline = Date.now() + 15_000;
      while (!(existsSync(out) && readFileSync(out, 'utf8').includes('ready'))) {
        if (Date.now() > deadline) throw new Error('child never became ready');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // The terminal closes: nothing reads the child's console any more.
      child.stdout?.destroy();
      child.kill('SIGHUP');
      const code = await exited;
      return { code, record: readFileSync(out, 'utf8') };
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }

  it('control: without the guard, the first console write kills the shutdown', async () => {
    const { code, record } = await hangUp(true);
    expect(record).toMatch(/uncaught EPIPE/);
    expect(record).not.toMatch(/shutdown complete/);
    expect(code).toBe(1);
  }, 20_000);

  it('with the guard, the shutdown runs to the end and says why it ran', async () => {
    const { code, record } = await hangUp(false);
    expect(record).not.toMatch(/uncaught/);
    expect(record).toContain(`shutdown complete: ${HANGUP_REASON}`);
    expect(code).toBe(0);
  }, 20_000);
});
