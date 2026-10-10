import { afterEach, describe, it, expect, vi } from 'vitest';
import { Router } from 'express';
import { addSessionControlRoute } from './session-controls';
import {
  registerActiveRun,
  resetActiveRuns,
  attachRunControls,
  submitRunControl,
} from '../services/sessions/active-runs';
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
afterEach(resetActiveRuns);
const request = { controlId: 'test', action: 'model' as const, model: 'next' };
function fixture(
  auth: Record<string, unknown> = { userId: 'owner' },
  fields: Record<string, unknown> = {}
) {
  const enqueue = vi.fn(() => ({ controlId: 'test', status: 'pending' as const }));
  registerActiveRun({
    sessionId: 'session',
    turnEpoch: 'epoch',
    userId: 'owner',
    sbSlug: 'echo',
    backend: 'ink',
    startedAt: Date.now(),
  });
  const release = attachRunControls('session', 'epoch', enqueue);
  const router = Router();
  addSessionControlRoute(router, {
    authProvider: { verifyAccessToken: vi.fn(async () => ({ ok: true, token: auth })) } as never,
    dataComposer: {
      getClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { user_id: 'owner', turn_epoch: 'epoch', cli_attached: false, ...fields },
              }),
            }),
          }),
        }),
      }),
    } as never,
  });
  const handler = router.stack[0].route!.stack[0].handle;
  const req = {
    headers: { authorization: 'Bearer fixture' },
    params: { id: 'session' },
    body: { turnEpoch: 'epoch', control: request },
  };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  return { enqueue, release, req, res, run: () => handler(req as never, res as never, vi.fn()) };
}
describe('human-owned current-generation control delivery', () => {
  it('routes without opening a log or granting a new owner', async () => {
    const h = fixture();
    await h.run();
    expect(h.res.status).toHaveBeenCalledWith(202);
    expect(h.enqueue).toHaveBeenCalledWith(request);
  });
  it.each([
    { sbId: 'same-agent' },
    { sbSlug: 'echo' },
    { sessionId: 'session' },
    { contactId: 'contact' },
    { userId: 'other' },
  ])('does not confuse read permission with mutation %j', async (claims) => {
    const h = fixture({ userId: 'owner', ...claims });
    await h.run();
    expect(h.res.status).toHaveBeenCalledWith(403);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it.each([{ cli_attached: true }, { cli_attached: null }, { turn_epoch: 'new-owner' }])(
    'refuses attached/unproven or stale row %j',
    async (fields) => {
      const h = fixture(undefined, fields);
      await h.run();
      expect(h.res.status).toHaveBeenCalledWith(409);
      expect(h.enqueue).not.toHaveBeenCalled();
    }
  );
  it('a released owner cannot be targeted', async () => {
    const h = fixture();
    h.release();
    await h.run();
    expect(h.res.status).toHaveBeenCalledWith(409);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it('an old cleanup cannot remove the replacement mailbox, and stale submission refuses', () => {
    const h = fixture();
    registerActiveRun({
      sessionId: 'session',
      turnEpoch: 'new',
      userId: 'owner',
      sbSlug: 'echo',
      backend: 'ink',
      startedAt: Date.now(),
    });
    const next = vi.fn(() => ({ controlId: 'test', status: 'pending' as const }));
    attachRunControls('session', 'new', next);
    h.release();
    expect(submitRunControl('session', 'epoch', request).status).toBe('refused');
    expect(submitRunControl('session', 'new', request).status).toBe('pending');
    expect(next).toHaveBeenCalledOnce();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
