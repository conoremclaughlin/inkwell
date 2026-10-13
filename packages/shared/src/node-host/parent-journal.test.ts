import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  carriesParentRecords,
  carriesParentRecordsSync,
  chooseParentJournal,
  describeJournalSplit,
  resolveParentJournal,
  resolveParentJournalSync,
  type ParentJournalResolution,
} from './parent-journal.js';

// Invented ids; the shapes are the records chat.ts and the clone runtime write.
const SID = '12345678-aaaa-4bbb-8ccc-1234567890ab';
const OTHER = '99999999-aaaa-4bbb-8ccc-1234567890ab';
const line = (record: Record<string, unknown>) => JSON.stringify(record) + '\n';
const attach = line({ type: 'session_attach', sessionId: SID, sbSlug: 'example' });
const start = line({ type: 'session_start', sessionId: SID, sbSlug: 'example' });
const parentTurn = line({ type: 'assistant', text: 'parent turn' });
const cloneStart = line({ type: 'clone_start', id: 'clone-1', parentSessionId: SID });
const cloneTurn =
  line({ type: 'backend_turn', responseText: 'clone work' }) +
  line({ type: 'clone_tool_call', tool: 'bash', status: 'executed' });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      chmodSync(root, 0o700);
    } catch {
      // already gone
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function repl(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ink-parent-journal-')));
  roots.push(root);
  const dir = join(root, '.ink', 'runtime', 'repl');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes a journal with an explicit mtime (seconds) so the order never depends on the clock. */
function journal(dir: string, name: string, body: string, mtime: number): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  utimesSync(path, mtime, mtime);
  return path;
}

/** Both resolvers, so every case proves the CLI (sync) and server (async) paths agree. */
async function resolveBoth(dir: string, sessionId = SID): Promise<ParentJournalResolution> {
  const sync = resolveParentJournalSync(dir, sessionId);
  const async_ = await resolveParentJournal(dir, sessionId);
  expect(async_).toEqual(sync);
  return sync;
}

describe('resolveParentJournal', () => {
  it('a newer ordinary clone is never the parent, and is no split', async () => {
    const dir = repl();
    const parent = journal(dir, `${SID}-100.jsonl`, start + parentTurn, 1000);
    journal(dir, `${SID}-100.clone-1.jsonl`, cloneStart + cloneTurn, 2000);
    const result = await resolveBoth(dir);
    expect(result).toEqual({ path: parent, adoptedClones: [] });
    expect(describeJournalSplit(result)).toBeUndefined();
  });

  it('a clone carrying later parent attaches is the adopted journal while it is newest, and is reported', async () => {
    const dir = repl();
    journal(dir, `${SID}-100.jsonl`, start + parentTurn, 1000);
    const adopted = journal(
      dir,
      `${SID}-100.clone-4.jsonl`,
      cloneStart + cloneTurn + attach + parentTurn,
      2000
    );
    const result = await resolveBoth(dir);
    expect(result).toEqual({ path: adopted, adoptedClones: [adopted] });
    expect(describeJournalSplit(result)).toContain(`Replay uses ${adopted}`);
  });

  it('a nested clone of an adopted clone stays a clone until it is adopted itself', async () => {
    const dir = repl();
    journal(dir, `${SID}-100.jsonl`, start + parentTurn, 1000);
    const adopted = journal(
      dir,
      `${SID}-100.clone-4.jsonl`,
      cloneStart + cloneTurn + attach + parentTurn,
      2000
    );
    const nestedPath = `${SID}-100.clone-4.clone-1.jsonl`;
    journal(dir, nestedPath, cloneStart + cloneTurn, 3000);
    expect(await resolveBoth(dir)).toEqual({ path: adopted, adoptedClones: [adopted] });

    // The next attach adopted the nested clone (Myra's Oct 8 transition).
    const nested = journal(dir, nestedPath, cloneStart + cloneTurn + attach + parentTurn, 4000);
    const result = await resolveBoth(dir);
    expect(result).toEqual({ path: nested, adoptedClones: [nested, adopted] });
    expect(describeJournalSplit(result)).toContain(`also in ${adopted}`);
  });

  it('after the parent resumes, an adopted clone that is no longer newest is still surfaced', async () => {
    // Myra on 2026-10-13: hosted resumed the parent, which is now newest, while
    // eleven days of her turns sit in two adopted clones.
    const dir = repl();
    const adopted = journal(
      dir,
      `${SID}-100.clone-4.jsonl`,
      cloneStart + cloneTurn + attach + parentTurn,
      2000
    );
    const nested = journal(
      dir,
      `${SID}-100.clone-4.clone-1.jsonl`,
      cloneStart + attach + parentTurn,
      3000
    );
    const parent = journal(dir, `${SID}-100.jsonl`, start + parentTurn + parentTurn, 5000);
    const result = await resolveBoth(dir);
    expect(result).toEqual({ path: parent, adoptedClones: [nested, adopted] });
    const warning = describeJournalSplit(result);
    expect(warning).toContain(`Replay uses ${parent}`);
    expect(warning).toContain(nested);
    expect(warning).toContain(adopted);
    expect(warning).toContain('Nothing was merged or moved');
  });

  it("ignores other sessions' journals, symlinks and directories", async () => {
    const dir = repl();
    const parent = journal(dir, `${SID}-100.jsonl`, start, 1000);
    journal(dir, `${OTHER}-200.jsonl`, start, 9000);
    journal(dir, `${OTHER}-200.clone-1.jsonl`, attach, 9000);
    symlinkSync(join(dir, `${OTHER}-200.jsonl`), join(dir, `${SID}-300.jsonl`));
    mkdirSync(join(dir, `${SID}-400.jsonl`));
    expect(await resolveBoth(dir)).toEqual({ path: parent, adoptedClones: [] });
  });

  it('several parent files still compete by mtime, as before', async () => {
    const dir = repl();
    journal(dir, `${SID}-100.jsonl`, start, 1000);
    const newer = journal(dir, `${SID}-200.jsonl`, start, 2000);
    expect((await resolveBoth(dir)).path).toBe(newer);
  });

  it('an empty or missing directory has no journal', async () => {
    const dir = repl();
    expect(await resolveBoth(dir)).toEqual({ adoptedClones: [] });
    expect(await resolveBoth(join(dir, 'missing'))).toEqual({ adoptedClones: [] });
  });

  it.skipIf(process.getuid?.() === 0)(
    'an unreadable directory throws instead of reading as empty',
    async () => {
      const dir = repl();
      journal(dir, `${SID}-100.jsonl`, start, 1000);
      chmodSync(dir, 0o000);
      try {
        expect(() => resolveParentJournalSync(dir, SID)).toThrow();
        await expect(resolveParentJournal(dir, SID)).rejects.toThrow();
      } finally {
        chmodSync(dir, 0o700);
      }
    }
  );

  it.skipIf(process.getuid?.() === 0)(
    'an unreadable clone throws instead of hiding an adoption',
    async () => {
      const dir = repl();
      journal(dir, `${SID}-100.jsonl`, start, 1000);
      const clone = journal(dir, `${SID}-100.clone-1.jsonl`, attach, 2000);
      chmodSync(clone, 0o000);
      expect(() => resolveParentJournalSync(dir, SID)).toThrow();
      await expect(resolveParentJournal(dir, SID)).rejects.toThrow();
    }
  );
});

describe('carriesParentRecords', () => {
  async function both(path: string): Promise<boolean> {
    const sync = carriesParentRecordsSync(path);
    expect(await carriesParentRecords(path)).toBe(sync);
    return sync;
  }

  it('reads a record type, not a string that mentions one', async () => {
    const dir = repl();
    const mention = journal(
      dir,
      'mention.jsonl',
      cloneStart +
        line({ type: 'backend_turn', responseText: 'saw {"type":"session_attach"} in a log' }) +
        line({ type: 'clone_event', payload: { type: 'session_attach' } }),
      1000
    );
    expect(await both(mention)).toBe(false);
    expect(await both(journal(dir, 'start.jsonl', cloneStart + start, 1000))).toBe(true);
    expect(await both(journal(dir, 'attach.jsonl', cloneStart + attach, 1000))).toBe(true);
  });

  it('finds a record past a chunk boundary and across a split multibyte character', async () => {
    const dir = repl();
    // 64 KiB chunks. Size the filler so byte 65,536 falls inside a three-byte
    // character of the attach line: the record spans the chunk boundary and
    // the character is split by it.
    const head = '{"type":"backend_turn","responseText":"';
    const attachHead = '{"type":"session_attach","note":"';
    const fillerChars = 65_536 - (head.length + 3) - attachHead.length - 5 * 3 - 1;
    const filler = line({ type: 'backend_turn', responseText: 'x'.repeat(fillerChars) });
    const straddle = JSON.stringify({ type: 'session_attach', note: '雪'.repeat(20) }) + '\n';
    const boundaryInStraddle = 65_536 - Buffer.byteLength(filler);
    expect(straddle.startsWith(attachHead)).toBe(true);
    expect((boundaryInStraddle - attachHead.length) % 3).not.toBe(0); // mid-character
    const path = journal(dir, 'boundary.jsonl', filler + straddle, 1000);
    expect(await both(path)).toBe(true);
  });

  it('a final line without a newline still counts; a torn one does not', async () => {
    const dir = repl();
    expect(await both(journal(dir, 'tail.jsonl', cloneStart + attach.trimEnd(), 1000))).toBe(true);
    expect(
      await both(journal(dir, 'torn.jsonl', cloneStart + '{"type":"session_attach","sb', 1000))
    ).toBe(false);
  });
});

describe('chooseParentJournal', () => {
  it('on an mtime tie the parent wins, whatever the input order', () => {
    const parent = { path: 'p', mtimeMs: 1, clone: false, carriesParentRecords: false };
    const adopted = { path: 'c', mtimeMs: 1, clone: true, carriesParentRecords: true };
    expect(chooseParentJournal([parent, adopted])).toEqual({ path: 'p', adoptedClones: ['c'] });
    expect(chooseParentJournal([adopted, parent])).toEqual({ path: 'p', adoptedClones: ['c'] });
  });
});
