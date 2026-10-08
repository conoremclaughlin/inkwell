/**
 * Hold an account's gate for the lifetime of one authenticated request
 * (ink://specs/account-deletion v6 §3).
 *
 * Called by each auth tier the moment it has resolved the account, before
 * the next await. The lease is released when the response closes, which
 * Node emits after the response has finished or the connection has gone, so
 * it covers every handler behind the middleware, not just the middleware
 * itself. Work a handler leaves running after its response (an inkling
 * turn, an upload's last step) enters the gate on its own.
 *
 * A closed account's request is answered 403 here and goes no further.
 */

import type { Response } from 'express';
import { accountGate, GateClosedError } from './gate';

export const ACCOUNT_BEING_DELETED = 'This account is being deleted';

/** True when the request may continue; false once it has been answered. */
export function leaseAccountForRequest(
  res: Response,
  userId: string,
  respond: (res: Response) => void = (r) => {
    r.status(403).json({ error: ACCOUNT_BEING_DELETED });
  }
): boolean {
  try {
    const lease = accountGate.enter(userId);
    res.once('close', () => lease.release());
    return true;
  } catch (error) {
    if (!(error instanceof GateClosedError)) throw error;
    respond(res);
    return false;
  }
}
