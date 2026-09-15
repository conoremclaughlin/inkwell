import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const oauth = vi.hoisted(() => ({
  isProviderConfigured: vi.fn(() => true),
  getAuthorizationUrl: vi.fn((_provider: string, _redirect: string, state: string) => state),
  exchangeCode: vi.fn(),
  getUserInfo: vi.fn(),
  saveConnectedAccount: vi.fn(),
}));
vi.mock('../services/oauth', () => ({ getOAuthService: () => oauth }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => {
    throw new Error('Unexpected database access');
  }),
}));
vi.mock('../config/env', async () => ({
  env: { ...(await import('../test/fake-env')).fakeEnv, MCP_HTTP_PORT: 3001 },
  isDevelopment: () => false,
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import router, { generatePairingCode } from './admin';
import crypto from 'crypto';

function handler(path: string) {
  const stack = (
    router as unknown as {
      stack: Array<{
        route?: {
          path: string;
          stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
        };
      }>;
    }
  ).stack;
  const route = stack.find((layer) => layer.route?.path === path)?.route;
  if (!route) throw new Error('Missing callback route');
  return route.stack[0].handle;
}

function response() {
  return {
    setHeader: vi.fn(),
    type: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    send: vi.fn(),
  };
}

async function authorize(provider = 'google') {
  const res = response();
  await handler('/oauth/:provider/authorize')(
    {
      params: { provider },
      pcpUserId: 'synthetic-user',
      pcpWorkspaceId: 'synthetic-workspace',
    } as unknown as Request,
    res as unknown as Response
  );
  return res.json.mock.calls[0][0].authUrl as string;
}

async function callback(query: Record<string, unknown>, provider = 'google') {
  const res = response();
  await handler('/oauth/:provider/callback')(
    { params: { provider }, query } as unknown as Request,
    res as unknown as Response
  );
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  oauth.exchangeCode.mockResolvedValue({ accessToken: 'synthetic-access' });
  oauth.getUserInfo.mockResolvedValue({ email: 'reader@example.com' });
  oauth.saveConnectedAccount.mockResolvedValue(undefined);
});

describe('OAuth callback trust boundary', () => {
  it('does not reflect query errors, provider paths, or upstream exceptions as HTML', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const denied = await callback({ state: await authorize(), error: payload });
    expect(denied.send.mock.calls[0][0]).not.toContain(payload);
    expect(denied.send.mock.calls[0][0]).toContain('declined');
    const forged = await callback({ state: 'unknown', code: 'synthetic-code' }, payload);
    expect(forged.send.mock.calls[0][0]).not.toContain(payload);
    oauth.exchangeCode.mockRejectedValueOnce(new Error(payload));
    const failed = await callback({ state: await authorize(), code: 'synthetic-code' });
    expect(failed.send.mock.calls[0][0]).not.toContain(payload);
    expect(failed.send.mock.calls[0][0]).toContain('Could not connect');
    expect(failed.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(failed.setHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
  });

  it('requires scalar state and code, provider binding, and single-use state', async () => {
    const state = await authorize();
    await callback({ state: [state], code: 'synthetic-code' });
    await callback({ state, code: 'synthetic-code' }, 'different-provider');
    expect(oauth.exchangeCode).not.toHaveBeenCalled();
    const success = await callback({ state, code: 'synthetic-code' });
    expect(success.send.mock.calls[0][0]).toContain('success: true');
    expect(oauth.saveConnectedAccount).toHaveBeenCalledWith(
      'synthetic-user',
      'google',
      { accessToken: 'synthetic-access' },
      { email: 'reader@example.com' },
      'synthetic-workspace'
    );
    await callback({ state, code: 'synthetic-code' });
    expect(oauth.exchangeCode).toHaveBeenCalledTimes(1);
    await callback({ state: await authorize(), code: ['synthetic-code'] });
    expect(oauth.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('consumes a valid denial without exchanging credentials', async () => {
    const state = await authorize();
    await callback({ state, error: 'access_denied' });
    await callback({ state, code: 'synthetic-code' });
    expect(oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it('refuses an expired state before exchanging credentials', async () => {
    const state = await authorize();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
    try {
      const expired = await callback({ state, code: 'synthetic-code' });
      expect(expired.send.mock.calls[0][0]).toContain('expired');
      expect(oauth.exchangeCode).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});

describe('pairing code entropy', () => {
  it('uses an unbiased crypto index for every symbol', () => {
    const draw = vi.spyOn(crypto, 'randomInt').mockImplementation((max) => Number(max) - 1);
    try {
      const code = generatePairingCode();
      expect(code).toMatch(/^9+$/);
      expect(draw).toHaveBeenCalledTimes(code.length);
      expect(code).toHaveLength(12);
      expect(draw).toHaveBeenCalledWith(32);
    } finally {
      draw.mockRestore();
    }
  });
});
