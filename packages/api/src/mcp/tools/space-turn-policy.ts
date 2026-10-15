/**
 * What a space-turn token may call.
 *
 * A turn in a shared conversation runs with a token scoped `mcp:space-turn`
 * (auth/token-scope.ts). registerAllTools asks this module before every
 * handler; a refusal returns before the handler runs, so no tool body ever
 * sees such a call. Only the tools below are reachable, and each only for the
 * thread the token was signed for (ink://specs/inkling-multi-person-groups,
 * "Enforcement is in code").
 *
 * Who reads is the token's identity, never an argument: get_thread_messages
 * is pinned to the thread and how to read it, and its sbSlug may only name
 * the token's own SB, whatever ENFORCE_IDENTITY_PINNING says.
 *
 * The thread is bound twice: the call must name the signed key, and the
 * thread that key resolves to, looked up the way the handler will look it
 * up, must be the signed thread id in the signed workspace (Phase 2 gate 3).
 * The lookup is injected, so this module stays pure.
 */

import { isSpaceTurnScope } from '../../auth/token-scope';

/** The only tools a space-turn token reaches. */
export const SPACE_TURN_TOOLS = ['get_thread_messages', 'send_response'] as const;
export type SpaceTurnTool = (typeof SPACE_TURN_TOOLS)[number];

/**
 * The only send_response fields a space-turn call may carry. Media, voice,
 * reply-to and metadata are refused whatever the channel later accepts
 * (Phase 2 gate 5).
 */
export const SPACE_TURN_SEND_FIELDS = ['channel', 'conversationId', 'content'] as const;

/**
 * The only get_thread_messages fields a space-turn call may carry: the thread
 * and how to read it. userId, email, phone, platform and platformId are
 * refused, so nothing redirects the read to another principal, and sbSlug
 * passes only naming the token's own SB (Phase 2 gate 3).
 */
export const SPACE_TURN_READ_FIELDS = [
  'threadKey',
  'sbSlug',
  'limit',
  'beforeMessageId',
  'afterMessageId',
  'includeSystemEvents',
  'markRead',
  'fullHistory',
  'newerThan',
  'latestN',
  'channelPoll',
] as const;

export type SpaceTurnRefusalCode =
  | 'space_turn_tool_not_allowed'
  | 'space_turn_field_not_allowed'
  | 'space_turn_thread_mismatch'
  | 'space_turn_thread_unresolved';

export interface SpaceTurnRefusal {
  code: SpaceTurnRefusalCode;
  message: string;
}

/** The signed parts of the request context this policy reads. */
export interface SpaceTurnTokenContext {
  tokenScope?: string;
  tokenSlug?: string;
  tokenThreadKey?: string;
  tokenThreadId?: string;
  tokenWorkspaceId?: string;
}

/** A thread as the handler would find it. */
export interface ResolvedSpaceTurnThread {
  id: string;
  workspaceId: string;
}

/**
 * Finds the thread an allowed call addresses, exactly as that tool's handler
 * will: null when there is none, a throw when it can't be read or the key is
 * ambiguous. The production resolver wraps the handlers' own lookups
 * (space-turn-thread-resolver.ts).
 */
export type SpaceTurnThreadResolver = (
  toolName: SpaceTurnTool,
  args: unknown
) => Promise<ResolvedSpaceTurnThread | null>;

export type SpaceTurnDecision =
  | { allowed: false; refusal: SpaceTurnRefusal }
  | { allowed: true; thread?: ResolvedSpaceTurnThread };

function argString(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** The thread a call to an allowed tool addresses, or undefined if it names none. */
function addressedThreadKey(toolName: string, args: unknown): string | undefined {
  if (toolName === 'get_thread_messages') return argString(args, 'threadKey');
  if (toolName === 'send_response') {
    return argString(args, 'channel') === 'inkling' ? argString(args, 'conversationId') : undefined;
  }
  return undefined;
}

/** A field outside a tool's pinned set that carries a value, if any. */
function unpinnedField(args: unknown, pinned: readonly string[]): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  return Object.entries(args as Record<string, unknown>).find(
    ([key, value]) => value !== undefined && !pinned.includes(key)
  )?.[0];
}

/**
 * Why this call may not run under the request's token, or null if it may,
 * judged without any lookup.
 *
 * A token that isn't space-turn scoped is never refused here: its tools are
 * decided where they always were. A space-turn token is refused any tool
 * outside SPACE_TURN_TOOLS, known or not, a field outside the tool's pinned
 * set, a get_thread_messages sbSlug that isn't the token's own, and any call
 * that doesn't name the token's own thread key.
 */
export function spaceTurnRefusal(
  toolName: string,
  args: unknown,
  context: SpaceTurnTokenContext | undefined
): SpaceTurnRefusal | null {
  if (!isSpaceTurnScope(context?.tokenScope)) return null;

  if (!(SPACE_TURN_TOOLS as readonly string[]).includes(toolName)) {
    return {
      code: 'space_turn_tool_not_allowed',
      message: `${toolName} is not available in a shared conversation`,
    };
  }

  const field = unpinnedField(
    args,
    toolName === 'send_response' ? SPACE_TURN_SEND_FIELDS : SPACE_TURN_READ_FIELDS
  );
  if (field) {
    return {
      code: 'space_turn_field_not_allowed',
      message: `${toolName} may not carry ${field} in a shared conversation`,
    };
  }

  if (toolName === 'get_thread_messages') {
    const readAs = (args as Record<string, unknown> | null | undefined)?.sbSlug;
    if (readAs !== undefined && readAs !== context?.tokenSlug) {
      return {
        code: 'space_turn_field_not_allowed',
        message: 'get_thread_messages may only read as this inkling in a shared conversation',
      };
    }
  }

  const ownThread = context?.tokenThreadKey;
  const addressed = addressedThreadKey(toolName, args);
  if (!ownThread || !addressed || addressed !== ownThread) {
    return {
      code: 'space_turn_thread_mismatch',
      message: `${toolName} may only address this conversation`,
    };
  }

  return null;
}

/**
 * The whole decision for one call: spaceTurnRefusal, then the thread the
 * call names, resolved as its handler will resolve it, must be the signed
 * thread id in the signed workspace. Unresolvable, ambiguous or mismatched
 * refuses. An allowed space-turn call carries the resolved thread, so the
 * wrapper can hand the handler exactly what was checked.
 */
export async function decideSpaceTurnCall(
  toolName: string,
  args: unknown,
  context: SpaceTurnTokenContext | undefined,
  resolveThread: SpaceTurnThreadResolver
): Promise<SpaceTurnDecision> {
  if (!isSpaceTurnScope(context?.tokenScope)) return { allowed: true };

  const refusal = spaceTurnRefusal(toolName, args, context);
  if (refusal) return { allowed: false, refusal };

  let thread: ResolvedSpaceTurnThread | null;
  try {
    thread = await resolveThread(toolName as SpaceTurnTool, args);
  } catch {
    thread = null;
  }
  if (!thread) {
    return {
      allowed: false,
      refusal: {
        code: 'space_turn_thread_unresolved',
        message: `${toolName} could not find this conversation`,
      },
    };
  }
  if (
    !context?.tokenThreadId ||
    !context.tokenWorkspaceId ||
    thread.id !== context.tokenThreadId ||
    thread.workspaceId !== context.tokenWorkspaceId
  ) {
    return {
      allowed: false,
      refusal: {
        code: 'space_turn_thread_mismatch',
        message: `${toolName} may only address this conversation`,
      },
    };
  }
  return { allowed: true, thread };
}

/**
 * The handler arguments an allowed space-turn call runs with. send_response
 * accepts a thread id, so it is handed the resolved id and acts on exactly
 * the thread that was checked. get_thread_messages takes only a key; it is
 * left as it is.
 */
export function spaceTurnHandlerArgs(
  toolName: string,
  handlerArgs: unknown[],
  thread: ResolvedSpaceTurnThread
): unknown[] {
  if (toolName !== 'send_response') return handlerArgs;
  const [args, ...rest] = handlerArgs;
  return [{ ...(args as Record<string, unknown>), conversationId: thread.id }, ...rest];
}

/** The tool result a refused call returns in place of its handler's. */
export function spaceTurnRefusalResult(refusal: SpaceTurnRefusal) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: false, error: refusal.message, code: refusal.code }),
      },
    ],
    isError: true,
  };
}
