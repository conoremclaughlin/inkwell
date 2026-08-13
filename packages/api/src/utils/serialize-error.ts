/**
 * Error serialization for logs and error strings.
 *
 * `String(error)` on a non-Error object yields "[object Object]", and
 * `error instanceof Error ? error.message : 'Unknown error'` discards the
 * detail entirely. Supabase/PostgREST rejections are always plain objects
 * ({ message, code, details, hint }), never Error instances — so both
 * idioms erase the only useful information at exactly the moment it matters.
 *
 * This cost a real diagnosis: a session-state write failed with Postgres
 * 22003 ("value out of range for type integer") and surfaced to the operator
 * as "[Trigger] SessionService failed: Unknown error".
 */

/** Max length of a JSON-stringified fallback before truncation. */
const MAX_JSON_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Best-effort human-readable string for any thrown value.
 *
 * Never throws, and never returns "[object Object]".
 */
export function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || 'Error';
  }

  const asString = nonEmptyString(error);
  if (asString) return asString;

  if (error === null || error === undefined) {
    return 'Unknown error';
  }

  if (isRecord(error)) {
    // PostgREST / Supabase shape: { message, code, details, hint }.
    // Keep code and details — they are what make the failure actionable.
    const message = nonEmptyString(error.message);
    if (message) {
      const parts = [message];
      const code = nonEmptyString(error.code);
      const details = nonEmptyString(error.details);
      const hint = nonEmptyString(error.hint);
      if (code) parts.push(`code=${code}`);
      if (details) parts.push(`details=${details}`);
      if (hint) parts.push(`hint=${hint}`);
      return parts.join(' | ');
    }

    try {
      const json = JSON.stringify(error);
      if (json && json !== '{}') {
        return json.length > MAX_JSON_LENGTH ? `${json.slice(0, MAX_JSON_LENGTH)}…` : json;
      }
    } catch {
      // Circular or otherwise unserializable — fall through.
    }

    return 'Unserializable error object';
  }

  return String(error);
}
