/**
 * Strict-by-default tool input schemas.
 *
 * Zod strips unknown keys by default, so a tool called with a plausible-but-
 * wrong parameter succeeds while silently ignoring it. For LLM callers that is
 * the worst possible outcome: the guess is discarded, a default is substituted,
 * and the response reads like confirmation. Myra scheduled a reminder with
 * `remindAt` (the real field is `runAt`), the key was stripped, create_reminder
 * fell through to its "run in 1 minute" default, and the reply echoed a
 * nextRunAt of ~now — which she reasonably read as the reminder being set.
 *
 * `.strict()` turns that into an InvalidParams error naming the offending key,
 * which a model can self-correct from on the next attempt. The SDK enforces it:
 * `validateToolInput` (mcp.js) runs safeParseAsync against this schema on every
 * call, so rejection happens before the handler ever runs.
 *
 * This was previously applied one schema at a time — get_inbox after a silent
 * strip made Myra conclude her inbox was empty (2026-08-10), dueDate in #502,
 * then runAt here. Three instances of one defect in the same layer means the
 * default is wrong, not the individual schemas, so strictness is applied once
 * at the registration boundary instead of 103 more times.
 */

import { z } from 'zod';

/**
 * Whether a value is a zod schema instance (as opposed to a plain record that
 * merely holds schemas). Mirrors the SDK's own duck-typing in
 * `zod-compat.isZodRawShapeCompat` so we classify inputSchema exactly the way
 * the SDK will when it later normalizes and validates.
 */
function isZodSchema(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { _def?: unknown; _zod?: unknown; parse?: unknown };
  return (
    candidate._def !== undefined ||
    candidate._zod !== undefined ||
    typeof candidate.parse === 'function'
  );
}

/**
 * Escape hatch for an operator who hits an unforeseen rejection in production.
 * Set INK_STRICT_TOOL_ARGS=0 to restore the old silently-stripping behaviour
 * without a redeploy.
 */
export function strictToolArgsEnabled(): boolean {
  return process.env.INK_STRICT_TOOL_ARGS !== '0';
}

/**
 * Make a tool's declared inputSchema reject unknown keys.
 *
 * `inputSchema` is inconsistently either a raw zod shape (`save_link` passes an
 * inline `{ url: z.string(), ... }`) or a full ZodObject (`create_reminder`
 * passes an imported `z.object({...})`). The SDK tolerates both, so both have
 * to be handled here; a raw shape is promoted to a ZodObject first, which is
 * what the SDK would have done internally anyway.
 *
 * Anything else — an empty `{}` (debug_request), a union, an already-strict
 * object — is returned untouched. Empty shapes are deliberately left alone:
 * the SDK substitutes EMPTY_OBJECT_JSON_SCHEMA for them and there are no
 * declared keys to be strict about.
 */
export function strictifyInputSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;

  if (schema instanceof z.ZodObject) {
    return schema.strict();
  }

  // A raw ZodRawShape: a plain record whose values are all zod schemas. The
  // "not itself a schema" check must come first — a ZodObject also has object
  // values, but its own _def would make this branch misfire.
  if (!isZodSchema(schema)) {
    const values = Object.values(schema as Record<string, unknown>);
    if (values.length > 0 && values.every(isZodSchema)) {
      return z.object(schema as z.ZodRawShape).strict();
    }
  }

  return schema;
}
