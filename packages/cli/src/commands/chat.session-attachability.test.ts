import { describe, expect, it } from 'vitest';
import { isAttachableSessionSummary } from './chat.js';

/**
 * Regression coverage for the picker erasing crashed sessions.
 *
 * The Ink session picker used to pass `status: 'active'` to list_sessions,
 * and the server's derived-state filter groups lifecycle 'failed' with the
 * terminal lifecycles — so every session whose backend had crashed (myra's
 * daily-driver sessions, post-outage) silently vanished from `ink chat`.
 * The picker now lists without the server status filter and applies this
 * predicate instead.
 */
describe('isAttachableSessionSummary', () => {
  const base = { id: 'abc12345-0000-0000-0000-000000000000' };

  it('keeps a crashed session — lifecycle failed is prime attach material', () => {
    expect(isAttachableSessionSummary({ ...base, status: 'active', lifecycle: 'failed' })).toBe(
      true
    );
  });

  it('keeps live sessions across agent-declared statuses', () => {
    expect(isAttachableSessionSummary({ ...base, status: 'active', lifecycle: 'idle' })).toBe(true);
    expect(isAttachableSessionSummary({ ...base, status: 'resumable', lifecycle: 'running' })).toBe(
      true
    );
    expect(isAttachableSessionSummary({ ...base, status: 'paused' })).toBe(true);
  });

  it('keeps sessions with no lifecycle metadata at all', () => {
    expect(isAttachableSessionSummary({ ...base })).toBe(true);
  });

  it('drops a session that actually ended', () => {
    expect(
      isAttachableSessionSummary({ ...base, status: 'active', endedAt: '2026-08-01T00:00:00Z' })
    ).toBe(false);
  });

  it('drops completed lifecycle and completed status', () => {
    expect(isAttachableSessionSummary({ ...base, lifecycle: 'completed' })).toBe(false);
    expect(isAttachableSessionSummary({ ...base, status: 'completed' })).toBe(false);
  });
});
