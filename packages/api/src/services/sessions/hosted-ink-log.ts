/** Async host for the existing JSONL ledger; preserves CLI continuity and observer eids. */
import { appendFile, mkdir, readdir, open, lstat } from 'fs/promises';
import { setImmediate as yieldToHost } from 'timers/promises';
import { join, basename, dirname, isAbsolute } from 'path';
import { SessionLog } from '@inklabs/shared/runtime';
import type { HostedSessionLog } from './hosted-ink-session';

export async function openHostedInkLog(input: {
  cwd: string;
  sessionId: string;
  signal?: AbortSignal;
  project(entry: Record<string, unknown>): void;
  register(path: string): void;
}): Promise<HostedSessionLog> {
  if (!isAbsolute(input.cwd) || !/^[a-z0-9-]+$/i.test(input.sessionId))
    throw new Error('Invalid hosted ledger identity or working directory');
  input.signal?.throwIfAborted();
  const dir = join(input.cwd, '.ink', 'runtime', 'repl');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const prefix = `${input.sessionId}-`;
  const candidates = await Promise.all(
    (await readdir(dir))
      .filter(
        (name) => name.startsWith(prefix) && name.endsWith('.jsonl') && !name.includes('.clone-')
      )
      .map(async (name) => {
        const path = join(dir, name);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) return undefined;
        return { path, time: info.mtimeMs };
      })
  );
  const path =
    candidates
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .sort((a, b) => b.time - a.time)[0]?.path ??
    join(dir, `${input.sessionId}-${Date.now()}.jsonl`);
  const log = new SessionLog({
    path,
    sink: { write: (line) => appendFile(path, line, { mode: 0o600 }) },
    onProjection: input.project,
  });
  input.signal?.throwIfAborted();
  input.register(path);
  return {
    path,
    seed: (n) => log.seed(n),
    append: (event) => log.append(event),
    flush: () => log.flush(),
    async read() {
      return entries();
    },
  };

  async function* entries(): AsyncGenerator<Record<string, unknown>> {
    // The append-only file grows across compactions. Stream EVERY event through
    // the shared reducer: retain active context/dedupe state, not a file-sized
    // JSON array, and never mistake total file size for active context size.
    const maxLineBytes = 1024 * 1024;
    const parseLine = (line: Buffer): Record<string, unknown> | undefined => {
      if (line.length > maxLineBytes)
        throw new Error(
          'Hosted ledger entry exceeds its 1 MiB bound; repair this entry before resuming'
        );
      try {
        const event: unknown = JSON.parse(line.toString('utf8'));
        if (event && typeof event === 'object' && !Array.isArray(event))
          return event as Record<string, unknown>;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // The existing CLI reader tolerates torn lines.
      }
      return undefined;
    };
    let file;
    try {
      file = await open(path, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let pending = Buffer.alloc(0);
    try {
      for await (const chunk of file.createReadStream({
        highWaterMark: 64 * 1024,
        autoClose: false,
      })) {
        input.signal?.throwIfAborted();
        const bytes = Buffer.concat([pending, chunk]);
        let start = 0,
          end: number;
        while ((end = bytes.indexOf(10, start)) !== -1) {
          input.signal?.throwIfAborted();
          const event = parseLine(bytes.subarray(start, end));
          if (event) yield event;
          start = end + 1;
        }
        pending = Buffer.from(bytes.subarray(start));
        if (pending.length > maxLineBytes)
          throw new Error(
            'Hosted ledger entry exceeds its 1 MiB bound; repair this entry before resuming'
          );
        await yieldToHost(); // IO may be cached; do not starve other sessions.
      }
      input.signal?.throwIfAborted();
      if (pending.length) {
        const event = parseLine(pending);
        if (event) yield event;
      }
    } finally {
      await file.close();
    }
  }
}

/** Clones are children of this log, never another session's or a live observer source. */
export function hostedCloneLog(parentPath: string, path: string): SessionLog {
  if (
    dirname(path) !== dirname(parentPath) ||
    !basename(path).startsWith(basename(parentPath, '.jsonl') + '.clone-') ||
    !path.endsWith('.jsonl')
  )
    throw new Error('Clone ledger must be under its parent ledger');
  return new SessionLog({
    path,
    sink: { write: (line) => appendFile(path, line, { mode: 0o600 }) },
  });
}
