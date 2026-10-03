/**
 * Owner lookups match only owner sessions (task F1, session lifecycle v6 §6).
 *
 * One SB identity serves its owner and, separately, per-sender contacts. A
 * contact session can carry the same thread key or session key as an owner
 * session. `findByThreadKey` filtered on the contact only when one was passed,
 * and `findByAlias` never filtered on it, so an owner lookup could resolve the
 * contact's session. Runs against the local database so the PostgREST filters
 * are exercised for real; the unit tests only check the query shape.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { SessionRepository } from './session-repository';
import {
  ensureEchoIntegrationFixture,
  ensureSuiteIdentity,
  INTEGRATION_TEST_USER_ID,
} from '../../test/integration-fixtures';

/** Suite-owned identity: rows here stay invisible to every `echo` query. */
const SUITE_AGENT = 'echo-contact-scope';
/** An invented person with a fixed synthetic UUID; nothing here is a live contact. */
const CONTACT_ID = '11111111-2222-3333-4444-555555550101';

describe('session lookups keep owner and contact scopes apart', () => {
  let dataComposer: DataComposer;
  let repo: SessionRepository;
  let suiteSbId: string | undefined;
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    suiteSbId = await ensureSuiteIdentity(dataComposer, fixture, SUITE_AGENT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = dataComposer.getClient() as any;
    const { error } = await raw.from('contacts').upsert(
      [
        {
          id: CONTACT_ID,
          user_id: INTEGRATION_TEST_USER_ID,
          name: 'Fixture Contact Scope',
          email: 'scope@example.com',
        },
      ],
      { onConflict: 'id' }
    );
    if (error) throw new Error(`contact fixture: ${error.message}`);
    repo = new SessionRepository(dataComposer.getClient());
  });

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = dataComposer.getClient() as any;
    if (createdSessionIds.length > 0) {
      await raw.from('sessions').delete().in('id', createdSessionIds);
    }
    await raw
      .from('sessions')
      .delete()
      .eq('user_id', INTEGRATION_TEST_USER_ID)
      .eq('agent_id', SUITE_AGENT);
    await raw.from('contacts').delete().eq('id', CONTACT_ID);
    if (suiteSbId) await raw.from('agent_identities').delete().eq('id', suiteSbId);
  });

  async function createSession(fields: Record<string, unknown>): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = dataComposer.getClient() as any;
    const { data, error } = await raw
      .from('sessions')
      .insert({
        user_id: INTEGRATION_TEST_USER_ID,
        agent_id: SUITE_AGENT,
        sb_id: suiteSbId,
        lifecycle: 'idle',
        started_at: new Date().toISOString(),
        ...fields,
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`session insert: ${error?.message}`);
    createdSessionIds.push(data.id);
    return data.id;
  }

  /** A key no other test or file uses, so parallel files never see these rows. */
  const uniqueThreadKey = () => `thread:contact-scope-${randomUUID()}`;
  const uniqueSessionKey = () => `itest:contact-scope:${randomUUID().slice(0, 8)}`;

  it('an owner thread-key lookup returns the owner session, not the contact one', async () => {
    const threadKey = uniqueThreadKey();
    // The contact session is the newer of the two, so a lookup that ignored
    // the contact scope would pick it under started_at DESC.
    const ownerSession = await createSession({
      thread_key: threadKey,
      started_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const contactSession = await createSession({ thread_key: threadKey, contact_id: CONTACT_ID });

    const owner = await repo.findByThreadKey(
      INTEGRATION_TEST_USER_ID,
      SUITE_AGENT,
      threadKey,
      undefined,
      undefined,
      suiteSbId
    );
    const contact = await repo.findByThreadKey(
      INTEGRATION_TEST_USER_ID,
      SUITE_AGENT,
      threadKey,
      undefined,
      CONTACT_ID,
      suiteSbId
    );

    expect(owner?.id).toBe(ownerSession);
    expect(contact?.id).toBe(contactSession);
  });

  it('an owner thread-key lookup finds nothing when only a contact session holds the key', async () => {
    const threadKey = uniqueThreadKey();
    await createSession({ thread_key: threadKey, contact_id: CONTACT_ID });

    const owner = await repo.findByThreadKey(
      INTEGRATION_TEST_USER_ID,
      SUITE_AGENT,
      threadKey,
      undefined,
      undefined,
      suiteSbId
    );

    expect(owner).toBeNull();
  });

  it('an owner session-key lookup never resolves a contact session carrying the key', async () => {
    const sessionKey = uniqueSessionKey();
    await createSession({ alias: sessionKey, contact_id: CONTACT_ID });

    const owner = await repo.findByAlias(
      INTEGRATION_TEST_USER_ID,
      SUITE_AGENT,
      sessionKey,
      undefined,
      suiteSbId
    );

    expect(owner).toBeNull();
  });

  it('a contact session-key lookup resolves that contact session', async () => {
    const sessionKey = uniqueSessionKey();
    const contactSession = await createSession({ alias: sessionKey, contact_id: CONTACT_ID });

    const contact = await repo.findByAlias(
      INTEGRATION_TEST_USER_ID,
      SUITE_AGENT,
      sessionKey,
      undefined,
      suiteSbId,
      CONTACT_ID
    );

    expect(contact?.id).toBe(contactSession);
  });
});
