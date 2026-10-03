import { describe, it, expect, vi } from 'vitest';
import {
  SESSION_ARCHIVED_REASONS,
  parseArchivedReason,
  readHandedOffTo,
  readResumeRefused,
} from './session-archive.js';
import { SessionRepository } from './session-repository.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SUCCESSOR = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';

describe('parseArchivedReason', () => {
  it('accepts exactly the four reasons the column allows', () => {
    expect([...SESSION_ARCHIVED_REASONS]).toEqual(['backfill', 'deliberate', 'handoff', 'empty']);
    for (const reason of SESSION_ARCHIVED_REASONS) {
      expect(parseArchivedReason(reason)).toBe(reason);
    }
  });

  it('reads anything else as absent', () => {
    for (const value of [null, undefined, '', 'BACKFILL', 'ended', 3, {}]) {
      expect(parseArchivedReason(value)).toBeUndefined();
    }
  });
});

describe('readHandedOffTo', () => {
  it('returns a uuid successor', () => {
    expect(readHandedOffTo({ handedOffTo: SUCCESSOR })).toBe(SUCCESSOR);
  });

  it('ignores a missing, malformed or non-object value', () => {
    expect(readHandedOffTo({})).toBeUndefined();
    expect(readHandedOffTo({ handedOffTo: 'sess-2' })).toBeUndefined();
    expect(readHandedOffTo({ handedOffTo: 42 })).toBeUndefined();
    expect(readHandedOffTo(null)).toBeUndefined();
    expect(readHandedOffTo('x')).toBeUndefined();
  });
});

describe('readResumeRefused', () => {
  const full = {
    reason: 'backend refused resume',
    at: '2026-10-02T22:00:00.000Z',
    backend: 'claude-code',
    backendSessionId: 'backend-transcript-1',
  };

  it('returns the full shape', () => {
    expect(readResumeRefused({ resumeRefused: full })).toEqual(full);
    expect(readResumeRefused({ resumeRefused: { ...full, backendSessionId: null } })).toEqual({
      ...full,
      backendSessionId: null,
    });
  });

  it('reads a partial or malformed record as absent', () => {
    const broken: Array<Record<string, unknown>> = [
      { ...full, reason: '' },
      { ...full, reason: undefined },
      { ...full, at: 'yesterday' },
      { ...full, backend: '' },
      { ...full, backendSessionId: undefined },
      { ...full, backendSessionId: 7 },
    ];
    for (const value of broken) {
      expect(readResumeRefused({ resumeRefused: value })).toBeUndefined();
    }
    expect(readResumeRefused({ resumeRefused: 'refused' })).toBeUndefined();
    expect(readResumeRefused({})).toBeUndefined();
    expect(readResumeRefused(undefined)).toBeUndefined();
  });
});

describe('SessionRepository maps the archive fields', () => {
  function repositoryReturning(row: Record<string, unknown>) {
    const builder = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: row, error: null }),
    };
    const supabase = { from: vi.fn(() => builder) };
    return new SessionRepository(supabase as never);
  }

  const base = {
    id: 'sess-1',
    user_id: 'user-1',
    agent_id: 'wren',
    lifecycle: 'idle',
    status: 'active',
    started_at: '2026-10-02T20:00:00.000Z',
    ended_at: null,
    message_count: 3,
    token_count: 0,
  };

  it('reads an archived row with its reason and metadata contracts', async () => {
    const session = await repositoryReturning({
      ...base,
      archived_at: '2026-10-02T21:00:00.000Z',
      archived_reason: 'handoff',
      metadata: {
        handedOffTo: SUCCESSOR,
        resumeRefused: {
          reason: 'backend refused resume',
          at: '2026-10-02T21:30:00.000Z',
          backend: 'codex',
          backendSessionId: null,
        },
      },
    }).findById('sess-1');

    expect(session?.archivedAt?.toISOString()).toBe('2026-10-02T21:00:00.000Z');
    expect(session?.archivedReason).toBe('handoff');
    expect(session?.handedOffTo).toBe(SUCCESSOR);
    expect(session?.resumeRefused).toEqual({
      reason: 'backend refused resume',
      at: '2026-10-02T21:30:00.000Z',
      backend: 'codex',
      backendSessionId: null,
    });
  });

  it('reads a row from before the migration as not archived', async () => {
    const session = await repositoryReturning({ ...base, metadata: {} }).findById('sess-1');
    expect(session?.archivedAt).toBeNull();
    expect(session?.archivedReason).toBeUndefined();
    expect(session?.handedOffTo).toBeUndefined();
    expect(session?.resumeRefused).toBeUndefined();
  });
});
