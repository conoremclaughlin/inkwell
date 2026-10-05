/**
 * Caller-named sessions against a real database (task T4, session lifecycle
 * v7 §3 rungs 1–2), through the real send handler and start_session.
 *
 * A wrong address refuses the send and stores nothing: no thread, no
 * message, no inbox row. A key resolves to the id it names, and the result
 * echoes it. An ended session named by id is admitted and reported as
 * reopening. A backend transcript is never reused or duplicated across a
 * contact scope. The unit suites prove the rules over fakes; only the
 * database shows the queries find what they claim.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { handleSendToInbox } from '../../mcp/tools/inbox-handlers';
import { handleStartSession } from '../../mcp/tools/memory-handlers';
import { SYSTEM_PRINCIPAL } from '../principals';
import {
  ensureEchoIntegrationFixture,
  ensureSuiteIdentity,
  INTEGRATION_TEST_USER_ID,
  type EchoIntegrationFixture,
} from '../../test/integration-fixtures';

/** Suite-owned identity: rows here stay invisible to every `echo` query. */
const SUITE_AGENT = 'echo-explicit-address';
/** An invented person with a fixed synthetic UUID; nothing here is a live contact. */
const CONTACT_ID = '11111111-2222-3333-4444-555555550202';
const RUN = Math.random().toString(36).slice(2, 8);
const LIVE_KEY = `echo-explicit-address:test:live-${RUN}`;

describe('caller-named sessions are checked before anything is stored', () => {
  let dataComposer: DataComposer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any;
  let fixture: EchoIntegrationFixture;
  let suiteSbId: string;
  let liveId: string;
  let endedId: string;
  let contactSessionId: string;
  let echoSessionId: string;

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    raw = dataComposer.getClient();
    fixture = await ensureEchoIntegrationFixture(dataComposer);
    suiteSbId = await ensureSuiteIdentity(dataComposer, fixture, SUITE_AGENT);
    const { error } = await raw.from('contacts').upsert(
      [
        {
          id: CONTACT_ID,
          user_id: INTEGRATION_TEST_USER_ID,
          name: 'Fixture Explicit Address',
          email: 'explicit-address@example.com',
        },
      ],
      { onConflict: 'id' }
    );
    if (error) throw new Error(`contact fixture: ${error.message}`);

    liveId = await createSession({ alias: LIVE_KEY });
    endedId = await createSession({
      ended_at: new Date().toISOString(),
      lifecycle: 'completed',
      status: 'completed',
    });
    contactSessionId = await createSession({ contact_id: CONTACT_ID });
    echoSessionId = await createSession({ agent_id: 'echo', sb_id: fixture.echoSbId });
  });

  afterAll(async () => {
    await raw
      .from('inbox_threads')
      .delete()
      .eq('workspace_id', fixture.workspaceId)
      .like('thread_key', `test:explicit-address-${RUN}%`);
    await raw.from('agent_inbox').delete().like('content', `explicit-address ${RUN}%`);
    await raw.from('sessions').delete().eq('id', echoSessionId);
    await raw
      .from('sessions')
      .delete()
      .eq('user_id', INTEGRATION_TEST_USER_ID)
      .eq('agent_id', SUITE_AGENT);
    await raw.from('contacts').delete().eq('id', CONTACT_ID);
    await raw.from('agent_identities').delete().eq('id', suiteSbId);
  });

  async function createSession(fields: Record<string, unknown>): Promise<string> {
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
    if (error) throw new Error(`session fixture: ${error.message}`);
    return data.id as string;
  }

  /** A system send on its own thread, with no wake, as reminders will send. */
  function send(name: string, address: Record<string, unknown>) {
    return handleSendToInbox(
      {
        userId: INTEGRATION_TEST_USER_ID,
        recipientSlug: SUITE_AGENT,
        threadKey: `test:explicit-address-${RUN}-${name}`,
        content: `explicit-address ${RUN} ${name}`,
        trigger: false,
        ...address,
      },
      dataComposer,
      { sender: { principal: SYSTEM_PRINCIPAL, workspaceId: fixture.workspaceId } }
    );
  }

  async function threadExists(name: string): Promise<boolean> {
    const { data } = await raw
      .from('inbox_threads')
      .select('id')
      .eq('workspace_id', fixture.workspaceId)
      .eq('thread_key', `test:explicit-address-${RUN}-${name}`);
    return (data ?? []).length > 0;
  }

  it('refuses a made-up session id and creates no thread', async () => {
    await expect(send('made-up', { recipientSessionId: randomUUID() })).rejects.toThrow(
      /is not a session of "echo-explicit-address"\. Nothing was sent\./
    );
    expect(await threadExists('made-up')).toBe(false);
  });

  it("refuses another identity's session", async () => {
    await expect(send('other-identity', { recipientSessionId: echoSessionId })).rejects.toThrow(
      /is not a session of/
    );
    expect(await threadExists('other-identity')).toBe(false);
  });

  it("refuses the recipient's own per-sender contact session", async () => {
    await expect(send('contact', { recipientSessionId: contactSessionId })).rejects.toThrow(
      /per-sender contact/
    );
    expect(await threadExists('contact')).toBe(false);
  });

  it('refuses a key no live session carries, naming the live keys', async () => {
    await expect(send('key-miss', { sessionKey: `${LIVE_KEY}-nope` })).rejects.toThrow(
      new RegExp(`carries sessionKey .*Its live keys: "${LIVE_KEY}" \\(${liveId}\\)`)
    );
    expect(await threadExists('key-miss')).toBe(false);
  });

  it('resolves a key to its session and echoes the id', async () => {
    const result = JSON.parse((await send('key-hit', { sessionKey: LIVE_KEY })).content[0].text);
    expect(result.resolvedSessionId).toBe(liveId);
    expect(result.addressedBy).toBe('sessionKey');
    expect(result.reopens).toBeUndefined();
    expect(await threadExists('key-hit')).toBe(true);
  });

  it('admits an ended session named by id and reports that it reopens', async () => {
    const result = JSON.parse(
      (await send('ended', { recipientSessionId: endedId })).content[0].text
    );
    expect(result.resolvedSessionId).toBe(endedId);
    expect(result.addressedBy).toBe('recipientSessionId');
    expect(result.reopens).toBe(true);
  });

  it('refuses a made-up session id on an unthreaded send, and stores no inbox row', async () => {
    const content = `explicit-address ${RUN} unthreaded`;
    await expect(
      handleSendToInbox(
        {
          userId: INTEGRATION_TEST_USER_ID,
          recipientSlug: SUITE_AGENT,
          recipientSessionId: randomUUID(),
          content,
          trigger: false,
        },
        dataComposer
      )
    ).rejects.toThrow(/Nothing was sent/);
    const { data } = await raw.from('agent_inbox').select('id').eq('content', content);
    expect(data ?? []).toHaveLength(0);
  });
});

describe('start_session never reuses or duplicates a transcript across a contact scope', () => {
  let dataComposer: DataComposer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any;
  let suiteSbId: string;
  const SUITE = 'echo-transcript-scope';
  const CONTACT = '11111111-2222-3333-4444-555555550203';

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    raw = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    suiteSbId = await ensureSuiteIdentity(dataComposer, fixture, SUITE);
    const { error } = await raw.from('contacts').upsert(
      [
        {
          id: CONTACT,
          user_id: INTEGRATION_TEST_USER_ID,
          name: 'Fixture Transcript Scope',
          email: 'transcript-scope@example.com',
        },
      ],
      { onConflict: 'id' }
    );
    if (error) throw new Error(`contact fixture: ${error.message}`);
  });

  afterAll(async () => {
    await raw
      .from('sessions')
      .delete()
      .eq('user_id', INTEGRATION_TEST_USER_ID)
      .eq('agent_id', SUITE);
    await raw.from('contacts').delete().eq('id', CONTACT);
    await raw.from('agent_identities').delete().eq('id', suiteSbId);
  });

  async function linkedSession(contactId: string | null, transcript: string) {
    const { data, error } = await raw
      .from('sessions')
      .insert({
        user_id: INTEGRATION_TEST_USER_ID,
        agent_id: SUITE,
        sb_id: suiteSbId,
        lifecycle: 'idle',
        started_at: new Date().toISOString(),
        contact_id: contactId,
        backend_session_id: transcript,
        claude_session_id: transcript,
      })
      .select('id')
      .single();
    if (error) throw new Error(`session fixture: ${error.message}`);
    return data.id as string;
  }

  async function rowsFor(transcript: string): Promise<number> {
    const { data } = await raw
      .from('sessions')
      .select('id')
      .eq('user_id', INTEGRATION_TEST_USER_ID)
      .eq('backend_session_id', transcript);
    return (data ?? []).length;
  }

  for (const direction of ['owner row, contact caller', 'contact row, owner caller'] as const) {
    it(`refuses and inserts nothing: ${direction}, forceNew included`, async () => {
      const transcript = `transcript-${randomUUID()}`;
      const rowContact = direction === 'owner row, contact caller' ? null : CONTACT;
      const callerContact = direction === 'owner row, contact caller' ? CONTACT : undefined;
      await linkedSession(rowContact, transcript);

      for (const forceNew of [false, true]) {
        const result = JSON.parse(
          (
            await handleStartSession(
              {
                userId: INTEGRATION_TEST_USER_ID,
                sbSlug: SUITE,
                backend: 'claude',
                backendSessionId: transcript,
                forceNew,
                ...(callerContact ? { contactId: callerContact } : {}),
              },
              dataComposer
            )
          ).content[0].text
        );
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/another contact scope/);
      }
      expect(await rowsFor(transcript)).toBe(1);
    });
  }

  it('control: the same scope reuses the linked row', async () => {
    const transcript = `transcript-${randomUUID()}`;
    const id = await linkedSession(null, transcript);
    const result = JSON.parse(
      (
        await handleStartSession(
          {
            userId: INTEGRATION_TEST_USER_ID,
            sbSlug: SUITE,
            backend: 'claude',
            backendSessionId: transcript,
            forceNew: true,
          },
          dataComposer
        )
      ).content[0].text
    );
    expect(result.success).toBe(true);
    expect(result.session?.id).toBe(id);
    expect(await rowsFor(transcript)).toBe(1);
  });
});
