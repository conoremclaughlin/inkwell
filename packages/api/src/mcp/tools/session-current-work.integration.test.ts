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
import {
  handleUpdateSessionState,
  handleListSessions,
  handleGetSession,
  handleBootstrap,
} from './memory-handlers';
import { runWithRequestContext } from '../../utils/request-context';
import { resolveCallerIdentity, isSessionAuthorized } from './caller-identity';

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

  /**
   * Cross-contact scope, through the real handlers.
   *
   * One SB identity serves many contacts, and every session read here selects
   * on user + slug, which is not an identity. So the row beside yours can be
   * the same SB talking to a different person. `isSessionAuthorized` already
   * knew that — it is why get_session withholds logs — but the current-work
   * fields were spread in beside that check rather than behind it, and a
   * truncated scratch board is still a scratch board.
   *
   * These assert on the SERIALIZED response, not on a field name. A gate that
   * merely renamed the key would pass a `currentWork` assertion.
   */
  describe('another contact of the same SB', () => {
    const PRIVATE_NOTE = 'Sentinel zebra: drafting the reply about Tuesday';
    // Two invented people, fixed synthetic UUIDs. `sessions.contact_id` carries
    // a foreign key, so these need rows; nothing here comes from a live contact.
    const CONTACT_A = '11111111-2222-3333-4444-555555550001';
    const CONTACT_B = '11111111-2222-3333-4444-555555550002';

    beforeAll(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = dataComposer.getClient() as any;
      const { error } = await raw.from('contacts').upsert(
        [
          { id: CONTACT_A, user_id: userId, name: 'Fixture Contact A', email: 'a@example.com' },
          { id: CONTACT_B, user_id: userId, name: 'Fixture Contact B', email: 'b@example.com' },
        ],
        { onConflict: 'id' }
      );
      if (error) throw new Error(`contact fixture: ${error.message}`);
    });

    /**
     * Run as an agent-bound caller scoped to `contactId`.
     *
     * Uses the signed-claim branch of `resolveCallerIdentity` — `tokenSlug` and
     * `tokenContactId`, the fields it documents as the only authentication
     * facts — rather than the stdio pin, so this exercises the same code path a
     * real agent's bearer token takes.
     */
    async function asContact<T>(contactId: string, run: () => Promise<T>): Promise<T> {
      return (await runWithRequestContext(
        { userId, agentTokenBound: true, tokenSlug: 'echo', tokenContactId: contactId },
        run
      )) as T;
    }

    it('the caller really is agent-bound and contact-scoped', async () => {
      // Control for every test below. If this binding silently failed, the
      // caller would fall through to the same-user repair path, every session
      // would be authorized, and the four suppression tests would pass by
      // testing nothing at all.
      const foreignId = await createSession({ contact_id: CONTACT_B });
      const target = await dataComposer.repositories.memory.getSession(foreignId);

      await asContact(CONTACT_A, async () => {
        const caller = resolveCallerIdentity('echo');
        expect(caller.agentBound).toBe(true);
        expect(caller.contactId).toBe(CONTACT_A);
        expect(isSessionAuthorized(target!, userId, caller)).toBe(false);
      });

      // ...and authorized for its own contact, so the gate turns on scope
      // rather than refusing everything.
      await asContact(CONTACT_B, async () => {
        expect(isSessionAuthorized(target!, userId, resolveCallerIdentity('echo'))).toBe(true);
      });
    });

    it('list_sessions withholds the other contact’s context and its fallback', async () => {
      const foreignId = await createSession({ contact_id: CONTACT_B, context: PRIVATE_NOTE });

      const raw = await asContact(CONTACT_A, () =>
        handleListSessions({ userId, sbSlug: 'echo', limit: 100 }, dataComposer)
      );

      expect(raw.content[0].text).not.toContain('Sentinel zebra');
      const row = parse<{ sessions: SessionView[] }>(raw).sessions.find((s) => s.id === foreignId);
      expect(row?.currentWork).toBeNull();
    });

    it('get_session withholds the OWNER’s context from a contact-scoped agent', async () => {
      // The sharpest version of this path, and the one `getActiveSession`
      // actually produces: it scopes to `contact_id IS NULL`, so the row a
      // contact-bound caller gets back here is the account owner's own session.
      // An SB talking to an outside contact asking "what is echo up to" was
      // being handed the owner's private scratch board.
      const ownerSessionId = await createSession({ contact_id: null, context: PRIVATE_NOTE });

      const raw = await asContact(CONTACT_A, () =>
        handleGetSession({ userId, sbSlug: 'echo' }, dataComposer)
      );

      // Assert WHICH session came back first. Without this, a null session or
      // some unrelated row would make the sentinel absent for reasons that have
      // nothing to do with the gate, and the test would pass against the bug.
      const { session } = parse<{ session: SessionView }>(raw);
      expect(session).not.toBeNull();
      expect(session.id).toBe(ownerSessionId);
      expect(raw.content[0].text).not.toContain('Sentinel zebra');
    });

    it('bootstrap withholds it from the active-sessions list', async () => {
      await createSession({ contact_id: CONTACT_B, context: PRIVATE_NOTE });

      const raw = await asContact(CONTACT_A, () =>
        handleBootstrap({ userId, sbSlug: 'echo', includeMemories: false }, dataComposer)
      );

      expect(raw.content[0].text).not.toContain('Sentinel zebra');
    });

    it('still publishes the other contact’s headline', async () => {
      // The control that keeps the three above honest. Suppressing everything
      // cross-contact would pass them all while deleting peer status entirely,
      // which is the feature. A headline is written to be read by someone else.
      const foreignId = await createSession({
        contact_id: CONTACT_B,
        context: PRIVATE_NOTE,
        headline: 'Reviewing PR #652',
        headline_updated_at: new Date().toISOString(),
      });

      const raw = await asContact(CONTACT_A, () =>
        handleListSessions({ userId, sbSlug: 'echo', limit: 100 }, dataComposer)
      );

      expect(raw.content[0].text).not.toContain('Sentinel zebra');
      const row = parse<{ sessions: SessionView[] }>(raw).sessions.find((s) => s.id === foreignId);
      expect(row?.currentWork).toBe('Reviewing PR #652');
      expect(row?.currentWorkSource).toBe('headline');
      expect(row?.currentWorkAgeLabel).toBe('just now');
    });

    it('shows the same row in full to its own contact', async () => {
      // The second half of the control: the gate turns on the audience and
      // nothing else. Same row, same instant, the contact it belongs to.
      const ownId = await createSession({ contact_id: CONTACT_B, context: PRIVATE_NOTE });

      const raw = await asContact(CONTACT_B, () =>
        handleListSessions({ userId, sbSlug: 'echo', limit: 100 }, dataComposer)
      );

      expect(raw.content[0].text).toContain('Sentinel zebra');
      const row = parse<{ sessions: SessionView[] }>(raw).sessions.find((s) => s.id === ownId);
      expect(row?.currentWork).toBe(PRIVATE_NOTE);
      expect(row?.currentWorkSource).toBe('context');
    });
  });
});
