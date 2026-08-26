import { describe, expect, it, vi } from 'vitest';
import {
  isAttachableSessionSummary,
  listAttachableSessions,
  mergeSessionsWithHistory,
} from './chat.js';

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

  // Agent-declared terminal markers the server-side filter does not read:
  // an agent that set phase 'complete' is done with that session even though
  // ended_at is still null. isSessionResumable in claude.ts has always
  // honoured these, so the two pickers must agree.
  it('drops agent-declared terminal phases, matching isSessionResumable', () => {
    expect(isAttachableSessionSummary({ ...base, currentPhase: 'complete' })).toBe(false);
    expect(isAttachableSessionSummary({ ...base, currentPhase: 'complete:shipped' })).toBe(false);
    expect(isAttachableSessionSummary({ ...base, status: 'completed:merged' })).toBe(false);
  });

  it('is case- and whitespace-insensitive on those markers', () => {
    expect(isAttachableSessionSummary({ ...base, currentPhase: '  Complete  ' })).toBe(false);
    expect(isAttachableSessionSummary({ ...base, status: 'COMPLETED' })).toBe(false);
  });

  it('does not mistake in-progress phases for terminal ones', () => {
    expect(isAttachableSessionSummary({ ...base, currentPhase: 'completing-review' })).toBe(true);
    expect(isAttachableSessionSummary({ ...base, currentPhase: 'implementing' })).toBe(true);
    expect(isAttachableSessionSummary({ ...base, currentPhase: 'blocked:backend-error' })).toBe(
      true
    );
  });
});

/**
 * Deployment-order safety.
 *
 * The CLI and the server ship separately. Pointing a new CLI at a server
 * that predates the 'attachable' enum value was reproduced live: the call
 * is rejected, the catch swallows it, and the picker goes empty — which is
 * precisely the bug this change exists to fix, handed to anyone who updates
 * in the usual order.
 */
describe('listAttachableSessions', () => {
  const payload = { sessions: [{ id: 's1' }] };

  it("asks for status 'attachable' when the server supports it", async () => {
    const callTool = vi.fn().mockResolvedValue(payload);
    const result = await listAttachableSessions({ callTool }, { agentId: 'myra', limit: 50 });

    expect(result).toEqual(payload);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith('list_sessions', {
      agentId: 'myra',
      limit: 50,
      status: 'attachable',
    });
  });

  it('retries unfiltered when the server rejects the unknown status', async () => {
    const callTool = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Invalid enum value. Expected 'active' | 'completed', received 'attachable'")
      )
      .mockResolvedValueOnce(payload);

    const result = await listAttachableSessions({ callTool }, { agentId: 'myra', limit: 50 });

    expect(result).toEqual(payload);
    expect(callTool).toHaveBeenNthCalledWith(2, 'list_sessions', {
      agentId: 'myra',
      limit: 50,
    });
  });

  it('does not retry on a real failure, so auth errors stay visible', async () => {
    const callTool = vi.fn().mockRejectedValue(new Error('401 unauthorized'));

    const result = await listAttachableSessions({ callTool }, { agentId: 'myra' });

    expect(result).toBeNull();
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('returns null when the fallback also fails', async () => {
    const callTool = vi
      .fn()
      .mockRejectedValueOnce(new Error("invalid_enum_value: 'attachable'"))
      .mockRejectedValueOnce(new Error('network down'));

    expect(await listAttachableSessions({ callTool }, { agentId: 'myra' })).toBeNull();
    expect(callTool).toHaveBeenCalledTimes(2);
  });
});

describe('mergeSessionsWithHistory', () => {
  const s = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

  it('shows history after attachable rows — sessions are chat history, resumable unless deleted', () => {
    const merged = mergeSessionsWithHistory(
      [s('live-1'), s('crashed-2', { lifecycle: 'failed' })],
      [s('live-1'), s('done-3', { lifecycle: 'completed' }), s('done-4', { status: 'completed' })]
    );
    expect(merged.map((x) => x.id)).toEqual(['live-1', 'crashed-2', 'done-3', 'done-4']);
  });

  it('attachable rows keep their seat — a completed flood cannot displace them', () => {
    const history = Array.from({ length: 50 }, (_, i) =>
      s(`done-${i}`, { lifecycle: 'completed' })
    );
    const merged = mergeSessionsWithHistory([s('daily-driver', { lifecycle: 'failed' })], history);
    expect(merged[0].id).toBe('daily-driver');
    expect(merged).toHaveLength(51);
  });

  it('handles either side empty', () => {
    expect(mergeSessionsWithHistory([], [s('a')]).map((x) => x.id)).toEqual(['a']);
    expect(mergeSessionsWithHistory([s('b')], []).map((x) => x.id)).toEqual(['b']);
  });
});
