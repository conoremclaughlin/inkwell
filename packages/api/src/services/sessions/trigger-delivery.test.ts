import { describe, it, expect } from 'vitest';
import {
  checkPollFreshness,
  checkLegacyAttached,
  shouldSkipSpawn,
  decideDelivery,
  type SessionPollRow,
  type SessionAttachedRow,
} from './trigger-delivery';

const NOW = Date.now();

function freshPollRow(sessionId: string): SessionPollRow {
  return { id: sessionId, cli_poll_at: new Date(NOW - 5_000).toISOString(), studio_id: null };
}

function stalePollRow(sessionId: string): SessionPollRow {
  return { id: sessionId, cli_poll_at: new Date(NOW - 60_000).toISOString(), studio_id: null };
}

function attachedRow(ageMs: number): SessionAttachedRow {
  return { cli_attached: true, updated_at: new Date(NOW - ageMs).toISOString() };
}

describe('trigger-delivery', () => {
  describe('checkPollFreshness', () => {
    it('returns true when poll is fresh (< 30s)', () => {
      expect(checkPollFreshness(freshPollRow('s1'), NOW)).toBe(true);
    });

    it('returns false when poll is stale (> 30s)', () => {
      expect(checkPollFreshness(stalePollRow('s1'), NOW)).toBe(false);
    });

    it('returns false when poll row is null', () => {
      expect(checkPollFreshness(null, NOW)).toBe(false);
    });

    it('returns false when cli_poll_at is null', () => {
      expect(checkPollFreshness({ id: 's1', cli_poll_at: null, studio_id: null }, NOW)).toBe(false);
    });
  });

  describe('checkLegacyAttached', () => {
    it('returns attached=true, stale=false for recent session', () => {
      const result = checkLegacyAttached(attachedRow(30_000), NOW);
      expect(result).toEqual({ attached: true, stale: false });
    });

    it('returns attached=true, stale=true for old session (> 10min)', () => {
      const result = checkLegacyAttached(attachedRow(11 * 60 * 1000), NOW);
      expect(result).toEqual({ attached: true, stale: true });
    });

    it('returns attached=false for cli_attached=false', () => {
      const result = checkLegacyAttached(
        { cli_attached: false, updated_at: new Date(NOW).toISOString() },
        NOW
      );
      expect(result).toEqual({ attached: false, stale: false });
    });

    it('returns attached=false for null row', () => {
      expect(checkLegacyAttached(null, NOW)).toEqual({ attached: false, stale: false });
    });
  });

  describe('shouldSkipSpawn', () => {
    it('skips when routed session has fresh poll', () => {
      const result = shouldSkipSpawn(freshPollRow('routed-session'), null, NOW);
      expect(result).toEqual({
        skip: true,
        source: 'cli_poll_at',
        sessionId: 'routed-session',
      });
    });

    it('skips when routed session has legacy cli_attached', () => {
      const result = shouldSkipSpawn(null, attachedRow(30_000), NOW);
      expect(result).toEqual({ skip: true, source: 'cli_attached', sessionId: null });
    });

    it('does NOT skip when poll is stale and no legacy attached', () => {
      const result = shouldSkipSpawn(stalePollRow('routed-session'), null, NOW);
      expect(result).toEqual({ skip: false, source: null, sessionId: null });
    });

    it('does NOT skip when no poll data and no legacy attached', () => {
      const result = shouldSkipSpawn(null, null, NOW);
      expect(result).toEqual({ skip: false, source: null, sessionId: null });
    });

    it('does NOT skip when legacy attached is stale', () => {
      const result = shouldSkipSpawn(null, attachedRow(11 * 60 * 1000), NOW);
      expect(result).toEqual({ skip: false, source: null, sessionId: null });
    });

    // Regression: Lumen's PR #350 review — session A polling, thread routed to session B.
    // The server should only check the ROUTED session's poll state.
    // If session A (different session) is polling, the routed session's poll row
    // will be null/stale → should NOT skip spawn.
    it('does NOT skip when a DIFFERENT session is polling (regression: PR #350)', () => {
      // Session B is the routed session — no fresh poll
      const routedSessionPoll: SessionPollRow = {
        id: 'session-B',
        cli_poll_at: null,
        studio_id: null,
      };
      // Session A is polling (fresh) but is NOT the routed session —
      // it's irrelevant because the caller only passes the routed session's row.
      // This test verifies the contract: only the routed session matters.
      const result = shouldSkipSpawn(routedSessionPoll, null, NOW);
      expect(result).toEqual({ skip: false, source: null, sessionId: null });
    });
  });

  describe('decideDelivery — the delivery-decision step (v18 S3)', () => {
    it('force-spawn wins over a live CLI — attachment state is never consulted', () => {
      // A fresh poll AND fresh attachment would both say inline; the explicit
      // mode overrides. Strategy triggers are self-addressed — inline delivery
      // would be silently dropped by the channel plugin's self-message filter.
      const result = decideDelivery({
        forceSpawn: true,
        pollRow: freshPollRow('s1'),
        attachedRow: attachedRow(1_000),
        now: NOW,
      });
      expect(result).toEqual({ mode: 'spawn', forced: true });
    });

    it('a fresh poll delivers inline with the polling session pinned', () => {
      const result = decideDelivery({
        forceSpawn: false,
        pollRow: freshPollRow('s1'),
        attachedRow: null,
        now: NOW,
      });
      expect(result).toEqual({ mode: 'inline', source: 'cli_poll_at', sessionId: 's1' });
    });

    it('a fresh legacy attachment delivers inline without a session pin', () => {
      const result = decideDelivery({
        forceSpawn: false,
        pollRow: null,
        attachedRow: attachedRow(1_000),
        now: NOW,
      });
      expect(result).toEqual({ mode: 'inline', source: 'cli_attached', sessionId: null });
    });

    it('no live CLI admits an (unforced) spawn', () => {
      const result = decideDelivery({
        forceSpawn: false,
        pollRow: stalePollRow('s1'),
        attachedRow: attachedRow(11 * 60_000),
        now: NOW,
      });
      expect(result).toEqual({ mode: 'spawn', forced: false });
    });
  });
});
