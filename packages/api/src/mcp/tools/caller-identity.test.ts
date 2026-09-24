/**
 * One authorization rule for every session stamp.
 *
 * `resolveAttributedSession` is what send_response uses to decide which session
 * an outgoing message is attributed to. Its previous form trusted the request
 * context bare: a legacy agent token with no signed session claim could name
 * another user's, identity's or contact's session through the unsigned
 * `x-ink-context` header and have it written onto the `message_out` row; a
 * nonexistent id failed the activity insert after the message had already gone
 * out (Lumen, PR #596). Every case below is a way that stamp used to be wrong.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { DataComposer } from '../../data/composer';
import { runWithRequestContext } from '../../utils/request-context';
import {
  loadAuthorizedAmbientSession,
  resolveAttributedSession,
  resolveCallerIdentity,
} from './caller-identity';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ownSession = '11111111-1111-4111-8111-111111111111';
const foreignUserSession = '22222222-2222-4222-8222-222222222222';
const peerIdentitySession = '44444444-4444-4444-8444-444444444444';
const contactSession = '55555555-5555-4555-8555-555555555555';
const sbId = '33333333-3333-4333-8333-333333333333';

const rows: Record<string, object> = {
  [ownSession]: { id: ownSession, userId: 'owner', sbSlug: 'myra', sbId },
  [foreignUserSession]: {
    id: foreignUserSession,
    userId: 'someone-else',
    sbSlug: 'wren',
    sbId: 'sb-wren',
  },
  [peerIdentitySession]: {
    id: peerIdentitySession,
    userId: 'owner',
    sbSlug: 'wren',
    sbId: 'sb-wren',
  },
  [contactSession]: {
    id: contactSession,
    userId: 'owner',
    sbSlug: 'myra',
    sbId,
    contactId: 'contact-b',
  },
};

function composer(opts: { throws?: boolean } = {}) {
  const getSession = vi.fn(async (id: string) => {
    if (opts.throws) throw new Error('db down');
    return rows[id] ?? null;
  });
  return {
    composer: { repositories: { memory: { getSession } } } as unknown as DataComposer,
    getSession,
  };
}

/** An SB's own token: signed identity, no signed session claim. */
const boundMyra = {
  userId: 'owner',
  sbSlug: 'myra',
  sbId,
  agentTokenBound: true,
  tokenSlug: 'myra',
  tokenSbId: sbId,
};

afterEach(() => vi.clearAllMocks());

describe('resolveAttributedSession', () => {
  it('attributes nothing outside a request', async () => {
    const { composer: c, getSession } = composer();
    expect(await resolveAttributedSession(c)).toEqual({
      sessionId: undefined,
      reason: 'no-request-context',
    });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('attributes nothing when the request has no authenticated user', async () => {
    const { composer: c, getSession } = composer();
    const result = await runWithRequestContext({ sessionId: ownSession }, () =>
      resolveAttributedSession(c)
    );
    expect(result).toEqual({ sessionId: undefined, reason: 'no-user' });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('attributes nothing when the request names no session', async () => {
    const { composer: c } = composer();
    const result = await runWithRequestContext({ ...boundMyra }, () => resolveAttributedSession(c));
    expect(result).toEqual({ sessionId: undefined, reason: 'no-ambient-session' });
  });

  it('stamps the signed token session once loaded and authorized', async () => {
    const { composer: c, getSession } = composer();
    const result = await runWithRequestContext({ ...boundMyra, tokenSessionId: ownSession }, () =>
      resolveAttributedSession(c)
    );
    expect(result).toEqual({ sessionId: ownSession, via: 'token' });
    expect(getSession).toHaveBeenCalledWith(ownSession);
  });

  it('stamps a header-asserted session for a user token when it belongs to the same user', async () => {
    const { composer: c } = composer();
    // The normal local shape: user bearer, ctx.sbSlug enriched from the
    // ambient session, no signed session claim.
    const result = await runWithRequestContext(
      { userId: 'owner', sbSlug: 'myra', sbId, sessionId: ownSession },
      () => resolveAttributedSession(c)
    );
    expect(result).toEqual({ sessionId: ownSession, via: 'header' });
  });

  it('prefers the signed claim over the header and never loads the header session', async () => {
    const { composer: c, getSession } = composer();
    const result = await runWithRequestContext(
      { ...boundMyra, tokenSessionId: ownSession, sessionId: foreignUserSession },
      () => resolveAttributedSession(c)
    );
    expect(result).toEqual({ sessionId: ownSession, via: 'token' });
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledWith(ownSession);
  });

  it("refuses another user's session named by the unsigned header", async () => {
    // Lumen's probe: an agent-bound caller whose header names a session owned
    // by a different user. The FK would accept it; ownership does not.
    const { composer: c } = composer();
    const result = await runWithRequestContext(
      { ...boundMyra, sessionId: foreignUserSession },
      () => resolveAttributedSession(c)
    );
    expect(result).toEqual({ sessionId: undefined, reason: 'unauthorized' });
  });

  it('refuses a same-user session of another identity for an agent-bound caller', async () => {
    const { composer: c } = composer();
    const result = await runWithRequestContext(
      { ...boundMyra, sessionId: peerIdentitySession },
      () => resolveAttributedSession(c)
    );
    expect(result).toEqual({ sessionId: undefined, reason: 'unauthorized' });
  });

  it('refuses a session in another contact scope for an agent-bound caller', async () => {
    // Same user, same identity, different contact: one SB serves many contacts,
    // and identity alone does not keep two conversations apart.
    const { composer: c } = composer();
    const result = await runWithRequestContext({ ...boundMyra, sessionId: contactSession }, () =>
      resolveAttributedSession(c)
    );
    expect(result).toEqual({ sessionId: undefined, reason: 'unauthorized' });
  });

  it('lets a user token reach a same-user session of another identity', async () => {
    // User/admin tokens keep same-user authority; only the cross-user floor
    // applies. This is the repair authority agents deliberately do not get.
    const { composer: c } = composer();
    const result = await runWithRequestContext(
      { userId: 'owner', sessionId: peerIdentitySession },
      () => resolveAttributedSession(c)
    );
    expect(result).toEqual({ sessionId: peerIdentitySession, via: 'header' });
  });

  it('attributes nothing when the named session does not exist', async () => {
    const { composer: c } = composer();
    const result = await runWithRequestContext(
      { ...boundMyra, sessionId: '99999999-9999-4999-8999-999999999999' },
      () => resolveAttributedSession(c)
    );
    expect(result).toEqual({ sessionId: undefined, reason: 'not-found' });
  });

  it('attributes nothing when the lookup throws', async () => {
    const { composer: c } = composer({ throws: true });
    const result = await runWithRequestContext({ ...boundMyra, tokenSessionId: ownSession }, () =>
      resolveAttributedSession(c)
    );
    expect(result).toEqual({ sessionId: undefined, reason: 'lookup-failed' });
  });

  it('attributes nothing when the composer has no repositories', async () => {
    // A misconfigured caller must degrade to "no attribution", never throw
    // into the send path.
    const result = await runWithRequestContext({ ...boundMyra, tokenSessionId: ownSession }, () =>
      resolveAttributedSession({} as unknown as DataComposer)
    );
    expect(result).toEqual({ sessionId: undefined, reason: 'lookup-failed' });
  });
});

describe('loadAuthorizedAmbientSession', () => {
  it('returns the row when the caller may act on it', async () => {
    const { composer: c } = composer();
    const result = await runWithRequestContext({ ...boundMyra, sessionId: ownSession }, () =>
      loadAuthorizedAmbientSession(c, 'owner', resolveCallerIdentity())
    );
    expect(result.session?.id).toBe(ownSession);
    expect(result.reason).toBeUndefined();
  });

  it('applies the same-user floor to user tokens even with an explicit sbSlug', async () => {
    // An explicit sbSlug on a user token is attribution, never authority: it
    // does not turn the caller into an agent-bound one, and it does not lift
    // the cross-user floor.
    const { composer: c } = composer();
    const result = await runWithRequestContext(
      { userId: 'owner', sessionId: foreignUserSession },
      () => loadAuthorizedAmbientSession(c, 'owner', resolveCallerIdentity('wren'))
    );
    expect(result).toEqual({ session: null, reason: 'unauthorized' });
  });
});

describe('resolveCallerIdentity', () => {
  it('reads an agent-bound token from its signed claims only', () => {
    const caller = runWithRequestContext(
      {
        ...boundMyra,
        sbSlug: 'enriched-slug',
        sbId: 'enriched-sb',
        contactId: 'header-contact',
        tokenContactId: 'signed-contact',
      },
      () => resolveCallerIdentity('ignored')
    );
    expect(caller).toEqual({
      sbId,
      sbSlug: 'myra',
      contactId: 'signed-contact',
      agentBound: true,
    });
  });

  it('keeps a user token unbound when handed an explicit identity', () => {
    const caller = runWithRequestContext({ userId: 'owner', sbSlug: 'myra' }, () =>
      resolveCallerIdentity('myra')
    );
    expect(caller).toEqual({ sbSlug: 'myra', agentBound: false });
  });
});
