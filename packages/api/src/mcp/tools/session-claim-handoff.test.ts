/**
 * Signed-claim handoff: issuer → verifier → request context → authorization.
 *
 * The handler tests fabricate `tokenSessionId` / `tokenContactId` directly on a
 * mocked request context, which proves the authorization logic reads them but
 * proves nothing about them arriving. Three links have to hold for contact
 * isolation to work in production — SessionService signing the claims, the auth
 * provider surfacing them, and the server snapshotting them into
 * AsyncLocalStorage — and if any one drops a claim the handler tests stay green
 * while a contact runner silently looks owner-scoped and is refused its own
 * session (Lumen, PR #501 round 4).
 *
 * So nothing in the chain is mocked here: a real JWT is signed, really
 * verified, run through the real context assembly and the real
 * AsyncLocalStorage, and only the repository underneath is a stub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Inlined, not a const: vi.mock is hoisted above module-scope declarations.
vi.mock('../../config/env', () => ({
  env: {
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SECRET_KEY: 'test-secret-key',
    ENFORCE_IDENTITY_PINNING: 'true',
  },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: vi.fn(), auth: {} })),
}));

vi.mock('../../services/user-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/user-resolver')>();
  return {
    ...actual,
    resolveUserOrThrow: vi.fn().mockResolvedValue({
      user: { id: 'user-123' },
      resolvedBy: 'userId',
    }),
  };
});

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Everything below is the real implementation.
import { signRunnerAccessToken } from '../../auth/pcp-tokens';
import { PcpAuthProvider } from '../auth/pcp-auth-provider';
import { runWithRequestContext, tokenIdentityContext } from '../../utils/request-context';
import { handleUpdateSessionState } from './memory-handlers';

const USER_ID = 'user-123';
const EMAIL = 'test@test.com';
const TARGET_UUID = '95f7f160-6599-449d-9f63-e31ca20a43ce';

const ownerSession = {
  id: 'session-owner',
  userId: USER_ID,
  agentId: 'myra',
  sbId: 'sb-myra',
  startedAt: new Date('2026-08-20T10:00:00Z'),
  metadata: {},
};
const contactA = { ...ownerSession, id: 'session-contact-a', contactId: 'contact-a' };
const contactB = { ...ownerSession, id: 'session-contact-b', contactId: 'contact-b' };

let updateSession: ReturnType<typeof vi.fn>;
let getSession: ReturnType<typeof vi.fn>;
let composer: unknown;

beforeEach(() => {
  updateSession = vi.fn().mockResolvedValue(ownerSession);
  getSession = vi.fn();
  composer = {
    getClient: vi.fn(),
    repositories: {
      memory: {
        getSession,
        updateSession,
        findOwnedActiveSessions: vi.fn().mockResolvedValue([]),
        getActiveSession: vi.fn(),
        remember: vi.fn(),
      },
      projects: { findAllByUser: vi.fn() },
      tasks: { create: vi.fn() },
      activityStream: { logActivity: vi.fn().mockResolvedValue({ id: 'a1' }) },
    },
  };
});

/** The production chain: sign a runner token, verify it, build the context. */
function contextFromRunnerToken(claims: {
  agentId?: string;
  sbId?: string;
  sessionId?: string;
  contactId?: string;
}) {
  const token = signRunnerAccessToken({ userId: USER_ID, email: EMAIL, ...claims });
  const verified = new PcpAuthProvider().verifyAccessToken(`Bearer ${token}`);
  expect(verified).not.toBeNull();
  return {
    verified: verified!,
    ctx: { userId: USER_ID, email: EMAIL, ...tokenIdentityContext(verified) },
  };
}

const runUpdate = (ctx: object, args: Record<string, unknown>) =>
  runWithRequestContext(ctx as never, () =>
    handleUpdateSessionState({ email: EMAIL, ...args }, composer as never)
  ) as Promise<{ content: Array<{ text: string }> }>;

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe('runner token claims survive the handoff', () => {
  it('carries sessionId and contactId through signing and verification', () => {
    const { verified } = contextFromRunnerToken({
      agentId: 'myra',
      sbId: 'sb-myra',
      sessionId: 'session-contact-a',
      contactId: 'contact-a',
    });

    expect(verified.sessionId).toBe('session-contact-a');
    expect(verified.contactId).toBe('contact-a');
  });

  it('snapshots them onto the request context as authenticated fields', () => {
    const { ctx } = contextFromRunnerToken({
      agentId: 'myra',
      sbId: 'sb-myra',
      sessionId: 'session-contact-a',
      contactId: 'contact-a',
    });

    expect(ctx).toMatchObject({
      agentTokenBound: true,
      tokenAgentId: 'myra',
      tokenSbId: 'sb-myra',
      tokenSessionId: 'session-contact-a',
      tokenContactId: 'contact-a',
    });
    // The unsigned fields stay empty — nothing here came from a header.
    expect((ctx as { contactId?: string }).contactId).toBeUndefined();
    expect((ctx as { sessionId?: string }).sessionId).toBeUndefined();
  });

  it('marks a user token as not agent-bound', () => {
    const { ctx } = contextFromRunnerToken({});
    expect(ctx).not.toHaveProperty('agentTokenBound');
  });
});

describe('contact isolation end to end from a real token', () => {
  it('allows a contact runner its own contact session', async () => {
    const { ctx } = contextFromRunnerToken({
      agentId: 'myra',
      sbId: 'sb-myra',
      sessionId: 'session-contact-a',
      contactId: 'contact-a',
    });
    getSession.mockResolvedValue(contactA);
    updateSession.mockResolvedValue(contactA);

    const result = await runUpdate(ctx, { sessionId: TARGET_UUID, context: 'own contact' });

    expect(parse(result).success).toBe(true);
  });

  it('denies the same runner another contact under the same identity', async () => {
    const { ctx } = contextFromRunnerToken({
      agentId: 'myra',
      sbId: 'sb-myra',
      sessionId: 'session-contact-a',
      contactId: 'contact-a',
    });
    getSession.mockResolvedValue(contactB);

    const result = await runUpdate(ctx, { sessionId: TARGET_UUID, context: 'other contact' });

    expect(parse(result).success).toBe(false);
    expect(parse(result).error).toMatch(/not authorized/i);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('allows an owner runner its owner session', async () => {
    const { ctx } = contextFromRunnerToken({
      agentId: 'myra',
      sbId: 'sb-myra',
      sessionId: 'session-owner',
    });
    getSession.mockResolvedValue(ownerSession);

    const result = await runUpdate(ctx, { sessionId: TARGET_UUID, context: 'owner' });

    expect(parse(result).success).toBe(true);
  });

  it('locks a contact runner out of its OWN session when the contact claim is dropped', async () => {
    // The failure mode that makes this file necessary. If the issuer, the
    // verifier or the server snapshot stops carrying contactId, nothing throws
    // and no handler test notices — the runner just quietly loses access to the
    // conversation it was spawned for. Asserting the symptom means a regression
    // in any of those three links surfaces here.
    const { ctx } = contextFromRunnerToken({
      agentId: 'myra',
      sbId: 'sb-myra',
      sessionId: 'session-contact-a',
      // contactId deliberately absent
    });
    getSession.mockResolvedValue(contactA);

    const result = await runUpdate(ctx, { sessionId: TARGET_UUID, context: 'no claim' });

    expect(parse(result).success).toBe(false);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('ignores an unsigned contactId smuggled alongside a real token', async () => {
    const { ctx } = contextFromRunnerToken({
      agentId: 'myra',
      sbId: 'sb-myra',
      sessionId: 'session-contact-a',
      contactId: 'contact-a',
    });
    getSession.mockResolvedValue(contactB);

    // What a forged x-ink-context header looks like once assembled.
    const result = await runUpdate(
      { ...ctx, contactId: 'contact-b', sessionId: 'session-contact-b' },
      { sessionId: TARGET_UUID, context: 'forged header alongside a valid token' }
    );

    expect(parse(result).success).toBe(false);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('resolves implicitly to the signed session, not the header one', async () => {
    const { ctx } = contextFromRunnerToken({
      agentId: 'myra',
      sbId: 'sb-myra',
      sessionId: 'session-contact-a',
      contactId: 'contact-a',
    });
    getSession.mockImplementation(async (id: string) =>
      id === 'session-contact-b' ? contactB : contactA
    );
    updateSession.mockResolvedValue(contactA);

    await runUpdate(
      { ...ctx, sessionId: 'session-contact-b' },
      { context: 'implicit, signed session wins' }
    );

    expect(updateSession).toHaveBeenCalledWith(
      'session-contact-a',
      expect.objectContaining({ context: 'implicit, signed session wins' })
    );
  });
});
