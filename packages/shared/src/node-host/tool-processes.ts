/** Tool children, not agent loops: explicit env, bounded output and an owned drain. */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { isAbsolute } from 'path';

export function createToolProcesses(input: {
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}) {
  if (!isAbsolute(input.cwd)) throw new Error('Tool cwd must be absolute');
  for (const limit of [input.timeoutMs, input.maxOutputBytes])
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid tool process bound');
  const env = Object.freeze({ ...input.env });
  const children = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  let failure: Error | undefined;
  let closed = false;
  const stopChild = (child: ChildProcessWithoutNullStreams) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.pid && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGKILL');
        return;
      } catch {
        /* The child may already have exited. Only fall back to this owned handle. */
      }
    }
    child.kill('SIGKILL');
  };
  const stop = () => {
    for (const child of children.keys()) stopChild(child);
  };
  input.signal.addEventListener('abort', stop);
  return {
    spawn(file: string, args: readonly string[]) {
      input.signal.throwIfAborted();
      if (closed) throw new Error('Tool process scope is closed');
      if (!isAbsolute(file)) throw new Error('Tool executable must be resolved explicitly');
      const child = spawn(file, [...args], {
        cwd: input.cwd,
        env: { ...env },
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let bytes = 0;
      const fail = (error: Error) => {
        failure ??= error;
        stopChild(child);
      };
      const watch = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > input.maxOutputBytes) {
          // Stop readers accumulating more. close still follows destruction/exit.
          child.stdout.pause();
          child.stderr.pause();
          fail(new Error('Tool output exceeds its byte bound'));
          child.stdout.destroy();
          child.stderr.destroy();
        }
      };
      child.stdout.on('data', watch);
      child.stderr.on('data', watch);
      child.stdout.on('error', fail);
      child.stderr.on('error', fail);
      child.stdin.on('error', fail);
      child.on('error', fail);
      child.stdin.end();
      const timer = setTimeout(
        () => fail(new Error('Tool process deadline exceeded')),
        input.timeoutMs
      );
      let stdioGrace: ReturnType<typeof setTimeout> | undefined;
      const drained = new Promise<void>((resolve) => {
        child.once('exit', () => {
          // Drain ordinary buffered output first; inherited pipes cannot keep a tool alive.
          stdioGrace = setTimeout(() => {
            if (child.pid && process.platform !== 'win32') {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {
                /* Group already gone. */
              }
            }
            child.stdout.destroy();
            child.stderr.destroy();
          }, 250);
        });
        child.once('close', () => {
          clearTimeout(timer);
          if (stdioGrace) clearTimeout(stdioGrace);
          children.delete(child);
          resolve();
        });
      });
      children.set(child, drained);
      return child;
    },
    stop(error: Error) {
      failure ??= error;
      stop();
    },
    check() {
      input.signal.throwIfAborted();
      if (failure) throw failure;
    },
    async close() {
      closed = true;
      stop();
      await Promise.all(children.values());
      input.signal.removeEventListener('abort', stop);
    },
  };
}
