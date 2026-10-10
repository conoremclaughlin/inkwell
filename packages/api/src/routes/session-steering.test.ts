import { afterEach, describe, it, expect, vi } from 'vitest';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { InkAuthProvider } from '../mcp/auth/ink-auth-provider';
import { fakeEnv } from '../test/fake-env';
import { addSessionSteeringRoute } from './session-steering';
import {
  registerActiveRun,
  resetActiveRuns,
  attachRunSteering,
  submitRunSteering,
  markRunnerSettled,
} from '../services/sessions/active-runs';
import type { SessionSteeringReceipt } from '@inklabs/shared/runtime';
import { INKLING_CLIENT } from '../services/inklings/inkling-client';
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../config/env', async () => ({ env: (await import('../test/fake-env')).fakeEnv }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      throw new Error('No auth DB calls permitted');
    },
  }),
}));
afterEach(resetActiveRuns);
const input = { messageId: 'fixture-message', text: 'Use the updated plan.' };
function register(turnEpoch = 'fixture-epoch') {
  registerActiveRun({
    sessionId: 'fixture-session',
    turnEpoch,
    userId: 'fixture-owner',
    sbSlug: 'echo',
    backend: 'ink',
    startedAt: Date.now(),
  });
}
function fixture() {
  const enqueue = vi.fn(
    async (): Promise<SessionSteeringReceipt> => ({
      messageId: input.messageId,
      status: 'pending',
    })
  );
  register();
  const release = attachRunSteering('fixture-session', 'fixture-epoch', enqueue);
  const auth: Record<string, unknown> = { userId: 'fixture-owner' };
  const session: Record<string, unknown> = {
    user_id: 'fixture-owner',
    sb_id: 'fixture-sb',
    contact_id: null,
    cli_attached: false,
    turn_epoch: 'fixture-epoch',
  };
  const identity: Record<string, unknown> = {
    id: 'fixture-sb',
    user_id: 'fixture-owner',
    agent_id: 'echo',
    metadata: {},
  };
  const sessionRead = vi.fn(
    async (): Promise<{ data: unknown; error?: unknown }> => ({ data: session })
  );
  const identityRead = vi.fn(
    async (): Promise<{ data: unknown; error?: unknown }> => ({ data: identity })
  );
  const from = vi.fn((table: string) => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      single: sessionRead,
      maybeSingle: identityRead,
    };
    if (!['sessions', 'agent_identities'].includes(table)) throw new Error('Unexpected table');
    return query;
  });
  const verify = vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true, token: auth }));
  const router = Router();
  addSessionSteeringRoute(router, {
    authProvider: { verifyAccessToken: verify } as never,
    dataComposer: { getClient: () => ({ from }) } as never,
  });
  const req = {
    headers: { authorization: 'Bearer fixture', 'x-ink-context': 'unsigned-owner-assertion' },
    params: { id: 'fixture-session' },
    body: { turnEpoch: 'fixture-epoch', ...input } as unknown,
  };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const run = () => router.stack[0].route!.stack[0].handle(req as never, res as never, vi.fn());
  return {
    enqueue,
    release,
    auth,
    session,
    identity,
    sessionRead,
    identityRead,
    from,
    verify,
    req,
    res,
    run,
  };
}

describe('explicit hosted owner steering', () => {
  it('passes text only to the current mailbox without a new wake or session write', async () => {
    const h = fixture();
    await h.run();
    expect(h.verify).toHaveBeenCalledWith('Bearer fixture');
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(input);
    expect(h.from.mock.calls).toEqual([['sessions'], ['agent_identities']]);
    expect(h.res.status).toHaveBeenCalledWith(202);
    expect(h.res.json).toHaveBeenCalledWith({
      messageId: input.messageId,
      status: 'pending',
      turnEpoch: 'fixture-epoch',
    });
  });
  it('does not acknowledge until the owner finishes durable admission', async () => {
    const h = fixture();
    let finish!: (receipt: SessionSteeringReceipt) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.enqueue.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const running = h.run();
    await began;
    expect(h.res.json).not.toHaveBeenCalled();
    finish({ messageId: input.messageId, status: 'pending' });
    await running;
    expect(h.res.status).toHaveBeenCalledWith(202);
  });
  it.each(['browser_client', 'pcp_admin'])(
    'rejects a real signed %s token, even for the owner',
    async (type) => {
      const h = fixture();
      const provider = new InkAuthProvider();
      h.req.headers.authorization = `Bearer ${jwt.sign(
        {
          type,
          sub: 'fixture-owner',
          scope: 'mcp:tools',
          sessionId: 'fixture-session',
          sbId: 'fixture-sb',
          grantId: 'fixture-grant',
        },
        fakeEnv.JWT_SECRET,
        { expiresIn: 120 }
      )}`;
      h.verify.mockImplementation(() => provider.verifyAccessToken(h.req.headers.authorization));
      await h.run();
      expect(h.res.status).toHaveBeenCalledWith(401);
      expect(h.from).not.toHaveBeenCalled();
      expect(h.enqueue).not.toHaveBeenCalled();
    }
  );
  it.each([401, 503])(
    'refuses failed authentication (%i) before reading the target',
    async (status) => {
      const h = fixture();
      h.verify.mockResolvedValueOnce({ ok: false, status });
      await h.run();
      expect(h.res.status).toHaveBeenCalledWith(status);
      expect(h.from).not.toHaveBeenCalled();
      expect(h.enqueue).not.toHaveBeenCalled();
    }
  );
  it.each([
    { sbId: 'fixture-sb' },
    { sbSlug: 'echo' },
    { sessionId: 'fixture-session' },
    { contactId: 'fixture-contact' },
    { userId: 'other-owner' },
  ])('rejects scoped or foreign credentials despite an asserted context: %j', async (claims) => {
    const h = fixture();
    Object.assign(h.auth, claims);
    await h.run();
    expect(h.res.status).toHaveBeenCalledWith(403);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [],
    '',
    {},
    { ...input },
    { turnEpoch: 'fixture-epoch', ...input, sender: 'owner' },
    { turnEpoch: 'fixture-epoch', ...input, mode: 'queue' },
    { turnEpoch: 'fixture-epoch', ...input, threadMessageId: 'mail' },
    { turnEpoch: 'fixture-epoch', ...input, media: [] },
    { turnEpoch: 'fixture-epoch', ...input, text: '' },
    { turnEpoch: 'bad\nepoch', ...input },
  ])('refuses invalid or privilege-bearing input: %j', async (body) => {
    const h = fixture();
    h.req.body = body;
    await h.run();
    expect(h.res.status).toHaveBeenCalledWith(400);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it.each([
    { cli_attached: true },
    { cli_attached: null },
    { turn_epoch: 'replacement' },
    { contact_id: 'fixture-contact' },
    { contact_id: undefined },
    { sb_id: null },
  ])('refuses stale, attached, contact or unknown-identity targets: %j', async (fields) => {
    const h = fixture();
    Object.assign(h.session, fields);
    await h.run();
    expect(h.res.status).toHaveBeenCalledWith(409);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it.each([
    { metadata: { client: INKLING_CLIENT } },
    { metadata: null },
    { metadata: 'malformed' },
    { metadata: [] },
    { id: 'different-sb' },
    { user_id: 'different-owner' },
    { agent_id: 'different-slug' },
  ])('rejects an unsupported or mismatched canonical identity: %j', async (fields) => {
    const h = fixture();
    Object.assign(h.identity, fields);
    await h.run();
    expect(h.res.status).toHaveBeenCalledWith(409);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it.each([{ data: null }, { data: null, error: new Error('fixture read failure') }])(
    'refuses missing or unreadable identity: %j',
    async (read) => {
      const h = fixture();
      h.identityRead.mockResolvedValueOnce(read);
      await h.run();
      expect(h.res.status).toHaveBeenCalledWith(read.error ? 503 : 409);
      expect(h.enqueue).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['inserted', 200],
    ['refused', 409],
    ['unknown', 409],
  ] as const)('returns %s without a fallback', async (status, code) => {
    const h = fixture();
    h.enqueue.mockResolvedValueOnce({ messageId: input.messageId, status });
    await h.run();
    expect(h.res.status).toHaveBeenCalledWith(code);
    expect(h.res.json).toHaveBeenCalledWith(expect.objectContaining({ status }));
    expect(h.enqueue).toHaveBeenCalledOnce();
  });
  it('refuses a released or settled owner', async () => {
    const h = fixture();
    h.release();
    await h.run();
    expect(h.res.status).toHaveBeenCalledWith(409);
    expect(h.enqueue).not.toHaveBeenCalled();
    attachRunSteering('fixture-session', 'fixture-epoch', h.enqueue);
    markRunnerSettled('fixture-session', 'succeeded');
    await h.run();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it('a replacement installed during the final DB read is never bypassed', async () => {
    const h = fixture();
    h.identityRead.mockImplementationOnce(async () => {
      register('replacement');
      return { data: h.identity };
    });
    await h.run();
    expect(h.res.status).toHaveBeenCalledWith(409);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it('rechecks owner generation after asynchronous admission and preserves uncertainty', async () => {
    const h = fixture();
    h.enqueue.mockImplementationOnce(async () => {
      register('replacement');
      return { messageId: input.messageId, status: 'pending' };
    });
    await h.run();
    expect(h.res.status).toHaveBeenCalledWith(409);
    expect(h.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'unknown', reason: 'owner_changed_during_admission' })
    );
  });
  it('a thrown handoff is unknown, not rejected-before-delivery or auto-queued', async () => {
    const h = fixture();
    h.enqueue.mockRejectedValueOnce(new Error('fixture uncertain flush'));
    await h.run();
    expect(h.res.status).toHaveBeenCalledWith(409);
    expect(h.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'unknown', reason: 'steering_handoff_uncertain' })
    );
  });
  it('old cleanup cannot detach a replacement mailbox', async () => {
    const h = fixture();
    register('replacement');
    const replacement = vi.fn(
      async (): Promise<SessionSteeringReceipt> => ({
        messageId: input.messageId,
        status: 'pending',
      })
    );
    attachRunSteering('fixture-session', 'replacement', replacement);
    h.release();
    expect((await submitRunSteering('fixture-session', 'fixture-epoch', input)).status).toBe(
      'refused'
    );
    expect((await submitRunSteering('fixture-session', 'replacement', input)).status).toBe(
      'pending'
    );
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledOnce();
  });
});
