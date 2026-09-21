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
import { readRuntimeState, upsertRuntimeSession } from './runtime.js';

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
});
