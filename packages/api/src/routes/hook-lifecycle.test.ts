/**
 * Hook-lifecycle route tests (PR #492 rounds 4–6).
 *
 * The CLI's real hook traffic is a TWO-request sequence per prompt: the
 * prompt event first (opens cli_turn_at), then a cliAttached re-assert. Round
 * 6 caught the attach/detach rule clearing the marker on that second request
 * — a no-plugin CLI looked dead for its whole turn. These tests run the
 * actual HTTP sequences against the router and assert what lands in
 * updateSession: the turn marker must survive attach re-asserts and fall only
 * to the real stop event or an explicit detach.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

vi.mock('../mcp/auth/pcp-auth-provider', () => ({
  PcpAuthProvider: class {
    verifyAccessToken(header?: string) {
      return header ? { userId: 'user-1' } : null;
    }
  },
}));

vi.mock('../services/graph-executor.service', () => ({
  releaseGraphClaimsForSession: vi.fn(async () => undefined),
}));

import { createHookLifecycleRouter } from './hook-lifecycle';
import { StudioLeaseService } from '../services/studio-lease.service';
import { releaseGraphClaimsForSession } from '../services/graph-executor.service';
import type { DataComposer } from '../data/composer';

// Minimal fake supabase for the StudioLeaseService the route constructs —
// empty tables make lease renewals/releases clean no-ops. Direct table
// UPDATEs (the round-11 fenced stop CAS) are recorded with their filters and
// resolve with a matched row unless a test flips `fencedUpdateMatches`.
interface RecordedUpdate {
  table: string;
  payload: Record<string, unknown>;
  eqs: Array<[string, unknown]>;
}
const recordedUpdates: RecordedUpdate[] = [];
let fencedUpdateMatches = true;
let directUpdateError: { message: string } | null = null;

function makeFakeClient() {
  const chain = (table: string, mode: 'select' | 'update' | 'insert', payload?: unknown) => {
    const eqs: Array<[string, unknown]> = [];
    const obj = {
      eq(col: string, val: unknown) {
        eqs.push([col, val]);
        return obj;
      },
      is() {
        return obj;
      },
      not() {
        return obj;
      },
      limit() {
        return obj;
      },
      order() {
        return obj;
      },
      select() {
        return obj;
      },
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single: () => Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'none' } }),
      then<T>(resolve: (v: { data: unknown; error: null }) => T) {
        if (mode === 'update') {
          recordedUpdates.push({
            table,
            payload: (payload ?? {}) as Record<string, unknown>,
            eqs,
          });
          return Promise.resolve({
            data: directUpdateError ? null : fencedUpdateMatches ? [{ id: SESSION_ID }] : [],
            error: directUpdateError,
          }).then(resolve as never);
        }
        return Promise.resolve({ data: [] as never[], error: null }).then(resolve);
      },
    };
    return obj;
  };
  return {
    from: (table: string) => ({
      select: () => chain(table, 'select'),
      update: (payload: unknown) => chain(table, 'update', payload),
      insert: () => chain(table, 'insert'),
    }),
    rpc: (...args: unknown[]) => {
      rpcCalls.push(args);
      return Promise.resolve(rpcResult());
    },
  } as never;
}

/** Recorded rpc invocations across all fake clients (the route re-gets one per request). */
const rpcCalls: unknown[][] = [];
let rpcResult: () => { data: unknown; error: { message: string } | null } = () => ({
  data: { outcome: 'claimed', epoch: 'epoch-1' },
  error: null,
});

const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

describe('hook-lifecycle CLI turn signal', () => {
  const updateSession = vi.fn(async (_id: string, _updates: Record<string, unknown>) => ({
    id: SESSION_ID,
  }));
  const getSession = vi.fn(async () => ({
    id: SESSION_ID,
    userId: 'user-1',
    endedAt: null,
    status: 'active',
    lifecycle: 'idle',
  }));

  const dataComposer = {
    getClient: () => makeFakeClient(),
    repositories: { memory: { getSession, updateSession } },
  } as unknown as DataComposer;

  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/hooks', createHookLifecycleRouter(dataComposer));
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    updateSession.mockClear();
    getSession.mockClear();
    rpcCalls.length = 0;
    rpcResult = () => ({ data: { outcome: 'claimed', epoch: 'epoch-1' }, error: null });
    recordedUpdates.length = 0;
    fencedUpdateMatches = true;
    directUpdateError = null;
  });

  async function post(body: Record<string, unknown>) {
    const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ sessionId: SESSION_ID, ...body }),
    });
    expect(resp.status).toBe(200);
    return updateSession.mock.calls.at(-1)?.[1] as Record<string, unknown>;
  }

  it('a non-UUID sessionId is rejected before it reaches the database', async () => {
    // "sess-1"-shaped ids (test fixtures leaking from integration runs, or
    // any malformed caller) used to reach Postgres, raise 22P02, and
    // error-spam the log with a stack per request. Bad input is a 400.
    const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ sessionId: 'sess-1', lifecycle: 'running', event: 'prompt' }),
    });
    expect(resp.status).toBe(400);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('the real two-request prompt sequence leaves the turn marker OPEN (rounds 6, 10)', async () => {
    // Request 1: the prompt event opens the turn — INSIDE the claim RPC
    // (round 10): epoch, lifecycle, and the marker land in ONE statement,
    // and the route performs no second ownership write that a concurrent
    // stop could be overwritten by.
    await post({ lifecycle: 'running', event: 'prompt' });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]![1]).toMatchObject({ p_set_running: true });
    for (const call of updateSession.mock.calls) {
      expect(call[1]).not.toHaveProperty('lifecycle');
      expect(call[1]).not.toHaveProperty('cliTurnAt');
    }

    // Request 2: the CLI immediately re-asserts attachment. This must NOT
    // touch the marker the prompt just opened.
    const attachUpdates = await post({ cliAttached: true });
    expect('cliTurnAt' in attachUpdates).toBe(false);
  });

  it('a prompt with a worktree studio gets the fenced lease-held report', async () => {
    // Round 12: the claim RPC verifies + stamps the lease atomically with
    // the epoch claim, so a CLAIMED outcome is held by construction — and
    // the studio rides INTO the claim so the verification is the same
    // transaction, not a later read.
    const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        lifecycle: 'running',
        event: 'prompt',
        studioId: '5bea57f3-6b24-4126-abe4-0d1cc2bd9647',
      }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.studioLeaseHeld).toBe(true);
    expect(rpcCalls[0]![1]).toMatchObject({
      p_studio_id: '5bea57f3-6b24-4126-abe4-0d1cc2bd9647',
    });

    // No studioId (main/studioless senders): the field is absent, never a veto.
    const resp2 = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ sessionId: SESSION_ID, lifecycle: 'running', event: 'prompt' }),
    });
    const body2 = (await resp2.json()) as Record<string, unknown>;
    expect('studioLeaseHeld' in body2).toBe(false);
  });

  it('an explicit detach clears the marker (process proof)', async () => {
    const updates = await post({ cliAttached: false });
    expect(updates.cliTurnAt).toBeNull();
  });

  it('only the real stop event closes the turn; post-compact idle does not', async () => {
    const stopUpdates = await post({ lifecycle: 'idle', event: 'stop' });
    expect(stopUpdates.cliTurnAt).toBeNull();

    const postCompactUpdates = await post({ lifecycle: 'idle', event: 'post-compact' });
    expect('cliTurnAt' in postCompactUpdates).toBe(false);

    // Legacy sender: bare idle without an event — never inferred as a stop.
    const legacyIdleUpdates = await post({ lifecycle: 'idle' });
    expect('cliTurnAt' in legacyIdleUpdates).toBe(false);
  });

  it('legacy running without an event still opens the turn (protection only extends)', async () => {
    // Round 10: the turn opens inside the claim RPC — same single-writer
    // rule as an explicit prompt event.
    await post({ lifecycle: 'running' });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]![1]).toMatchObject({ p_set_running: true });
  });

  /**
   * Round 4 (PR #563, Lumen): a CLI prompt taking over a session stuck at
   * `running` is a running → running write with no metadata — the epoch
   * trigger never fires, and a stale server turn's fenced finalize would
   * still match and clobber this CLI session. The route must claim a fresh
   * epoch, atomically, before the lifecycle write.
   */
  describe('turn-epoch claim on prompt takeover', () => {
    it('claims a fresh epoch before the lifecycle write on prompt events', async () => {
      await post({ lifecycle: 'running', event: 'prompt' });
      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0]![0]).toBe('claim_turn_epoch');
      expect(rpcCalls[0]![1]).toMatchObject({ p_session_id: SESSION_ID, p_set_running: true });
    });

    it('does not claim for a HEADLESS prompt — the server owns that epoch', async () => {
      // A server-spawned child's own on-prompt hook fires too; claiming here
      // would rotate the epoch the server's pre-turn write holds and fence
      // the server's finalize out of its own turn (round 6).
      await post({ lifecycle: 'running', event: 'prompt', headless: true });
      expect(rpcCalls).toHaveLength(0);
    });

    it('does not claim on stop or attach-only requests', async () => {
      await post({ lifecycle: 'idle', event: 'stop' });
      await post({ cliAttached: true });
      expect(rpcCalls).toHaveLength(0);
    });

    /**
     * Round 9 (PR #563, Lumen): the marker reclaim raced the stop event — a
     * parked claim could land after the stop and re-mark a finished turn as
     * running. The reclaim now carries the marker's birth time and the RPC
     * CASes it against the stop tombstone; a refused reclaim is a 409 the
     * caller treats as "turn over, retire the marker".
     */
    it('a RECLAIM threads the marker birth time into the tombstone CAS', async () => {
      const markerAt = '2026-09-01T12:00:00.000Z';
      await post({ lifecycle: 'running', event: 'prompt', reclaimOf: markerAt });
      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0]![1]).toMatchObject({
        p_session_id: SESSION_ID,
        p_set_running: true,
        p_not_stopped_after: markerAt,
      });
      // An ordinary prompt claim stays unconditional — no tombstone predicate.
      rpcCalls.length = 0;
      await post({ lifecycle: 'running', event: 'prompt' });
      expect(rpcCalls[0]![1]).not.toHaveProperty('p_not_stopped_after');
    });

    it("a reclaim the tombstone refuses is a 409 'stopped', and the lifecycle never writes", async () => {
      rpcResult = () => ({ data: { outcome: 'stopped' }, error: null }); // tombstone CAS refused
      const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          lifecycle: 'running',
          event: 'prompt',
          reclaimOf: '2026-09-01T12:00:00.000Z',
        }),
      });
      expect(resp.status).toBe(409);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.code).toBe('stopped');
      // The dead turn is never re-marked running.
      expect(updateSession).not.toHaveBeenCalled();
    });

    it('the stop event stamps the tombstone the reclaim CAS reads', async () => {
      const updates = await post({ lifecycle: 'idle', event: 'stop' });
      expect(updates.cliTurnAt).toBeNull();
      expect(typeof updates.cliTurnStoppedAt).toBe('string');
      // Non-stop requests never touch it.
      await post({ lifecycle: 'running', event: 'prompt' });
      for (const call of updateSession.mock.calls) {
        if (call[1] !== updates) expect(call[1]).not.toHaveProperty('cliTurnStoppedAt');
      }
    });

    it('fails the prompt visibly when the claim fails — never an unfenced takeover', async () => {
      rpcResult = () => ({ data: null, error: { message: 'db down' } });
      const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({ sessionId: SESSION_ID, lifecycle: 'running', event: 'prompt' }),
      });
      expect(resp.status).toBe(500);
      // The lifecycle write never ran: no half-taken session.
      expect(updateSession).not.toHaveBeenCalled();
    });
  });

  /**
   * Round 10 (Lumen): the claim RPC is the SINGLE ownership writer, and the
   * claimed epoch reaches every resource that fences on it — the lease (via
   * restamp), the CLI (via the response), and the eventual stop's releases.
   */
  describe('single-writer claim and epoch threading (round 10)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.mocked(releaseGraphClaimsForSession).mockClear();
    });

    it('a claimed prompt performs NO second ownership write — a stop between RPC and route cannot be overwritten', async () => {
      // workingDir rides along so the follow-up write demonstrably HAPPENS —
      // fenced on the committed epoch (round 12) and stripped of the fields
      // the RPC already owns; the unfenced repository path is never used.
      await post({ lifecycle: 'running', event: 'prompt', workingDir: '/w' });
      expect(updateSession).not.toHaveBeenCalled();
      const ride = recordedUpdates.find((u) => u.table === 'sessions')!;
      expect(ride).toBeDefined();
      expect(ride.payload).toEqual({ working_dir: '/w' });
      expect(ride.eqs).toContainEqual(['turn_epoch', 'epoch-1']);
    });

    it('a HEADLESS prompt keeps the plain lifecycle write — the server owns its epoch', async () => {
      const updates = await post({ lifecycle: 'running', event: 'prompt', headless: true });
      expect(updates.lifecycle).toBe('running');
      expect(typeof updates.cliTurnAt).toBe('string');
      expect(rpcCalls).toHaveLength(0);
    });

    it('the claimed epoch rides back to the CLI in the response; headless gets none', async () => {
      const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({ sessionId: SESSION_ID, lifecycle: 'running', event: 'prompt' }),
      });
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.turnEpoch).toBe('epoch-1');

      const headlessResp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          lifecycle: 'running',
          event: 'prompt',
          headless: true,
        }),
      });
      const headlessBody = (await headlessResp.json()) as Record<string, unknown>;
      expect('turnEpoch' in headlessBody).toBe(false);
    });

    it('a claimed prompt stamps its leases INSIDE the claim — the follow-ups are pure heartbeats', async () => {
      // Round 13: every restamp happens atomically inside the RPC (which
      // stamps ALL the session's leases). The application-level renewal is a
      // heartbeat only — a delayed turn A's renewal landing after successor
      // B's claim must not be ABLE to stamp anything back to A.
      const renew = vi
        .spyOn(StudioLeaseService.prototype, 'renewBySession')
        .mockResolvedValue(true);
      const touch = vi
        .spyOn(StudioLeaseService.prototype, 'touchStudioLeaseForSession')
        .mockResolvedValue(true);

      const studioId = '5bea57f3-6b24-4126-abe4-0d1cc2bd9647';
      const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          lifecycle: 'running',
          event: 'prompt',
          studioId,
        }),
      });
      const body = (await resp.json()) as Record<string, unknown>;

      expect(rpcCalls[0]![1]).toMatchObject({ p_studio_id: studioId });
      // No epoch rides into the renewal — the A→B→delayed-A rewind is
      // structurally impossible when renewals cannot carry a generation.
      expect(renew).toHaveBeenCalledWith(SESSION_ID, 'user-1');
      expect(touch).not.toHaveBeenCalled();
      expect(body.studioLeaseHeld).toBe(true);
    });

    it('the stop carries the epoch it is ending into BOTH resource releases', async () => {
      const release = vi
        .spyOn(StudioLeaseService.prototype, 'releaseAtBoundary')
        .mockResolvedValue(true);

      await post({ lifecycle: 'idle', event: 'stop', turnEpoch: 'epoch-z' });
      // The boundary chain is fire-and-forget — let it settle.
      await vi.waitFor(() => expect(release).toHaveBeenCalled());

      expect(release.mock.calls[0]![1]).toMatchObject({ expectedTurnEpoch: 'epoch-z' });
      const graphCall = vi.mocked(releaseGraphClaimsForSession).mock.calls.at(-1)!;
      expect(graphCall[1]).toBe(SESSION_ID);
      expect(graphCall[4]).toBe('epoch-z');
    });

    it('a legacy stop without an epoch releases unfenced, as before', async () => {
      const release = vi
        .spyOn(StudioLeaseService.prototype, 'releaseAtBoundary')
        .mockResolvedValue(true);

      await post({ lifecycle: 'idle', event: 'stop' });
      await vi.waitFor(() => expect(release).toHaveBeenCalled());

      expect(release.mock.calls[0]![1]).toMatchObject({ expectedTurnEpoch: undefined });
    });
  });

  /**
   * Round 11 (Lumen): the stop's OWN row write is epoch-fenced (one CAS for
   * idle + marker + tombstone), a stale stop is a reported no-op, a modern
   * stop with a lost record fails closed, and ride-along bookkeeping can
   * never turn a committed claim into a failure.
   */
  describe('fenced stop and fail-closed degradation (round 11)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.mocked(releaseGraphClaimsForSession).mockClear();
    });

    it('a modern stop lands idle + marker clear + tombstone in ONE epoch-CASed statement', async () => {
      await post({ lifecycle: 'idle', event: 'stop', turnEpoch: 'epoch-z' });

      const fenced = recordedUpdates.find(
        (u) => u.table === 'sessions' && u.payload.lifecycle === 'idle'
      )!;
      expect(fenced).toBeDefined();
      expect(fenced.payload.cli_turn_at).toBeNull();
      expect(typeof fenced.payload.cli_turn_stopped_at).toBe('string');
      expect(fenced.eqs).toContainEqual(['id', SESSION_ID]);
      expect(fenced.eqs).toContainEqual(['turn_epoch', 'epoch-z']);
      // The repository path never writes the ownership fields for a modern stop.
      for (const call of updateSession.mock.calls) {
        expect(call[1]).not.toHaveProperty('lifecycle');
        expect(call[1]).not.toHaveProperty('cliTurnAt');
        expect(call[1]).not.toHaveProperty('cliTurnStoppedAt');
      }
    });

    it('a STALE stop (successor owns the row) writes nothing and releases nothing', async () => {
      // The A-stop-after-B-claim interleaving: B claimed a fresh epoch, A's
      // late stop must not mark B idle, clear B's marker, stamp a tombstone
      // over B, or release B's resources.
      fencedUpdateMatches = false;
      const release = vi
        .spyOn(StudioLeaseService.prototype, 'releaseAtBoundary')
        .mockResolvedValue(true);

      const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          lifecycle: 'idle',
          event: 'stop',
          turnEpoch: 'epoch-a',
          workingDir: '/w',
        }),
      });

      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.stale).toBe(true);
      expect(updateSession).not.toHaveBeenCalled();
      await new Promise((r) => setImmediate(r));
      expect(release).not.toHaveBeenCalled();
      expect(releaseGraphClaimsForSession).not.toHaveBeenCalled();
    });

    it('a modern stop with a LOST record fails closed: no row write, no releases, heartbeat only', async () => {
      const release = vi
        .spyOn(StudioLeaseService.prototype, 'releaseAtBoundary')
        .mockResolvedValue(true);
      const renew = vi
        .spyOn(StudioLeaseService.prototype, 'renewBySession')
        .mockResolvedValue(true);

      const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          lifecycle: 'idle',
          event: 'stop',
          turnEpochMissing: true,
        }),
      });

      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.suppressed).toBe(true);
      // No ownership write anywhere: not via the repository, not direct —
      // EXCEPT the stop tombstone (round 17), which is monotonically safe
      // and refuses server-parked reclaims landing on this dead turn.
      for (const call of updateSession.mock.calls) {
        expect(call[1]).not.toHaveProperty('lifecycle');
        expect(call[1]).not.toHaveProperty('cliTurnAt');
        expect(call[1]).not.toHaveProperty('cliTurnStoppedAt');
      }
      const sessionWrites = recordedUpdates.filter((u) => u.table === 'sessions');
      expect(sessionWrites).toHaveLength(1);
      expect(Object.keys(sessionWrites[0]!.payload)).toEqual(['cli_turn_stopped_at']);
      expect(renew).toHaveBeenCalled();
      await new Promise((r) => setImmediate(r));
      expect(release).not.toHaveBeenCalled();
      expect(releaseGraphClaimsForSession).not.toHaveBeenCalled();
    });

    it('a REFUSED tombstone stamp fails the suppressed stop — never a 200 without the fence (round 18)', async () => {
      directUpdateError = { message: 'db down' };

      const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          lifecycle: 'idle',
          event: 'stop',
          turnEpochMissing: true,
        }),
      });

      expect(resp.status).toBe(500);
    });

    it('ride-along failure after a COMMITTED claim reports the claim, not a failure', async () => {
      // The 500 would make Claude block a prompt whose ownership already
      // transferred — row running, no process (the P1-3 zombie).
      updateSession.mockRejectedValueOnce(new Error('db flake'));

      const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          lifecycle: 'running',
          event: 'prompt',
          workingDir: '/w',
        }),
      });

      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.turnEpoch).toBe('epoch-1');
    });

    it('the same failure WITHOUT a committed claim still fails the request', async () => {
      updateSession.mockResolvedValueOnce(null as never);

      const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({ sessionId: SESSION_ID, cliAttached: true }),
      });

      expect(resp.status).toBe(500);
    });
  });

  /**
   * Round 12 (Lumen): claim + lease protection are ONE atomic success
   * boundary — a lost lease refuses the whole takeover with NOTHING
   * committed — and ride-alongs are fenced on the committed epoch so a late
   * turn can never overwrite a successor's working_dir.
   */
  describe('atomic claim boundary (round 12)', () => {
    it('a LOST lease refuses the takeover with nothing committed', async () => {
      // The release-wins ordering: the RPC's studio lock saw the lease gone
      // and refused BEFORE claiming. No running row, no open marker, no
      // epoch — the caller's failed-takeover handling runs against a clean
      // row.
      rpcResult = () => ({ data: { outcome: 'lease-lost' }, error: null });

      const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          lifecycle: 'running',
          event: 'prompt',
          studioId: '5bea57f3-6b24-4126-abe4-0d1cc2bd9647',
          workingDir: '/w',
        }),
      });

      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.studioLeaseHeld).toBe(false);
      expect('turnEpoch' in body).toBe(false);
      // Nothing landed: no repository write, no direct write.
      expect(updateSession).not.toHaveBeenCalled();
      expect(recordedUpdates.filter((u) => u.table === 'sessions')).toHaveLength(0);
    });

    it('a STALE fenced ride-along is a tolerated no-op — the claim still reports success', async () => {
      // Successor B claimed between A's claim and A's ride-along: the fenced
      // write matches zero rows and B's working_dir survives.
      fencedUpdateMatches = false;

      const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          lifecycle: 'running',
          event: 'prompt',
          workingDir: '/w',
        }),
      });

      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.turnEpoch).toBe('epoch-1');
      const ride = recordedUpdates.find((u) => u.table === 'sessions')!;
      expect(ride.eqs).toContainEqual(['turn_epoch', 'epoch-1']);
    });

    it('a cross-tenant claim is a 403, never a lease report (round 15 P0)', async () => {
      rpcResult = () => ({ data: { outcome: 'forbidden' }, error: null });

      const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          lifecycle: 'running',
          event: 'prompt',
          studioId: '5bea57f3-6b24-4126-abe4-0d1cc2bd9647',
        }),
      });

      expect(resp.status).toBe(403);
      expect(updateSession).not.toHaveBeenCalled();
    });

    it('the regrant carries the canonical identity UUID from the session row (round 15)', async () => {
      getSession.mockResolvedValueOnce({
        id: SESSION_ID,
        userId: 'user-1',
        endedAt: null,
        status: 'active',
        lifecycle: 'idle',
        sbId: 'sb-uuid-1',
      } as never);

      await post({
        lifecycle: 'running',
        event: 'prompt',
        studioId: '5bea57f3-6b24-4126-abe4-0d1cc2bd9647',
      });

      const args = rpcCalls[0]![1] as Record<string, unknown>;
      expect(args.p_regrant).toMatchObject({ sbId: 'sb-uuid-1' });
    });

    it('an UNRECOGNIZED claim verdict fails closed — never success without ownership (round 13)', async () => {
      // Legacy string shape, null data, and claimed-without-epoch all mean
      // the contract broke; falling through would report success/held with
      // nothing established.
      for (const data of ['epoch-1', null, { outcome: 'claimed' }, { outcome: 'wat' }]) {
        rpcResult = () => ({ data, error: null });
        const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
          body: JSON.stringify({ sessionId: SESSION_ID, lifecycle: 'running', event: 'prompt' }),
        });
        expect(resp.status).toBe(500);
        expect(updateSession).not.toHaveBeenCalled();
      }
    });

    it('the regrant rides INTO the claim — one RPC, one lock, one transaction (round 14)', async () => {
      // Round 13's app-level reacquire was three separate commits and every
      // seam was a boundary failure. Now the vacancy check, eligibility
      // (thread not closed, studio acquirable, no sibling holder), grant,
      // epoch claim, and session binding are the RPC's single transaction —
      // the route only OFFERS the lease to install.
      const acquire = vi.spyOn(StudioLeaseService.prototype, 'acquire');
      rpcResult = () => ({
        data: { outcome: 'claimed', epoch: 'epoch-re', regranted: true },
        error: null,
      });

      const studioId = '5bea57f3-6b24-4126-abe4-0d1cc2bd9647';
      const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          lifecycle: 'running',
          event: 'prompt',
          studioId,
        }),
      });

      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.turnEpoch).toBe('epoch-re');
      expect(body.studioLeaseHeld).toBe(true);
      expect(rpcCalls).toHaveLength(1);
      const args = rpcCalls[0]![1] as Record<string, unknown>;
      expect(args.p_studio_id).toBe(studioId);
      expect(args.p_regrant).toMatchObject({
        sessionId: SESSION_ID,
        reason: 'cli-prompt-regrant',
      });
      // No application-level acquire remains — the seams are gone.
      expect(acquire).not.toHaveBeenCalled();
    });

    it('an INELIGIBLE vacancy (revoked thread, sibling holder, retired studio) refuses cleanly', async () => {
      const acquire = vi.spyOn(StudioLeaseService.prototype, 'acquire');
      rpcResult = () => ({ data: { outcome: 'lease-lost' }, error: null });

      const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          lifecycle: 'running',
          event: 'prompt',
          studioId: '5bea57f3-6b24-4126-abe4-0d1cc2bd9647',
        }),
      });

      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.studioLeaseHeld).toBe(false);
      expect('turnEpoch' in body).toBe(false);
      expect(rpcCalls).toHaveLength(1);
      expect(acquire).not.toHaveBeenCalled();
      expect(updateSession).not.toHaveBeenCalled();
    });

    it('the fenced STOP fences its ride-alongs on the stop epoch too', async () => {
      await post({ lifecycle: 'idle', event: 'stop', turnEpoch: 'epoch-z', workingDir: '/w' });

      expect(updateSession).not.toHaveBeenCalled();
      const ride = recordedUpdates.find(
        (u) => u.table === 'sessions' && 'working_dir' in u.payload
      )!;
      expect(ride).toBeDefined();
      expect(ride.eqs).toContainEqual(['turn_epoch', 'epoch-z']);
    });
  });
});
