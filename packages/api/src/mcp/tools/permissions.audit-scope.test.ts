/**
 * query_audit_log scoping (security G0.1).
 *
 * The handler only resolved a user when an identifier was passed, and the
 * audit query filters by user only when it has one. So an authenticated
 * caller that passed nothing read every user's audit rows. An authenticated
 * caller now reads its own; a caller with no principal keeps the old
 * behaviour. Invented users, mocked repository and audit service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auditQuery = vi.fn(async (_options: Record<string, unknown>) => []);
vi.mock('../../services/audit', () => ({
  getAuditService: () => ({ query: auditQuery }),
}));

import { handleQueryAuditLog } from './permissions';
import { PrincipalMismatchError } from '../../services/user-resolver';
import { clearSessionContext, runWithRequestContext } from '../../utils/request-context';
import { resetSharedBreakerForTests } from '../../utils/supabase-retry';

const ALPHA = { id: '11111111-1111-4111-8111-111111111111', email: 'alpha@example.com' };
const BETA = { id: '22222222-2222-4222-8222-222222222222', email: 'beta@example.com' };

const findById = vi.fn(async (id: string) => [ALPHA, BETA].find((u) => u.id === id) ?? null);
const dc = {
  repositories: { users: { findById } },
} as unknown as Parameters<typeof handleQueryAuditLog>[1];

function asAlpha<T>(fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ userId: ALPHA.id, email: ALPHA.email }, fn) as Promise<T>;
}

beforeEach(() => {
  resetSharedBreakerForTests();
  clearSessionContext();
  auditQuery.mockClear();
  findById.mockClear();
});

afterEach(() => clearSessionContext());

describe('query_audit_log with an authenticated principal', () => {
  it('reads only the principal’s rows when no identifier is passed', async () => {
    await asAlpha(() => handleQueryAuditLog({}, dc));
    expect(auditQuery).toHaveBeenCalledTimes(1);
    expect(auditQuery.mock.calls[0][0].userId).toBe(ALPHA.id);
  });

  it('accepts the batch search action filter without broadening the authenticated account', async () => {
    await asAlpha(() => handleQueryAuditLog({ action: 'web_search_batch' }, dc));
    expect(auditQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ALPHA.id,
        action: 'web_search_batch',
      })
    );
  });

  it('refuses another account’s identifier and runs no query', async () => {
    await expect(asAlpha(() => handleQueryAuditLog({ userId: BETA.id }, dc))).rejects.toThrow(
      PrincipalMismatchError
    );
    expect(auditQuery).not.toHaveBeenCalled();
  });
});

describe('query_audit_log with no request context (internal and stdio callers)', () => {
  it('stays unscoped when no identifier is passed, unchanged', async () => {
    await handleQueryAuditLog({}, dc);
    expect(auditQuery.mock.calls[0][0].userId).toBeUndefined();
  });
});
