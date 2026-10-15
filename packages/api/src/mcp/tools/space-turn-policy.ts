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
 * Phase 1 compares the signed canonical thread key. Resolving a thread UUID
 * server-side, so a conversation id may be given either way, comes with the
 * turn wiring.
 */

import { isSpaceTurnScope } from '../../auth/token-scope';

/** The only tools a space-turn token reaches. */
export const SPACE_TURN_TOOLS = ['get_thread_messages', 'send_response'] as const;

export type SpaceTurnRefusalCode = 'space_turn_tool_not_allowed' | 'space_turn_thread_mismatch';

export interface SpaceTurnRefusal {
  code: SpaceTurnRefusalCode;
  message: string;
}

/** The signed parts of the request context this policy reads. */
export interface SpaceTurnTokenContext {
  tokenScope?: string;
  tokenThreadKey?: string;
}

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

/**
 * Why this call may not run under the request's token, or null if it may.
 *
 * A token that isn't space-turn scoped is never refused here: its tools are
 * decided where they always were. A space-turn token is refused any tool
 * outside SPACE_TURN_TOOLS, known or not, and any call to an allowed tool
 * that doesn't address the token's own thread.
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
