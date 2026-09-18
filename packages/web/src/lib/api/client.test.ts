/**
 * The client half of the logout contract.
 *
 * The API's admin middleware now refuses some requests deliberately WITHOUT
 * ending the session — a refresh cookie one generation behind, a grant it could
 * not check. That only works if this classifier stays narrow, so the bodies the
 * server sends are exercised against it here. A change that widened it to "any
 * 401" would pass every server-side test and still log people out.
 *
 * Bodies mirrored from packages/api/src/routes/admin.ts, adminAuthMiddleware.
 */

import { describe, expect, it } from 'vitest';
import type { AxiosError } from 'axios';
import { isInvalidTokenAuthFailure } from './client';

const failure = (status: number, body: { error?: string }, url = '/api/admin/sessions') =>
  ({
    response: { status, data: body },
    config: { url },
  }) as AxiosError<{ error?: string }>;

describe('isInvalidTokenAuthFailure', () => {
  it('ends the session on the terminal refusal', () => {
    expect(isInvalidTokenAuthFailure(failure(401, { error: 'Invalid token' }))).toBe(true);
  });

  it('leaves the session alone when the cookie is merely superseded', () => {
    // Two tabs refreshed at once and this request carried the older cookie.
    // The browser already holds the live one; logging out here would revoke a
    // session that its own sibling request just renewed.
    expect(isInvalidTokenAuthFailure(failure(401, { error: 'Stale credential' }))).toBe(false);
  });

  it('leaves the session alone when the server could not check the grant', () => {
    expect(
      isInvalidTokenAuthFailure(failure(503, { error: 'Authentication temporarily unavailable' }))
    ).toBe(false);
  });

  it('ignores an unrelated 401 from outside the admin API', () => {
    expect(
      isInvalidTokenAuthFailure(failure(401, { error: 'Invalid token' }, '/api/chat/send'))
    ).toBe(false);
  });

  it('ignores the logout call itself', () => {
    expect(
      isInvalidTokenAuthFailure(failure(401, { error: 'Invalid token' }, '/api/admin/auth/logout'))
    ).toBe(false);
  });
});
