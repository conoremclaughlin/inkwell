import { describe, it, expect, vi } from 'vitest';
import { SessionService } from './session-service.js';
import { SessionRepository } from './session-repository.js';
import { makeFakeSupabase, type Row } from './fake-supabase.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * The home rung's routing boundaries, run through the REAL service and the
 * REAL repository over the shared table-backed fake — no runner, no server.
 *
 * The four "boundary" cases are Lumen's regression probes from PR #680
 * round 1 (/tmp/lumen-pr680-review, 2026-09-25), carried into the suite so
 * they stay red on 0c56ecb2 and green after. Each names a caller the home
 * rung must not steal from:
 *   - a request that addressed a studio, by id or by slug hint;
 *   - an ambiguous slug (two workspaces, no canonical identity);
 *   - a newer failed `task` session sitting in front of the primary home.
 * The four controls pin what the rung is for.
 */
const USER = 'user-example';
const SB = 'sb-example';
const SLUG = 'bridge-example';

function identity(extra: Row = {}): Row {
  return {
    id: SB,
    user_id: USER,
    agent_id: SLUG,
    workspace_id: 'workspace-example',
    default_session_id: 'home-example',
    metadata: { bridge: true },
    ...extra,
  };
}

function session(extra: Row = {}): Row {
  return {
    id: 'home-example',
    user_id: USER,
    agent_id: SLUG,
    sb_id: SB,
    studio_id: null,
    thread_key: null,
    contact_id: null,
    lifecycle: 'idle',
    ended_at: null,
    started_at: '2026-01-01T00:00:00Z',
    metadata: { type: 'primary' },
    ...extra,
  };
}

function harness(tables: Record<string, Row[]>) {
  const db = makeFakeSupabase(tables);
  const repo = new SessionRepository(db as never);
  const create = vi.spyOn(repo, 'create').mockImplementation(async (data) => ({
    ...data,
    id: 'created-example',
    startedAt: new Date(),
    lastActivityAt: new Date(),
  }));
  const run = vi.fn(() => {
    throw new Error('No executor is allowed in these routing probes');
  });
  const service = new SessionService(
    repo,
    { getAgentBackend: vi.fn(async () => ({ backend: 'ink', provider: null })) } as never,
    { run } as never,
    {} as never,
    { defaultWorkingDirectory: '/tmp', mcpConfigPath: '/tmp/example-mcp.json' },
    { run } as never,
    db as never
  );
  return { service, create };
}

describe('home rung — boundaries it must not cross', () => {
  for (const option of ['studioId', 'studioHint'] as const) {
    it(`honours a caller's ${option} instead of redirecting into a home in another studio`, async () => {
      const { service, create } = harness({
        agent_identities: [identity()],
        sessions: [
          session(),
          session({ id: 'studio-session-example', studio_id: 'studio-example' }),
        ],
        studios: [
          {
            id: 'studio-example',
            user_id: USER,
            sb_id: SB,
            agent_id: SLUG,
            slug: 'work-example',
            status: 'active',
          },
        ],
      });

      const found = await service.getOrCreateSession(USER, SLUG, {
        [option]: option === 'studioId' ? 'studio-example' : 'work-example',
      });

      expect(found.id).toBe('studio-session-example');
      expect(create).not.toHaveBeenCalled();
    });
  }

  it('does not choose a sibling workspace’s default when the slug is ambiguous', async () => {
    const { service } = harness({
      agent_identities: [
        identity(),
        identity({ id: 'sb-other-example', workspace_id: 'workspace-other-example' }),
      ],
      sessions: [session()],
    });

    const found = await service.getOrCreateSession(USER, SLUG, {});

    expect(found.id).not.toBe('home-example');
    expect(found.sbId).toBeUndefined();
  });

  it('a newer failed task session does not mask a reusable primary home', async () => {
    const { service, create } = harness({
      agent_identities: [identity({ default_session_id: null })],
      sessions: [
        session(),
        session({
          id: 'failed-task-example',
          lifecycle: 'failed',
          started_at: '2026-01-02T00:00:00Z',
          metadata: { type: 'task' },
        }),
      ],
    });

    const found = await service.getOrCreateSession(USER, SLUG, {});

    expect(found.id).toBe('home-example');
    expect(create).not.toHaveBeenCalled();
  });

  it('a default session that belongs to another identity is not a home', async () => {
    const { service } = harness({
      agent_identities: [identity()],
      sessions: [session({ sb_id: 'sb-someone-else' })],
    });

    const found = await service.getOrCreateSession(USER, SLUG, {});

    expect(found.id).not.toBe('home-example');
  });
});

describe('home rung — what it is for', () => {
  it('chooses the pinned default over a newer twin', async () => {
    const { service } = harness({
      agent_identities: [identity()],
      sessions: [
        session(),
        session({ id: 'newer-home-example', started_at: '2026-01-02T00:00:00Z' }),
      ],
    });
    expect((await service.getOrCreateSession(USER, SLUG, {})).id).toBe('home-example');
  });

  it('reuses an unended failed primary', async () => {
    const { service } = harness({
      agent_identities: [identity({ default_session_id: null })],
      sessions: [session({ lifecycle: 'failed' })],
    });
    expect((await service.getOrCreateSession(USER, SLUG, {})).id).toBe('home-example');
  });

  it('keeps a contact out of the owner default', async () => {
    const { service } = harness({
      agent_identities: [identity()],
      sessions: [session(), session({ id: 'contact-home-example', contact_id: 'contact-example' })],
    });
    expect(
      (await service.getOrCreateSession(USER, SLUG, { contactId: 'contact-example' })).id
    ).toBe('contact-home-example');
  });

  it('an explicit recipient still wins over the default', async () => {
    const { service } = harness({
      agent_identities: [identity()],
      sessions: [session(), session({ id: 'recipient-example' })],
    });
    expect(
      (await service.getOrCreateSession(USER, SLUG, { recipientSessionId: 'recipient-example' })).id
    ).toBe('recipient-example');
  });

  it('a home in the studio the caller addressed is still the home', async () => {
    const { service, create } = harness({
      agent_identities: [identity()],
      sessions: [session({ studio_id: 'studio-example' })],
      studios: [
        {
          id: 'studio-example',
          user_id: USER,
          sb_id: SB,
          agent_id: SLUG,
          slug: 'work-example',
          status: 'active',
        },
      ],
    });
    const found = await service.getOrCreateSession(USER, SLUG, { studioId: 'studio-example' });
    expect(found.id).toBe('home-example');
    expect(create).not.toHaveBeenCalled();
  });
});
