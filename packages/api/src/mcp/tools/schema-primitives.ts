/**
 * Shared input primitives for MCP tool schemas.
 *
 * These exist so a validation rule is written once. The alternative is what
 * this file replaced: seventeen independent `z.string().datetime()` calls that
 * all made the same wrong promise, and a fix that has to find all seventeen.
 */

import { z } from 'zod';

/**
 * An ISO 8601 / RFC 3339 timestamp, offsets included.
 *
 * Zod's bare `.datetime()` accepts ONLY a `Z` suffix — it rejects
 * `2026-09-02T07:30:00-07:00`, which is the same instant written the way most
 * callers actually write it, and which every one of these fields documented
 * itself as accepting ("ISO 8601"). Both RFC 3339 and ISO 8601 permit the
 * offset form; the validator was narrower than its own description.
 *
 * That gap cost a real reminder. An agent read the docs, sent an offset, and
 * got `-32602 Invalid datetime` — then, because the failure arrived alone in
 * its turn, saw nothing at all (#552). The schema was the first of the two
 * defects and the one nobody would have found from the outside, because the
 * documentation described the intended behaviour correctly.
 *
 * Widening only: every string accepted before is still accepted. Downstream
 * consumers pass these to `new Date(...)` or to Postgres, both of which have
 * always understood offsets.
 */
export function isoDateTime() {
  return z.string().datetime({ offset: true });
}
