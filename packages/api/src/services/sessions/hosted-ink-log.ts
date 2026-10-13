/** Async host for the existing JSONL ledger; preserves CLI continuity and observer eids. */
import { appendFile, mkdir, open } from 'fs/promises';
import { setImmediate as yieldToHost } from 'timers/promises';
import { join, basename, dirname, isAbsolute } from 'path';
import { SessionLog } from '@inklabs/shared/runtime';
import { describeJournalSplit, resolveParentJournal } from '@inklabs/shared/node-host';
import { logger } from '../../utils/logger';
import type { HostedSessionLog } from './hosted-ink-session';

/** One warning per process for each split, not one per turn. */
const reportedSplits = new Set<string>();

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
  // The session's own journal by the same rule as the CLI (task 65f3be41): a
  // clone is never the parent unless an earlier ink chat attach adopted it,
  // and then it holds this session's turns. Skipping adopted clones resumed
  // Myra from a parent eleven days stale on 2026-10-13.
  const journal = await resolveParentJournal(dir, input.sessionId);
  const split = describeJournalSplit(journal);
  if (split && !reportedSplits.has(`${input.sessionId}\0${split}`)) {
    reportedSplits.add(`${input.sessionId}\0${split}`);
    logger.warn('[HostedInkLog] Session journal history is split', {
      sessionId: input.sessionId,
      selected: journal.path ?? null,
      parents: journal.parents,
      adoptedClones: journal.adoptedClones,
    });
  }
  const path = journal.path ?? join(dir, `${input.sessionId}-${Date.now()}.jsonl`);
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
