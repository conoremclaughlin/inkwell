import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  from: vi.fn(),
  createClient: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('../config/env', () => ({
  env: { SUPABASE_URL: 'https://example.invalid', SUPABASE_SECRET_KEY: 'test-only' },
}));
vi.mock('../utils/logger', () => ({ logger: { debug: mocks.debug, error: mocks.error } }));

import { AuditService, type AuditEntry } from './audit';

const entry: AuditEntry = {
  userId: '00000000-0000-4000-8000-000000000001',
  action: 'web_search',
  category: 'network',
  responseStatus: 'pending',
  target: 'private query must not reach diagnostics',
  metadata: { query: 'private query', requestId: 'correlation-id', phase: 'request' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.from.mockReturnValue({ insert: mocks.insert });
  mocks.createClient.mockReturnValue({ from: mocks.from });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('audit persistence', () => {
  it('never retains user auth state in the server client', () => {
    new AuditService();
    expect(mocks.createClient).toHaveBeenCalledWith('https://example.invalid', 'test-only', {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });

  it('requires an acknowledged insert and attaches a finite transport deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const abortSignal = vi.fn().mockResolvedValue({ error: null });
    mocks.insert.mockReturnValue({ abortSignal });
    await new AuditService().log(entry, { required: true });
    expect(mocks.from).toHaveBeenCalledWith('audit_log');
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: entry.userId,
        response_status: 'pending',
        metadata: entry.metadata,
      })
    );
    expect(abortSignal).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(5000);
    expect(abortSignal.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(mocks.debug).toHaveBeenCalledWith('Audit logged', { action: 'web_search' });
  });

  it.each(['returned', 'thrown'])(
    'fails closed for a %s required-write failure, without raw text',
    async (mode) => {
      const abortSignal = vi.fn();
      if (mode === 'returned')
        abortSignal.mockResolvedValue({ error: { message: 'private DB query' } });
      else abortSignal.mockRejectedValue(new Error('private credential detail'));
      mocks.insert.mockReturnValue({ abortSignal });
      await expect(new AuditService().log(entry, { required: true })).rejects.toThrow(
        'Required audit persistence unavailable'
      );
      expect(mocks.error).toHaveBeenCalledWith('Failed to write audit log', {
        action: 'web_search',
      });
      expect(JSON.stringify([...mocks.error.mock.calls, ...mocks.debug.mock.calls])).not.toContain(
        'private'
      );
    }
  );

  it('retains the best-effort API for existing callers', async () => {
    mocks.insert.mockResolvedValue({ error: { message: 'private DB response' } });
    await expect(new AuditService().log(entry)).resolves.toBeUndefined();
    mocks.insert.mockRejectedValue(new Error('private network error'));
    await expect(new AuditService().log(entry)).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalledTimes(2);
  });
});
