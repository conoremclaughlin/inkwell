/**
 * Session current-work integration tests (real Supabase)
 *
 * `sessions.context` already held real operational state and nothing surfaced
 * it. These drive the REAL write path (update_session_state) and the REAL read
 * paths (list_sessions, get_session) against the REAL database, so the writer
 * and the readers have to agree about the columns. Asserting each against my
 * own model of it would stay green even if the handler stamped a timestamp no
 * reader selects.
 *
 * Run via: yarn workspace @inklabs/api test:integration:db
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';
import { handleUpdateSessionState, handleListSessions, handleGetSession } from './memory-handlers';

function parse<T>(raw: { content: Array<{ text: string }> }): T {
  return JSON.parse(raw.content[0].text) as T;
}

interface SessionView {
  id: string;
  currentWork: string | null;
  currentWorkSource: string | null;
  currentWorkAt: string | null;
  currentWorkAgeLabel: string | null;
  currentWorkTruncated: boolean;
}

describe('Session current work (integration)', () => {
  let dataComposer: DataComposer;
  let userId: string;
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
  });

  afterEach(async () => {
    if (createdSessionIds.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = dataComposer.getClient() as any;
    await raw.from('sessions').delete().in('id', createdSessionIds);
    createdSessionIds.length = 0;
  });

  async function createSession(fields: Record<string, unknown> = {}): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = dataComposer.getClient() as any;
    const { data, error } = await raw
      .from('sessions')
      .insert({
        user_id: userId,
        agent_id: 'echo',
        lifecycle: 'running',
        started_at: new Date().toISOString(),
        ...fields,
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`session insert: ${error?.message}`);
    createdSessionIds.push(data.id);
    return data.id;
  }

  async function findInList(sessionId: string): Promise<SessionView | undefined> {
    const listed = parse<{ sessions: SessionView[] }>(
      await handleListSessions({ userId, limit: 100 }, dataComposer)
    );
    return listed.sessions.find((s) => s.id === sessionId);
  }

  /**
   * Update, and assert the write was actually accepted.
   *
   * update_session_state answers a refused call with `success: false` rather
   * than throwing. Without this check a rejected write looks exactly like a
   * read that lost the value — which is precisely what happened here: the
   * "at least one field" guard did not list `headline`, so headline-only calls
   * were refused and the failure presented as a display bug.
   */
  async function update(fields: Record<string, unknown>): Promise<void> {
    const result = parse<{ success: boolean; error?: string }>(
      await handleUpdateSessionState({ userId, ...fields }, dataComposer)
    );
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
  }

  it('a headline written through update_session_state appears in list_sessions with its age', async () => {
    const sessionId = await createSession();

    await update({ sessionId, headline: 'Reviewing PR #641 — thread titles' });

    const row = await findInList(sessionId);
    expect(row?.currentWork).toBe('Reviewing PR #641 — thread titles');
    expect(row?.currentWorkSource).toBe('headline');
    // The stamp is written by the handler and read back by the list — if either
    // side used a different column this is where it shows.
    expect(row?.currentWorkAt).not.toBeNull();
    expect(row?.currentWorkAgeLabel).toBe('just now');
  });

  it('get_session shows the same current work as list_sessions', async () => {
    const sessionId = await createSession();
    await update({ sessionId, headline: 'Same on both' });

    const listed = await findInList(sessionId);
    const fetched = parse<{ session: SessionView }>(
      await handleGetSession({ userId, sessionId }, dataComposer)
    );

    // Two readers tested against EACH OTHER, not against my expectation of
    // each: separate assertions cannot detect a disagreement between them.
    expect(fetched.session.currentWork).toBe(listed?.currentWork);
    expect(fetched.session.currentWorkSource).toBe(listed?.currentWorkSource);
  });

  it('falls back to the context, truncated, when no headline was ever written', async () => {
    const long =
      'Investigating the trigger routing gap across studios, ' +
      'with an isolated server on 4001 and vitest watching, '.repeat(6);
    const sessionId = await createSession();

    await update({ sessionId, context: long });

    const row = await findInList(sessionId);
    expect(row?.currentWorkSource).toBe('context');
    expect(row?.currentWorkTruncated).toBe(true);
    expect(row?.currentWork!.endsWith('…')).toBe(true);
    // context_updated_at is stamped on the context write, so the fallback has
    // an age too — the point being that no displayed text is ever ageless.
    expect(row?.currentWorkAgeLabel).toBe('just now');
  });

  it('a context written before this feature has no age, and does not claim one', async () => {
    // The pre-existing row shape: context present, context_updated_at NULL.
    const sessionId = await createSession({
      context: 'Round five at head ead13bea',
      context_updated_at: null,
    });

    const row = await findInList(sessionId);
    expect(row?.currentWork).toBe('Round five at head ead13bea');
    // Unknown must not render as recent. This is the 15 Sep near-miss in a test.
    expect(row?.currentWorkAgeLabel).toBeNull();
    expect(row?.currentWorkAt).toBeNull();
  });

  it('a headline supersedes the context once written', async () => {
    const sessionId = await createSession();
    await update({ sessionId, context: 'Long scratch board note about several things' });
    await update({ sessionId, headline: 'One line' });

    const row = await findInList(sessionId);
    expect(row?.currentWork).toBe('One line');
    expect(row?.currentWorkSource).toBe('headline');
  });

  it('refuses a headline over the bound', async () => {
    const sessionId = await createSession();

    await expect(
      handleUpdateSessionState({ userId, sessionId, headline: 'x'.repeat(121) }, dataComposer)
    ).rejects.toThrow();

    // Control: exactly at the bound is accepted, so the test above cannot pass
    // against a handler that rejects every headline.
    await update({ sessionId, headline: 'x'.repeat(120) });
    const row = await findInList(sessionId);
    expect(row?.currentWork).toBe('x'.repeat(120));
  });

  it('says nothing for a session that has said nothing', async () => {
    const sessionId = await createSession();

    const row = await findInList(sessionId);
    expect(row?.currentWork).toBeNull();
    expect(row?.currentWorkSource).toBeNull();
  });
});
