/**
 * The reclaim's presence check against a turn that resumes WHILE it runs
 * (Lumen's review of PR #724). Lumen's reproducer, changed only for types
 * (a typed probe in place of `as any`) and formatting.
 *
 * Uses the real lease service and run registry, unlike
 * graph-executor.service.test.ts, which mocks the lease service. A crashed
 * holder is read, then a successor run registers while isSessionLive's
 * SELECT is in flight. The registry was asked only before the await, so the
 * claim was released from under the resumed turn. The control registers the
 * successor before the read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphExecutorService } from './graph-executor.service';
import { hasActiveRun, registerActiveRun, resetActiveRuns } from './sessions/active-runs';

vi.mock('../mcp/tools/inbox-handlers', () => ({ handleSendToInbox: vi.fn() }));
vi.mock('../auth/resolve-identity', () => ({ resolveSbSlug: vi.fn(), resolveSbId: vi.fn() }));
vi.mock('../utils/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

afterEach(() => resetActiveRuns());

interface ReclaimProbe {
  reclaimAbandonedClaims(
    userId: string,
    group: { id: string; user_id: string },
    claims: Array<Record<string, unknown>>
  ): Promise<number>;
}

describe('reclaim during a resumed turn (PR #724 review)', () => {
  it.each([false, true])(
    'keeps a claim when the next run registers during the presence read: %s',
    async (duringRead) => {
      let reads = 0;
      const register = () =>
        registerActiveRun({
          sessionId: 'synthetic-session',
          userId: 'synthetic-user',
          sbSlug: 'fixture',
          backend: 'fixture',
          startedAt: Date.now(),
          turnEpoch: 'next-turn',
        });
      if (!duringRead) register();
      const client = {
        from() {
          const query = {
            select: () => query,
            eq: () => query,
            async maybeSingle() {
              reads++;
              if (reads === 1) {
                return { data: { id: 'synthetic-session', lifecycle: 'failed' }, error: null };
              }
              // The SELECT saw no CLI signals. A resumed server run registers
              // and writes its new epoch while the DB response is in flight.
              register();
              return {
                data: { cli_attached: false, cli_poll_at: null, cli_turn_at: null },
                error: null,
              };
            },
          };
          return query;
        },
      };
      const releaseGraphClaim = vi.fn(async () => ({ success: true }));
      const composer = {
        getClient: () => client,
        repositories: {
          taskGroups: { releaseGraphClaim },
          activityStream: { logActivity: vi.fn() },
        },
      };
      const service = new GraphExecutorService(composer as never);
      const reclaimed = await (service as unknown as ReclaimProbe).reclaimAbandonedClaims(
        'synthetic-user',
        { id: 'synthetic-group', user_id: 'synthetic-user' },
        [
          {
            taskId: 'synthetic-task',
            title: 'fixture',
            taskType: 'work',
            sessionId: 'synthetic-session',
            claimToken: 'unchanged-token',
            claimedAt: new Date().toISOString(),
          },
        ]
      );
      expect(hasActiveRun('synthetic-session')).toBe(true);
      expect(reclaimed).toBe(0);
      expect(releaseGraphClaim).not.toHaveBeenCalled();
    }
  );
});
