/**
 * .ink/runtime/sessions.json written BEFORE two renames: agentId -> sbSlug
 * (#635) and pcpSessionId -> inkSessionId (#659).
 *
 * The file is still version 1 and nothing rewrites it on upgrade, so both old
 * spellings are what is actually on disk. Each one breaks differently:
 *
 *   agentId        the owner match keys on sbSlug, so an un-normalized record
 *                  never matches and the upsert INSERTS A DUPLICATE instead of
 *                  merging the previous backend-session lineage.
 *   pcpSessionId   the reader's type guard requires inkSessionId, so the whole
 *                  record is DROPPED on read — every legacy row and `current`
 *                  disappear, and the next upsert writes a fresh row with no
 *                  lineage at all.
 *
 * The fixture below therefore has to stay in the old spelling. #659's rename
 * pass rewrote it to the new one, which left this file green while covering
 * nothing: a "legacy" fixture in the current format is just a current fixture.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readRuntimeState, setCurrentRuntimeSession, upsertRuntimeSession } from './runtime.js';

describe('legacy runtime session records', () => {
  let root: string;

  const legacyState = {
    version: 1,
    sessions: [
      {
        pcpSessionId: 'ink-1',
        backend: 'claude',
        agentId: 'aster',
        studioId: 'studio-1',
        backendSessionIds: ['backend-old'],
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    current: {
      pcpSessionId: 'ink-1',
      backend: 'claude',
      agentId: 'aster',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  };

  const write = (state: unknown) => {
    mkdirSync(join(root, '.ink', 'runtime'), { recursive: true });
    writeFileSync(join(root, '.ink', 'runtime', 'sessions.json'), JSON.stringify(state));
  };
  const read = () =>
    JSON.parse(readFileSync(join(root, '.ink', 'runtime', 'sessions.json'), 'utf-8'));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ink-runtime-legacy-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('keeps a legacy record at all', () => {
    write(legacyState);
    // The guard drops anything without inkSessionId, so this is the assertion
    // that fails first when the pcpSessionId migration is missing.
    expect(readRuntimeState(root).sessions).toHaveLength(1);
    expect(readRuntimeState(root).sessions[0].inkSessionId).toBe('ink-1');
  });

  it('keeps the legacy `current` pointer', () => {
    write(legacyState);
    expect(readRuntimeState(root).current?.inkSessionId).toBe('ink-1');
  });

  it('reads the slug off a legacy record', () => {
    write(legacyState);
    expect(readRuntimeState(root).sessions[0].sbSlug).toBe('aster');
  });

  it('reads the slug off the legacy `current` pointer too', () => {
    write(legacyState);
    expect(readRuntimeState(root).current?.sbSlug).toBe('aster');
  });

  it('MERGES into the existing record rather than inserting a duplicate', () => {
    write(legacyState);

    upsertRuntimeSession(root, {
      inkSessionId: 'ink-1',
      backend: 'claude',
      sbSlug: 'aster',
      studioId: 'studio-1',
      backendSessionIds: ['backend-new'],
    } as never);

    const after = read();
    expect(after.sessions).toHaveLength(1);
    // The previous lineage survives — that is what the duplicate would lose.
    expect(after.sessions[0].backendSessionIds).toEqual(
      expect.arrayContaining(['backend-old', 'backend-new'])
    );
  });

  it('still inserts a genuinely new record', () => {
    write(legacyState);

    upsertRuntimeSession(root, {
      inkSessionId: 'ink-2',
      backend: 'claude',
      sbSlug: 'aster',
      studioId: 'studio-1',
      backendSessionIds: ['backend-other'],
    } as never);

    // Control: normalization must not collapse distinct sessions into one.
    expect(read().sessions).toHaveLength(2);
  });

  it('leaves a current-format file alone', () => {
    write({
      version: 1,
      sessions: [
        {
          inkSessionId: 'ink-9',
          backend: 'claude',
          sbSlug: 'wren',
          updatedAt: '2026-09-14T00:00:00.000Z',
        },
      ],
    });
    expect(readRuntimeState(root).sessions[0].sbSlug).toBe('wren');
  });

  // Reading the legacy key is only half of the compatibility problem. The
  // global `ink` link points at one checkout and is not updated when a server
  // is, so an older CLI keeps reading this file. Its type guard requires
  // pcpSessionId — a row written with inkSessionId alone looks malformed, is
  // dropped, and its next write persists the file WITHOUT that row. So the
  // writer has to keep emitting the old key too (Lumen, #659 r2).
  describe('what we write stays readable by a pre-rename CLI', () => {
    /** The older reader's guard, as it exists on main. */
    const oldReaderKeeps = (row: Record<string, unknown>): boolean =>
      typeof row.pcpSessionId === 'string' &&
      typeof row.backend === 'string' &&
      typeof row.updatedAt === 'string';

    it('mirrors the session id under both keys, in rows and in current', () => {
      upsertRuntimeSession(root, {
        inkSessionId: 'ink-7',
        backend: 'claude',
        sbSlug: 'wren',
        backendSessionIds: ['backend-7'],
      } as never);
      setCurrentRuntimeSession(root, 'ink-7', 'claude', { sbSlug: 'wren' });

      const onDisk = read();
      expect(onDisk.sessions[0].inkSessionId).toBe('ink-7');
      expect(onDisk.sessions[0].pcpSessionId).toBe('ink-7');
      expect(onDisk.current.inkSessionId).toBe('ink-7');
      expect(onDisk.current.pcpSessionId).toBe('ink-7');
    });

    it('survives the older reader that would otherwise drop the row', () => {
      upsertRuntimeSession(root, {
        inkSessionId: 'ink-8',
        backend: 'claude',
        sbSlug: 'wren',
        backendSessionIds: ['backend-8'],
      } as never);

      const kept = (read().sessions as Record<string, unknown>[]).filter(oldReaderKeeps);
      expect(kept).toHaveLength(1);
    });

    it('still round-trips through our own reader', () => {
      // Control: the mirrored key must not confuse the current reader.
      upsertRuntimeSession(root, {
        inkSessionId: 'ink-9',
        backend: 'claude',
        sbSlug: 'wren',
      } as never);

      const state = readRuntimeState(root);
      expect(state.sessions.map((s) => s.inkSessionId)).toContain('ink-9');
    });
  });
});
