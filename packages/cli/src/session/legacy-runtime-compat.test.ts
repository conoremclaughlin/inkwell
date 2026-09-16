/**
 * .ink/runtime/sessions.json written BEFORE the agentId -> sbSlug rename.
 *
 * The file is still version 1 and nothing rewrites it on upgrade. The owner
 * match keys on sbSlug, so an un-normalized legacy record never matches and the
 * upsert INSERTS A DUPLICATE instead of merging the previous backend-session
 * lineage — losing resume/link continuity silently.
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
        pcpSessionId: 'pcp-1',
        backend: 'claude',
        agentId: 'aster',
        studioId: 'studio-1',
        backendSessionIds: ['backend-old'],
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    current: {
      pcpSessionId: 'pcp-1',
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
      pcpSessionId: 'pcp-1',
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
      pcpSessionId: 'pcp-2',
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
          pcpSessionId: 'pcp-9',
          backend: 'claude',
          sbSlug: 'wren',
          updatedAt: '2026-09-14T00:00:00.000Z',
        },
      ],
    });
    expect(readRuntimeState(root).sessions[0].sbSlug).toBe('wren');
  });
});
