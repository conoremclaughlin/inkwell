/**
 * Lumen's PR #605 P2 probe, turned from a defect assertion into the regression.
 *
 * A studio created FOR a thread used to seed only a route pattern and the
 * creator's lease. That is not delivery: with the creator running in their
 * original studio and the new thread having no home, real session resolution
 * created a fresh session in the new studio at plan time, and admission then
 * met the creator's lease as a foreign holder (overflow, or a hold).
 *
 * The fix binds the thread's home to the creator's session (participant
 * stamp, explicit anchor) and the dispatcher resolves recipientSessionId from
 * that stamp before routing looks at studios. With that hint present,
 * resolution lands on the creator in both plan and admission and nothing new
 * is minted.
 */
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'os';
import { StudioOverflowService } from '../../services/studio-overflow.service';
import { SessionService } from '../../services/sessions/session-service';
import { makeFakeSupabase } from '../../services/sessions/fake-supabase';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const USER = '11111111-1111-4111-8111-111111111111';
const OWN = '22222222-2222-4222-8222-222222222222';
const STUDIO = '44444444-4444-4444-8444-444444444444';
const SB = '55555555-5555-4555-8555-555555555555';

function fixture() {
  const now = new Date().toISOString();
  const tables = {
    studios: [
      {
        id: STUDIO,
        user_id: USER,
        agent_id: 'lumen',
        sb_id: SB,
        session_id: OWN,
        status: 'active',
        worktree_path: tmpdir(),
        repo_root: '/repos/inkwell',
        route_patterns: ['pr:probe'],
        thread_key: 'pr:probe',
        ephemeral: true,
        lease: {
          sessionId: OWN,
          agentId: 'lumen',
          sbId: SB,
          threadKey: 'pr:probe',
          threadKeys: ['pr:probe'],
          acquiredAt: now,
          heartbeatAt: now,
        },
      },
    ],
    sessions: [
      {
        id: OWN,
        user_id: USER,
        sb_id: SB,
        agent_id: 'lumen',
        studio_id: 'creator-original-studio',
        thread_key: 'thread:original',
        ended_at: null,
        cli_turn_at: now,
      },
    ],
    agent_identities: [
      { id: SB, user_id: USER, agent_id: 'lumen', workspace_id: 'ws', updated_at: now },
    ],
    inbox_threads: [{ id: 'thread', user_id: USER, thread_key: 'pr:probe', key_type: 'pr' }],
    thread_key_types: [
      {
        id: 'pr-type',
        user_id: null,
        type: 'pr',
        write_intent: 'write',
        studio_policy: 'provision',
        created_at: now,
        updated_at: now,
      },
    ],
    // The home binding create_studio writes: this agent's participant row
    // names the creator's session.
    inbox_thread_participants: [{ thread_id: 'thread', agent_id: 'lumen', session_id: OWN }],
    studio_lease_events: [],
  };
  const creator = {
    id: OWN,
    userId: USER,
    sbId: SB,
    agentId: 'lumen',
    studioId: 'creator-original-studio',
    threadKey: 'thread:original',
    endedAt: null,
    status: 'active',
  };
  const repo = {
    findById: vi.fn(async (id: string) => (id === OWN ? creator : null)),
    findByThreadKey: vi.fn(async () => null),
    create: vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      id: 'new-session',
      metadata: input.metadata ?? {},
    })),
    update: vi.fn(async (id: string, input: Record<string, unknown>) => ({ id, ...input })),
  };
  const overflow = vi
    .spyOn(StudioOverflowService.prototype, 'ensureOverflowStudio')
    .mockResolvedValue(null);
  const service = new SessionService(
    repo as never,
    { getAgentBackend: vi.fn(async () => ({ backend: 'claude', provider: null })) } as never,
    { run: vi.fn() } as never,
    { logActivity: vi.fn() } as never,
    { defaultWorkingDirectory: '/test', mcpConfigPath: '/test/.mcp.json' },
    undefined,
    makeFakeSupabase(tables) as never
  );
  return { service, repo, overflow, tables };
}

describe('a thread bound to its creator resolves to the creator (studio-model piece 1)', () => {
  it.each([true, false])(
    'with the participant stamp as the recipient hint, planOnly=%s lands on the creator and mints nothing',
    async (planOnly) => {
      const { service, repo, overflow, tables } = fixture();
      // What the dispatcher now passes: the recipient session read from the stamp.
      const result = await service.getOrCreateSession(USER, 'lumen', {
        threadKey: 'pr:probe',
        recipientSessionId: OWN,
        planOnly,
      });
      expect(result.id).toBe(OWN);
      expect(repo.create).not.toHaveBeenCalled();
      expect(overflow).not.toHaveBeenCalled();
      // The creator still holds the studio; nothing was diverted or reclaimed.
      expect(tables.studios[0].lease.sessionId).toBe(OWN);
      overflow.mockRestore();
    }
  );

  it('without the hint the old behaviour is exactly the defect: a fresh session in the new studio', async () => {
    const { service, repo, overflow } = fixture();
    const result = await service.getOrCreateSession(USER, 'lumen', {
      threadKey: 'pr:probe',
      planOnly: true,
    });
    expect(result.id).toBe('new-session');
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ studioId: STUDIO }));
    overflow.mockRestore();
  });
});
