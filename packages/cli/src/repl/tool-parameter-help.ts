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
 * ignored key on a success. The lookup starts beside the call, so it adds no
 * wait to a call that needed no help. It never changes what is sent, and a
 * lookup that fails leaves the call's own result or error exactly as it was.
 */

import type { InkToolCallResult } from '../lib/ink-client.js';

/** What `describe_tool` says a tool takes. */
export interface ToolParameters {
  /** Every parameter name, in the schema's order. */
  names: string[];
  /** The ones the schema requires. */
  required: string[];
  /** The schema refuses unknown keys (`additionalProperties: false`). */
  strict: boolean;
}

/** Looks a tool's parameters up; `undefined` when they can't be had. */
export type ToolParametersLookup = (tool: string) => Promise<ToolParameters | undefined>;

/**
 * Read `describe_tool({ name })`'s answer: `{ tool: { parameters } }`, where
 * `parameters` is the JSON Schema the server also serves for tools/list.
 * Anything else, including a not-found, is `undefined`.
 */
export function parseDescribedParameters(described: unknown): ToolParameters | undefined {
  const tool = field(described, 'tool');
  const parameters = field(tool, 'parameters');
  const properties = field(parameters, 'properties');
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return undefined;
  const names = Object.keys(properties);
  const required = field(parameters, 'required');
  return {
    names,
    required: Array.isArray(required)
      ? required.filter((r): r is string => typeof r === 'string' && names.includes(r))
      : [],
    strict: field(parameters, 'additionalProperties') === false,
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
 * One lookup per tool per process. A failed lookup isn't cached, so a later
 * call can try again.
 */
export function createToolParametersLookup(
  describe: (tool: string) => Promise<unknown>
): ToolParametersLookup {
  const cache = new Map<string, Promise<ToolParameters | undefined>>();
  return (tool) => {
    const hit = cache.get(tool);
    if (hit) return hit;
    const pending = describe(tool).then(parseDescribedParameters, () => {
      cache.delete(tool);
      return undefined;
    });
    cache.set(tool, pending);
    return pending;
  };
}

/**
 * How long a successful call waits for its tool's parameters before returning
 * without the ignored-key note. The lookup normally finishes first, since it
 * starts with the call; this only bounds a slow one.
 */
export const IGNORED_KEY_LOOKUP_WAIT_MS = 1500;

/**
 * Run an Inkwell call, adding the tool's parameters to a validation error, or
 * an `ignoredParameters` note to a success whose arguments carried a key the
 * tool doesn't have. `args` are the model's own, before credential resolution.
 */
export async function callWithParameterHelp(
  tool: string,
  args: Record<string, unknown>,
  call: () => Promise<InkToolCallResult>,
  lookup: ToolParametersLookup | undefined,
  waitMs: number = IGNORED_KEY_LOOKUP_WAIT_MS
): Promise<InkToolCallResult> {
  if (!lookup) return call();
  const parameters = lookup(tool).catch(() => undefined);

  let result: InkToolCallResult;
  try {
    result = await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isValidationError(message)) throw error;
    const known = await parameters;
    if (!known) throw error;
    const unknown = unknownKeys(args, known);
    const notParameters =
      unknown.length > 0 ? ` Not parameters of ${tool}: ${unknown.join(', ')}.` : '';
    throw new Error(`${message}\n${describeParameters(tool, known)}${notParameters}`, {
      cause: error,
    });
  }

  const known = await settledWithin(parameters, waitMs);
  if (!known || known.strict || !isPlainObject(result)) return result;
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
