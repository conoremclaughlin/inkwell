/**
 * A tool's real parameters, put in front of the model when it got them wrong.
 *
 * In local routing the model is told Inkwell's tools by name only. A native MCP
 * session is handed every tool's schema with each request; here the parameters
 * live behind `describe_tool`, and a model that doesn't think to call it
 * guesses. Two shapes of wrong guess, both seen on Oct 7:
 *
 * - A strict schema refuses an unknown key. An inkling passed `sbSlug` to
 *   `send_to_inbox` (whose sender field is `senderSlug`); Myra passed
 *   `searchQuery` to `list_emails` (whose key is `query`) three times. The
 *   error named the bad key and never the good one.
 * - A non-strict schema strips an unknown key, the call succeeds, and does the
 *   wrong thing (#539: `senderAgentId` after the rename to `senderSlug`).
 *   Nothing tells the model at all.
 *
 * So for an Inkwell call this looks the tool's parameters up once per process,
 * through `describe_tool`, and adds them to a validation error, or notes an
 * ignored key on a success. The lookup starts beside the call, and either
 * outcome waits for it at most `PARAMETER_LOOKUP_WAIT_MS`: on a tool's first
 * use a call that needed no help can still wait up to that long. It never
 * changes what is sent, and a lookup that fails, is slow or is not allowed
 * leaves the call's own result or error exactly as it was.
 */

import type { InkToolCallResult } from './tool-result.js';

/** What `describe_tool` says a tool takes. */
export interface ToolParameters {
  /** Every parameter name, in the schema's order. */
  names: string[];
  /** The ones the schema requires. */
  required: string[];
  /**
   * What the schema does with a key it has no parameter for: refuses it
   * (`additionalProperties: false`), drops it (no `additionalProperties`, a
   * stripping object), or keeps it (`true` or a schema: passthrough or
   * catchall), in which case nothing can be said about its effect.
   */
  extraKeys: 'refused' | 'dropped' | 'kept';
}

/** Looks a tool's parameters up; `undefined` when they can't be had. */
export type ToolParametersLookup = (tool: string) => Promise<ToolParameters | undefined>;

/**
 * Read `describe_tool({ name })`'s answer: `{ tool: { parameters } }`, where
 * `parameters` is the JSON Schema the server also serves for tools/list.
 * Anything else, including a not-found or `{ success: false }`, is `undefined`.
 */
export function parseDescribedParameters(described: unknown): ToolParameters | undefined {
  const tool = field(described, 'tool');
  const parameters = field(tool, 'parameters');
  const properties = field(parameters, 'properties');
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return undefined;
  const names = Object.keys(properties);
  const required = field(parameters, 'required');
  const additional = field(parameters, 'additionalProperties');
  return {
    names,
    required: Array.isArray(required)
      ? required.filter((r): r is string => typeof r === 'string' && names.includes(r))
      : [],
    extraKeys: additional === false ? 'refused' : additional === undefined ? 'dropped' : 'kept',
  };
}

/** "Parameters of send_to_inbox: content (required), recipientSlug, …" */
export function describeParameters(tool: string, parameters: ToolParameters): string {
  if (parameters.names.length === 0) return `${tool} takes no parameters.`;
  const list = parameters.names
    .map((name) => (parameters.required.includes(name) ? `${name} (required)` : name))
    .join(', ');
  return `Parameters of ${tool}: ${list}.`;
}

/** The argument keys the tool has no parameter for. */
export function unknownKeys(args: Record<string, unknown>, parameters: ToolParameters): string[] {
  return Object.keys(args).filter((key) => !parameters.names.includes(key));
}

/** The server's input-validation refusal: a strict schema, a missing field, a wrong type. */
export function isValidationError(message: string): boolean {
  return /Input validation error|Invalid arguments for tool|-32602/.test(message);
}

/**
 * One lookup per tool per process. A lookup that fails or does not parse (a
 * not-found, a refusal, `{ success: false }`) isn't cached, so a later call can
 * try again.
 */
export function createToolParametersLookup(
  describe: (tool: string) => Promise<unknown>
): ToolParametersLookup {
  const cache = new Map<string, Promise<ToolParameters | undefined>>();
  return (tool) => {
    const hit = cache.get(tool);
    if (hit) return hit;
    const forget = () => {
      if (cache.get(tool) === pending) cache.delete(tool);
    };
    const pending: Promise<ToolParameters | undefined> = describe(tool).then(
      (described) => {
        const parameters = parseDescribedParameters(described);
        if (!parameters) forget();
        return parameters;
      },
      () => {
        forget();
        return undefined;
      }
    );
    cache.set(tool, pending);
    return pending;
  };
}

/**
 * The longest either outcome of a call waits for its tool's parameters. The
 * lookup starts with the call and is usually done first; this bounds a slow or
 * hung one, so optional help never holds a finished call or its cancellation.
 */
export const PARAMETER_LOOKUP_WAIT_MS = 1500;

/**
 * Run an Inkwell call, adding the tool's parameters to a validation error, or
 * an `ignoredParameters` note to a success whose arguments carried a key the
 * tool dropped. `args` are the model's own, before credential resolution.
 * Pass no `lookup` when the caller may not look parameters up.
 */
export async function callWithParameterHelp(
  tool: string,
  args: Record<string, unknown>,
  call: () => Promise<InkToolCallResult>,
  lookup: ToolParametersLookup | undefined,
  waitMs: number = PARAMETER_LOOKUP_WAIT_MS
): Promise<InkToolCallResult> {
  if (!lookup) return call();
  const parameters = lookup(tool).catch(() => undefined);

  let result: InkToolCallResult;
  try {
    result = await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isValidationError(message)) throw error;
    const known = await settledWithin(parameters, waitMs);
    if (!known) throw error;
    const unknown = unknownKeys(args, known);
    const notParameters =
      unknown.length > 0 ? ` Not parameters of ${tool}: ${unknown.join(', ')}.` : '';
    throw new Error(`${message}\n${describeParameters(tool, known)}${notParameters}`, {
      cause: error,
    });
  }

  const known = await settledWithin(parameters, waitMs);
  // Only a schema that drops extra keys lets us say one had no effect; and a
  // result that already carries the field keeps its own.
  if (!known || known.extraKeys !== 'dropped' || !isPlainObject(result)) return result;
  if ('ignoredParameters' in result) return result;
  const ignored = unknownKeys(args, known);
  if (ignored.length === 0) return result;
  return {
    ...result,
    ignoredParameters: {
      names: ignored,
      note: `${ignored.join(', ')} ${ignored.length === 1 ? 'is' : 'are'} not ${ignored.length === 1 ? 'a parameter' : 'parameters'} of ${tool} and had no effect. ${describeParameters(tool, known)}`,
    },
  };
}

/**
 * The promise's value if it settles within `ms`, else `undefined`. The timer is
 * cleared as soon as the promise settles, so a pending wait never holds a
 * non-interactive turn's process open after it has finished.
 */
function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      }
    );
  });
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
