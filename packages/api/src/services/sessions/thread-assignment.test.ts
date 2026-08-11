import { describe, expect, it, vi } from 'vitest';
import { assignThreadParticipant } from './thread-assignment';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * Mock supabase for the participant/sessions tables the helper touches.
 * Configurable: current stamp, CAS outcome, session liveness.
 */
function mockDb(opts: {
  currentStamp: string | null;
  /** rows affected by the CAS/guarded update (simulates winning/losing) */
  updateAffects: number;
  /** stamp visible on reread after a lost race */
  stampAfterRace?: string | null;
  deadSessions?: string[];
  /** sessions liveness lookup returns an error (fail-safe: must read as ALIVE) */
  sessionLookupError?: boolean;
  /** participant update returns an error (fail-safe: recover, never claim success) */
  updateError?: boolean;
}) {
  const updates: Array<Record<string, unknown>> = [];
  let readCount = 0;

  const participantChain = () => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = vi.fn(self);
    chain.update = vi.fn().mockImplementation((row: Record<string, unknown>) => {
      updates.push(row);
      return chain;
    });
    chain.eq = vi.fn(self);
    chain.is = vi.fn(self);
    // Terminal for guarded updates: .select() after update returns affected rows
    // — emulate by having the LAST .select() in an update chain resolve.
    chain.maybeSingle = vi.fn().mockImplementation(() => {
      readCount++;
      const stamp =
        readCount === 1 ? opts.currentStamp : (opts.stampAfterRace ?? opts.currentStamp);
      return Promise.resolve({ data: stamp === undefined ? null : { session_id: stamp } });
    });
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        opts.updateError
          ? { data: null, error: { message: 'update failed' } }
          : { data: opts.updateAffects > 0 ? [{ session_id: 'x' }] : [], error: null }
      ).then(resolve);
    return chain;
  };

  const sessionsChain = () => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = vi.fn(self);
    chain.eq = vi.fn().mockImplementation((_col: string, val: string) => {
      (chain as { _id?: string })._id = val;
      return chain;
    });
    chain.maybeSingle = vi.fn().mockImplementation(() => {
      if (opts.sessionLookupError) {
        return Promise.resolve({ data: null, error: { message: 'connection reset' } });
      }
      const id = (chain as { _id?: string })._id!;
      if (opts.deadSessions?.includes(id)) {
        return Promise.resolve({
          data: { id, ended_at: '2026-08-01T00:00:00Z', lifecycle: 'idle' },
          error: null,
        });
      }
      return Promise.resolve({ data: { id, ended_at: null, lifecycle: 'idle' }, error: null });
    });
    return chain;
  };

  return {
    from: vi
      .fn()
      .mockImplementation((table: string) =>
        table === 'sessions' ? sessionsChain() : participantChain()
      ),
    getUpdates: () => updates,
  };
}

const BASE = { threadId: 't1', agentId: 'wren', source: 'test' };

describe('assignThreadParticipant', () => {
  it('claims an unstamped participant (CAS win)', async () => {
    const db = mockDb({ currentStamp: null, updateAffects: 1 });
    const r = await assignThreadParticipant(db, {
      ...BASE,
      candidateSessionId: 's-new',
      explicitAnchor: false,
    });
    expect(r).toEqual({
      sessionId: 's-new',
      rerouted: false,
      boundVia: 'claim',
      stampPersisted: true,
    });
  });

  it('loses the claim race and reroutes to the winner (Lumen test 2)', async () => {
    const db = mockDb({ currentStamp: null, updateAffects: 0, stampAfterRace: 's-winner' });
    const r = await assignThreadParticipant(db, {
      ...BASE,
      candidateSessionId: 's-loser-candidate',
      explicitAnchor: false,
    });
    expect(r.sessionId).toBe('s-winner');
    expect(r.rerouted).toBe(true);
  });

  it('live stamp wins over a non-anchor candidate (continuity)', async () => {
    const db = mockDb({ currentStamp: 's-live', updateAffects: 0 });
    const r = await assignThreadParticipant(db, {
      ...BASE,
      candidateSessionId: 's-other',
      explicitAnchor: false,
    });
    expect(r).toEqual({
      sessionId: 's-live',
      rerouted: true,
      boundVia: 'continuity',
      stampPersisted: true,
    });
    expect(db.getUpdates()).toHaveLength(0);
  });

  it('rebinds when the stamped session is dead', async () => {
    const db = mockDb({ currentStamp: 's-dead', updateAffects: 1, deadSessions: ['s-dead'] });
    const r = await assignThreadParticipant(db, {
      ...BASE,
      candidateSessionId: 's-new',
      explicitAnchor: false,
    });
    expect(r).toEqual({
      sessionId: 's-new',
      rerouted: false,
      boundVia: 'rebind-dead-session',
      stampPersisted: true,
    });
  });

  it('explicit anchor overwrites a live stamp as deliberate retarget (Lumen test 5)', async () => {
    const db = mockDb({ currentStamp: 's-live', updateAffects: 1 });
    const r = await assignThreadParticipant(db, {
      ...BASE,
      candidateSessionId: 's-anchored',
      explicitAnchor: true,
    });
    expect(r).toEqual({
      sessionId: 's-anchored',
      rerouted: false,
      boundVia: 'explicit-retarget',
      stampPersisted: true,
    });
    expect(db.getUpdates()).toEqual([{ session_id: 's-anchored' }]);
  });

  it('explicit anchor on an unstamped participant binds as explicit-anchor', async () => {
    const db = mockDb({ currentStamp: null, updateAffects: 1 });
    const r = await assignThreadParticipant(db, {
      ...BASE,
      candidateSessionId: 's-anchored',
      explicitAnchor: true,
    });
    expect(r.boundVia).toBe('explicit-anchor');
  });

  it('FAIL-SAFE: a session-liveness lookup ERROR reads as alive — no rebind (Lumen P1-3)', async () => {
    // Stamp exists; liveness lookup errors. Treating the error as "dead"
    // would authorize a rebind off a transient DB failure. Must reroute to
    // the existing stamp instead.
    const db = mockDb({ currentStamp: 's-live', updateAffects: 0, sessionLookupError: true });
    const r = await assignThreadParticipant(db, {
      ...BASE,
      candidateSessionId: 's-other',
      explicitAnchor: false,
    });
    expect(r).toEqual({
      sessionId: 's-live',
      rerouted: true,
      boundVia: 'continuity',
      stampPersisted: true,
    });
    expect(db.getUpdates()).toHaveLength(0);
  });

  it('FAIL-SAFE: an anchor write ERROR never claims success — reroutes to the durable stamp (Lumen P1-3)', async () => {
    // Anchor write fails; the durable stamp still says s-live. The result
    // must follow the stamp (rerouted), not pretend the candidate is bound.
    const db = mockDb({ currentStamp: 's-live', updateAffects: 0, updateError: true });
    const r = await assignThreadParticipant(db, {
      ...BASE,
      candidateSessionId: 's-anchored',
      explicitAnchor: true,
    });
    expect(r.sessionId).toBe('s-live');
    expect(r.rerouted).toBe(true);
    expect(r.stampPersisted).toBe(true); // the durable stamp exists — just not ours
  });

  it('FAIL-SAFE: a write ERROR with NO durable stamp reports stampPersisted=false (round 2)', async () => {
    // Claim write fails and recovery finds the row still NULL: nothing
    // durable exists. Callers on the routeOnly path must see this and fail
    // the send — under stamped-only polling an unstamped thread is invisible
    // and no wake retry is coming.
    const db = mockDb({ currentStamp: null, updateAffects: 0, updateError: true });
    const r = await assignThreadParticipant(db, {
      ...BASE,
      candidateSessionId: 's-candidate',
      explicitAnchor: false,
    });
    expect(r.sessionId).toBe('s-candidate');
    expect(r.rerouted).toBe(false);
    expect(r.stampPersisted).toBe(false);
  });

  it('no-ops when already bound to the candidate', async () => {
    const db = mockDb({ currentStamp: 's-same', updateAffects: 0 });
    const r = await assignThreadParticipant(db, {
      ...BASE,
      candidateSessionId: 's-same',
      explicitAnchor: false,
    });
    expect(r).toEqual({
      sessionId: 's-same',
      rerouted: false,
      boundVia: 'already-bound',
      stampPersisted: true,
    });
    expect(db.getUpdates()).toHaveLength(0);
  });
});
