/** Async host for the existing JSONL ledger; preserves CLI continuity and observer eids. */
import { appendFile, mkdir, readdir, open, lstat } from 'fs/promises';
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
      // Preserve the existing replay reducer's semantics, without allocating a whole
      // JSONL file and its split copy. Never silently truncate history/dedupe/eids.
      const maxBytes = 8 * 1024 * 1024;
      const maxLineBytes = 1024 * 1024;
      const events: Record<string, unknown>[] = [];
      const parseLine = (line: Buffer) => {
        if (line.length > maxLineBytes)
          throw new Error('Hosted ledger entry exceeds its replay byte bound');
        try {
          const event: unknown = JSON.parse(line.toString('utf8'));
          if (event && typeof event === 'object' && !Array.isArray(event)) {
            if (events.length >= 50_000)
              throw new RangeError('Hosted ledger exceeds its replay event bound');
            events.push(event as Record<string, unknown>);
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          // Existing reader tolerates torn lines; seed starts a new boundary.
        }
      };
      let file;
      try {
        file = await open(path, 'r');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      let pending = Buffer.alloc(0),
        total = 0;
      try {
        for await (const chunk of file.createReadStream({
          highWaterMark: 64 * 1024,
          autoClose: false,
        })) {
          input.signal?.throwIfAborted();
          total += chunk.length;
          if (total > maxBytes)
            throw new Error('Hosted ledger exceeds the replay byte bound; compact before resuming');
          const bytes = Buffer.concat([pending, chunk]);
          let start = 0,
            end: number;
          while ((end = bytes.indexOf(10, start)) !== -1) {
            parseLine(bytes.subarray(start, end));
            start = end + 1;
          }
          pending = Buffer.from(bytes.subarray(start));
          if (pending.length > maxLineBytes)
            throw new Error('Hosted ledger entry exceeds its replay byte bound');
        }
        if (pending.length) parseLine(pending);
      } finally {
        await file.close();
      }
      return events;
    },
  };
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
