import { spawn } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * A real process writing past what a pipe can hold, then exiting. The parent
 * leaves stdout unread until the child reports on stderr that it has written
 * everything, the way a slow consumer would, so most of the megabyte is
 * still queued inside the child when it exits.
 */
const LINES = 1000;
const LINE_BYTES = 1000;

const CHILD = `
  const { exitAfterFlush } = require(process.env.FLUSH_MODULE);
  const line = 'x'.repeat(${LINE_BYTES - 1}) + '\\n';
  for (let i = 0; i < ${LINES}; i++) process.stdout.write(line);
  process.stderr.write('written\\n');
  if (process.env.FLUSH_UNGUARDED) process.exit(0);
  else void exitAfterFlush(0);
`;

function runChild(unguarded: boolean): Promise<{ code: number | null; bytes: number }> {
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', CHILD], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      FLUSH_MODULE: path.join(__dirname, 'exit-after-flush.ts'),
      ...(unguarded ? { FLUSH_UNGUARDED: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bytes = 0;
  child.stdout?.pause();
  child.stdout?.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('written')) child.stdout?.resume();
  });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, bytes })));
}

describe('exitAfterFlush', () => {
  it('delivers everything written before it to a slow reader, then exits with the code', async () => {
    const { code, bytes } = await runChild(false);
    expect(code).toBe(0);
    expect(bytes).toBe(LINES * LINE_BYTES);
  }, 30_000);

  // Pipes to stdout are synchronous on Linux, so there the bare exit loses
  // nothing and the control has nothing to show.
  it.runIf(process.platform === 'darwin')(
    '(control) a bare process.exit after the same writes loses the tail',
    async () => {
      const { code, bytes } = await runChild(true);
      expect(code).toBe(0);
      expect(bytes).toBeLessThan(LINES * LINE_BYTES);
    },
    30_000
  );
});
