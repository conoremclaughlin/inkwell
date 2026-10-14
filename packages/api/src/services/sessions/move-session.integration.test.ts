/**
 * A session moves to the studio it works in (spec automated-turn-permissions
 * §3.6; task 7658c2e6), against the real database. Pinned:
 *   - only the caller's own session moves, to a studio of the same user and
 *     SB, and its row then names that studio and its worktree, which is
 *     where the next spawn runs (resolveWorkingDirectory reads the row);
 *   - a headless session gets its continuation queued; an attached one
 *     gets the relaunch command and nothing is sent;
 *   - another SB's studio, and any move out of a reviewer studio, refuse
 *     and leave the row as it was.
 *
 * Run via: yarn workspace @inklabs/api test:integration:db
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { getDataComposer, type DataComposer } from '../../data/composer';
import {
  ensureEchoIntegrationFixture,
  ensureSuiteIdentity,
  type EchoIntegrationFixture,
} from '../../test/integration-fixtures';
import { runWithRequestContext } from '../../utils/request-context';
import { resolveCallerIdentity } from '../../mcp/tools/caller-identity';
import { moveSessionToStudio } from './move-session';

describe('moveSessionToStudio', () => {
  let composer: DataComposer;
  let fixture: EchoIntegrationFixture;
  let alphaId: string;
  let betaId: string;
  const studioIds: string[] = [];
  const sessionIds: string[] = [];
  const sent: Array<Record<string, unknown>> = [];

  async function insertStudio(row: {
    sbId: string;
    slug: string;
    roleTemplate?: string;
  }): Promise<{ id: string; worktreePath: string }> {
    const id = randomUUID();
    const worktreePath = `/tmp/mv-fixture/${row.slug}-${id.slice(0, 8)}`;
    const { error } = await composer
      .getClient()
      .from('studios')
      .insert({
        id,
        user_id: fixture.userId,
        agent_id: row.sbId === alphaId ? 'mv-alpha' : 'mv-beta',
        sb_id: row.sbId,
        slug: `${row.slug}-${id.slice(0, 8)}`,
        repo_root: '/tmp/mv-fixture/repo',
        worktree_path: worktreePath,
        branch: `mv/${row.slug}-${id.slice(0, 8)}`,
        ...(row.roleTemplate ? { role_template: row.roleTemplate } : {}),
      } as never);
    if (error) throw new Error(`studio insert failed: ${error.message}`);
    studioIds.push(id);
    return { id, worktreePath };
  }

  async function insertSession(row: {
    sbId: string;
    studioId: string;
    cliAttached: boolean;
  }): Promise<string> {
    const id = randomUUID();
    const { error } = await composer
      .getClient()
      .from('sessions')
      .insert({
        id,
        user_id: fixture.userId,
        agent_id: row.sbId === alphaId ? 'mv-alpha' : 'mv-beta',
        sb_id: row.sbId,
        studio_id: row.studioId,
        cli_attached: row.cliAttached,
        status: 'active',
      } as never);
    if (error) throw new Error(`session insert failed: ${error.message}`);
    sessionIds.push(id);
    return id;
  }

  async function rowOf(sessionId: string) {
    const { data } = await composer
      .getClient()
      .from('sessions')
      .select('studio_id, working_dir')
      .eq('id', sessionId)
      .single();
    return data as { studio_id: string | null; working_dir: string | null };
  }

  /** Run as alpha's runner, its token signed for `sessionId`. */
  const asRunner = <T>(sessionId: string, sbId: string, slug: string, fn: () => Promise<T>) =>
    runWithRequestContext(
      {
        userId: fixture.userId,
        agentTokenBound: true,
        tokenSlug: slug,
        tokenSbId: sbId,
        tokenSessionId: sessionId,
      },
      fn
    );

  const move = (sessionId: string, targetStudioId: string, sbId = alphaId, slug = 'mv-alpha') =>
    asRunner(sessionId, sbId, slug, () =>
      moveSessionToStudio(
        composer,
        { userId: fixture.userId, caller: resolveCallerIdentity(slug), targetStudioId },
        {
          sendResume: async (args) => {
            sent.push(args);
          },
        }
      )
    );

  beforeAll(async () => {
    composer = await getDataComposer();
    fixture = await ensureEchoIntegrationFixture(composer);
    alphaId = await ensureSuiteIdentity(composer, fixture, 'mv-alpha');
    betaId = await ensureSuiteIdentity(composer, fixture, 'mv-beta');
  });

  beforeEach(() => {
    sent.length = 0;
  });

  afterAll(async () => {
    const client = composer.getClient();
    if (sessionIds.length) await client.from('session_logs').delete().in('session_id', sessionIds);
    if (sessionIds.length) await client.from('sessions').delete().in('id', sessionIds);
    if (studioIds.length) await client.from('studios').delete().in('id', studioIds);
    await client.from('agent_identities').delete().in('id', [alphaId, betaId]);
  });

  it("a headless session moves to its SB's studio, and its next turn is queued there", async () => {
    const from = await insertStudio({ sbId: alphaId, slug: 'from' });
    const to = await insertStudio({ sbId: alphaId, slug: 'to' });
    const session = await insertSession({ sbId: alphaId, studioId: from.id, cliAttached: false });

    const result = await move(session, to.id);

    expect(result).toMatchObject({
      ok: true,
      sessionId: session,
      fromStudioId: from.id,
      toStudioId: to.id,
      resumeQueued: true,
    });
    expect(await rowOf(session)).toEqual({ studio_id: to.id, working_dir: to.worktreePath });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      recipientSessionId: session,
      messageType: 'session_resume',
      metadata: { fromStudioId: from.id, toStudioId: to.id },
    });
  });

  it('an attached session is given the relaunch command, and nothing is sent', async () => {
    const from = await insertStudio({ sbId: alphaId, slug: 'att-from' });
    const to = await insertStudio({ sbId: alphaId, slug: 'att-to' });
    const session = await insertSession({ sbId: alphaId, studioId: from.id, cliAttached: true });

    const result = await move(session, to.id);

    expect(result).toMatchObject({ ok: true, resumeQueued: false });
    expect((result as { relaunch?: string }).relaunch).toContain(`cd ${to.worktreePath}`);
    expect(sent).toEqual([]);
  });

  it("another SB's studio is refused, and the row is unchanged", async () => {
    const from = await insertStudio({ sbId: alphaId, slug: 'own' });
    const theirs = await insertStudio({ sbId: betaId, slug: 'theirs' });
    const session = await insertSession({ sbId: alphaId, studioId: from.id, cliAttached: false });

    const result = await move(session, theirs.id);

    expect(result).toEqual({ ok: false, error: expect.stringContaining('another SB') });
    expect((await rowOf(session)).studio_id).toBe(from.id);
    expect(sent).toEqual([]);
  });

  it('a session in a reviewer studio cannot move out: a move cannot shed reviewer denies', async () => {
    const review = await insertStudio({ sbId: alphaId, slug: 'review', roleTemplate: 'reviewer' });
    const builder = await insertStudio({ sbId: alphaId, slug: 'builder' });
    const session = await insertSession({ sbId: alphaId, studioId: review.id, cliAttached: false });

    const result = await move(session, builder.id);

    expect(result).toEqual({ ok: false, error: expect.stringContaining('reviewer') });
    expect((await rowOf(session)).studio_id).toBe(review.id);
  });

  it('moving into a reviewer studio is allowed: it only adds restrictions', async () => {
    const builder = await insertStudio({ sbId: alphaId, slug: 'b2' });
    const review = await insertStudio({ sbId: alphaId, slug: 'r2', roleTemplate: 'reviewer' });
    const session = await insertSession({
      sbId: alphaId,
      studioId: builder.id,
      cliAttached: false,
    });

    expect(await move(session, review.id)).toMatchObject({ ok: true, toStudioId: review.id });
  });

  it("a token signed for another SB's session moves nothing", async () => {
    const from = await insertStudio({ sbId: betaId, slug: 'beta-from' });
    const to = await insertStudio({ sbId: alphaId, slug: 'alpha-to' });
    const betaSession = await insertSession({
      sbId: betaId,
      studioId: from.id,
      cliAttached: false,
    });

    // Alpha's identity, presenting beta's session: not alpha's to move.
    const result = await move(betaSession, to.id, alphaId, 'mv-alpha');

    expect(result.ok).toBe(false);
    expect((await rowOf(betaSession)).studio_id).toBe(from.id);
  });
});
