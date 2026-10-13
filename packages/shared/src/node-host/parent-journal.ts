/**
 * Which journal file is a session's own: the one replay hydrates from and the
 * session appends to. One rule for the CLI, the hosted runtime and the
 * dashboard (task 65f3be41).
 *
 * A session's journals sit in `.ink/runtime/repl/` as `<sessionId>-<ms>.jsonl`,
 * and spawn_agent writes each clone beside its parent as
 * `<parent>.clone-N.jsonl`, under the same prefix. Picking the newest file by
 * mtime alone took a clone whenever a clone was the last writer, and the next
 * attach appended the session's own turns to it. On Myra's session that
 * happened on Oct 2 and again on Oct 8; the hosted runtime, which skipped
 * clones, then resumed from the Oct 2 parent and replayed none of the turns
 * in between.
 *
 * So a clone file is never a candidate, unless it already carries this
 * session's own records, meaning an earlier attach adopted it. Those files
 * hold real session history and are reported as `adoptedClones`, so a caller
 * can surface the split. Nothing here merges, moves or rewrites a journal.
 */
import { closeSync, openSync, readdirSync, readSync, lstatSync } from 'fs';
import { open, readdir, lstat } from 'fs/promises';
import { join } from 'path';
import { StringDecoder } from 'string_decoder';

/** Records only the parent session writes: its attach markers (chat.ts). A clone never writes them. */
const PARENT_RECORD_TYPES = new Set(['session_attach', 'session_start']);
const PARENT_RECORD_NEEDLES = [...PARENT_RECORD_TYPES].map((type) => `"type":"${type}"`);
const CHUNK_BYTES = 64 * 1024;

export interface JournalCandidate {
  path: string;
  mtimeMs: number;
  clone: boolean;
  /** For a clone: whether it carries this session's own records. Ignored for a parent. */
  carriesParentRecords: boolean;
}

export interface ParentJournalResolution {
  /** The session's journal, or undefined when it has none yet. */
  path?: string;
  /** The session's parent journals (no clone), newest first, the selected one included. */
  parents: string[];
  /** Clone journals that also carry this session's own turns, newest first. Non-empty means the history is split. */
  adoptedClones: string[];
}

export function isSessionJournalName(name: string, sessionId: string): boolean {
  return name.startsWith(`${sessionId}-`) && name.endsWith('.jsonl');
}

export function isCloneJournalName(name: string): boolean {
  return name.includes('.clone-');
}

/** Pure: parents and adopted clones compete by mtime; an ordinary clone never does. */
export function chooseParentJournal(
  candidates: ReadonlyArray<JournalCandidate>
): ParentJournalResolution {
  // Newest first; on a tie the parent wins, so the result never depends on directory order.
  const byNewest = [...candidates].sort(
    (a, b) => b.mtimeMs - a.mtimeMs || Number(a.clone) - Number(b.clone)
  );
  const eligible = byNewest.filter((c) => !c.clone || c.carriesParentRecords);
  return {
    path: eligible[0]?.path,
    parents: byNewest.filter((c) => !c.clone).map((c) => c.path),
    adoptedClones: byNewest.filter((c) => c.clone && c.carriesParentRecords).map((c) => c.path),
  };
}

/** One sentence naming every file that holds the session's turns, for a warning. Undefined when not split. */
export function describeJournalSplit(resolution: ParentJournalResolution): string | undefined {
  if (resolution.adoptedClones.length === 0) return undefined;
  // Every file holding the session's turns, parents included: when an adopted
  // clone is the one replayed, the parent holds the history before it.
  const others = [...resolution.parents, ...resolution.adoptedClones].filter(
    (p) => p !== resolution.path
  );
  const where = resolution.path ? `Replay uses ${resolution.path}` : 'No journal was selected';
  const also = others.length ? `; this session's turns are also in ${others.join(', ')}` : '';
  return (
    `This session's journal history is split across clone files an earlier attach adopted. ` +
    `${where}${also}. Nothing was merged or moved (task 65f3be41).`
  );
}

function lineIsParentRecord(line: string): boolean {
  if (!PARENT_RECORD_NEEDLES.some((needle) => line.includes(needle))) return false;
  try {
    const record: unknown = JSON.parse(line);
    return (
      !!record &&
      typeof record === 'object' &&
      PARENT_RECORD_TYPES.has((record as { type?: unknown }).type as string)
    );
  } catch {
    return false; // a torn line
  }
}

/** Scans line by line and stops at the first parent record. */
class ParentRecordScanner {
  private pending = '';
  found = false;
  push(text: string): boolean {
    const lines = (this.pending + text).split('\n');
    this.pending = lines.pop() ?? '';
    this.found = lines.some(lineIsParentRecord);
    return this.found;
  }
  end(): boolean {
    this.found = this.pending.length > 0 && lineIsParentRecord(this.pending);
    return this.found;
  }
}

export function carriesParentRecordsSync(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const scanner = new ParentRecordScanner();
    const decoder = new StringDecoder('utf8'); // a character split across chunks stays whole
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let bytes: number;
    while ((bytes = readSync(fd, buffer, 0, CHUNK_BYTES, null)) > 0) {
      if (scanner.push(decoder.write(buffer.subarray(0, bytes)))) return true;
    }
    return scanner.push(decoder.end()) || scanner.end();
  } finally {
    closeSync(fd);
  }
}

export async function carriesParentRecords(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const scanner = new ParentRecordScanner();
    for await (const chunk of file.createReadStream({
      highWaterMark: CHUNK_BYTES,
      encoding: 'utf8',
      autoClose: false,
    })) {
      if (scanner.push(chunk as string)) return true;
    }
    return scanner.end();
  } finally {
    await file.close();
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * A symlink or non-file is never a journal. Clone content is read only for
 * clone files. A missing directory, or a file that vanishes mid-scan, is
 * absence; every other read error throws. Treating an unreadable directory
 * as empty would start a fresh journal, and skipping an unreadable clone
 * could hide an adoption.
 */
export function resolveParentJournalSync(dir: string, sessionId: string): ParentJournalResolution {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (isMissing(error)) return { parents: [], adoptedClones: [] };
    throw error;
  }
  const candidates: JournalCandidate[] = [];
  for (const name of names) {
    if (!isSessionJournalName(name, sessionId)) continue;
    const path = join(dir, name);
    try {
      const info = lstatSync(path);
      if (!info.isFile()) continue;
      const clone = isCloneJournalName(name);
      candidates.push({
        path,
        mtimeMs: info.mtimeMs,
        clone,
        carriesParentRecords: clone && carriesParentRecordsSync(path),
      });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return chooseParentJournal(candidates);
}

export async function resolveParentJournal(
  dir: string,
  sessionId: string
): Promise<ParentJournalResolution> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return { parents: [], adoptedClones: [] };
    throw error;
  }
  const candidates = await Promise.all(
    names
      .filter((name) => isSessionJournalName(name, sessionId))
      .map(async (name): Promise<JournalCandidate | undefined> => {
        const path = join(dir, name);
        try {
          const info = await lstat(path);
          if (!info.isFile()) return undefined;
          const clone = isCloneJournalName(name);
          return {
            path,
            mtimeMs: info.mtimeMs,
            clone,
            carriesParentRecords: clone && (await carriesParentRecords(path)),
          };
        } catch (error) {
          if (isMissing(error)) return undefined;
          throw error;
        }
      })
  );
  return chooseParentJournal(candidates.filter((c): c is JournalCandidate => Boolean(c)));
}
