/** Existing Ink MCP text/media/error envelope parsing, independent of transport/auth. */
import type { InkToolCallResult } from './tool-result.js';
interface JsonRpcToolResult {
  content?: Array<{ type?: string; text?: string }>;
  /** MCP's per-call failure flag — set for validation errors, unknown tools, thrown handlers. */
  isError?: boolean;
  [key: string]: unknown;
}

export interface JsonRpcResponse {
  result?: JsonRpcToolResult;
  error?: { code?: number; message?: string };
}

/**
 * A text-derived payload with the call's image blocks kept beside it.
 *
 * The text is the payload callers read, so it is unwrapped as it always was;
 * but a result can carry an image next to that text, and unwrapping alone
 * dropped it (Lumen, PR #708). The images go on a top-level `content`, where
 * the chat runtime's capture step looks. With no image blocks the payload is
 * returned exactly as parsed.
 *
 * The payload is never edited. `content` is added only to an object that has
 * no `content` of its own; anything else — a JSON value that is not an object,
 * or an object whose own `content` is application data of any shape — is kept
 * whole under `result`. Merging into that key erased a string or object and
 * blended image blocks into an array (Lumen, PR #708 round 2).
 *
 * A wrapped payload's failure flags are copied up beside it, as they are.
 * `success` and `isError` are read at the top level by every failure predicate
 * (isSemanticFailure, isErrorPayload); nested under `result` a failed call read
 * as a receipt (Lumen, PR #708 round 3). The predicates stay as they are:
 * treating arbitrary nested data as a failure signal would be its own bug.
 */
const FAILURE_FLAGS = ['success', 'isError'] as const;

function withImageBlocks(
  parsed: unknown,
  content: JsonRpcToolResult['content']
): InkToolCallResult {
  const images = (content ?? []).filter((item) => item?.type === 'image');
  if (images.length === 0) return parsed as InkToolCallResult;
  const isObject = Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
  const own = (key: string) => isObject && Object.prototype.hasOwnProperty.call(parsed, key);
  if (isObject && !own('content')) {
    return { ...(parsed as InkToolCallResult), content: images };
  }
  const flags: InkToolCallResult = {};
  for (const key of FAILURE_FLAGS) {
    if (own(key)) flags[key] = (parsed as InkToolCallResult)[key];
  }
  return { ...flags, result: parsed, content: images };
}

export function parseJsonRpcToolPayload(payload: JsonRpcResponse): InkToolCallResult {
  if (payload.error) {
    throw new Error(`Inkwell tool error (${payload.error.code}): ${payload.error.message}`);
  }

  const toolResult = payload.result;
  const firstText = toolResult?.content?.find((item) => typeof item.text === 'string')?.text;
  if (typeof firstText === 'string') {
    try {
      return withImageBlocks(JSON.parse(firstText), toolResult?.content);
    } catch {
      // Unparseable text on an isError result is a protocol-level failure —
      // argument validation, an unknown tool, a thrown handler. The server
      // reports these as `isError` with a bare message rather than the usual
      // JSON envelope, and returning `{ text }` here made them indistinguishable
      // from success: callers read a result object with no `sessions` key and
      // concluded there were no sessions. Throw so a failed call fails.
      //
      // Structured `{"success":false,...}` bodies deliberately do NOT come
      // through here — they parse as JSON above and keep their existing
      // contract, because callers inspect `success` and expect to.
      if (toolResult?.isError) {
        throw new Error(`Inkwell tool call failed: ${firstText}`);
      }
      return withImageBlocks({ text: firstText }, toolResult?.content);
    }
  }

  // CallToolResult content is not restricted to text. Preserve the failure
  // boundary even when an error contains only media (or no content at all),
  // rather than returning the raw isError object as a successful result.
  if (toolResult?.isError) {
    throw new Error('Inkwell tool call failed without a text error message');
  }

  return (toolResult as InkToolCallResult) || {};
}

function parseSseJsonRpcResponse(raw: string): JsonRpcResponse {
  const lines = raw.split(/\r?\n/);
  const events: string[] = [];
  let currentData: string[] = [];

  const flush = () => {
    if (currentData.length > 0) {
      events.push(currentData.join('\n'));
      currentData = [];
    }
  };

  for (const line of lines) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (line.startsWith('data:')) {
      currentData.push(line.slice(5).trimStart());
    }
  }
  flush();

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const chunk = events[i]?.trim();
    if (!chunk || chunk === '[DONE]') continue;
    try {
      return JSON.parse(chunk) as JsonRpcResponse;
    } catch {
      // Keep scanning previous events.
    }
  }

  const preview = raw.replace(/\s+/g, ' ').slice(0, 240);
  throw new Error(`Unable to parse JSON-RPC response from SSE payload: ${preview}`);
}

export function parseJsonRpcResponse(raw: string): JsonRpcResponse {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Empty JSON-RPC response body');
  }

  // Some streamable HTTP servers return SSE framing for POST responses.
  // Scan each line once; \n\s* retries the same newline run quadratically.
  if (
    trimmed.split('\n').some((line) => {
      const start = line.trimStart();
      return start.startsWith('event:') || start.startsWith('data:');
    })
  ) {
    return parseSseJsonRpcResponse(trimmed);
  }

  return JSON.parse(trimmed) as JsonRpcResponse;
}
