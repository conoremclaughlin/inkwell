/**
 * Live activity stream rendering tiers
 *
 * When attached to an agent's session, the activity poll surfaces
 * everything the agent does. Not all of it deserves the same visual
 * weight:
 *
 *   message-in/out — real conversation crossing a 3rd-party platform
 *                    (Telegram, Discord…). Rendered as proper message
 *                    blocks with directional labels, not ⚡ blocks.
 *   bookkeeping    — the agent's own mechanics (tool calls, state
 *                    changes, backend turn lifecycle). Dim event lines.
 *   block          — everything else (other agents' activity, errors).
 *                    The classic ⚡ activity block.
 */

export interface ActivityLike {
  type?: string;
  subtype?: string;
  agentId?: string;
  platform?: string;
}

export type ActivityRenderMode = 'message-in' | 'message-out' | 'bookkeeping' | 'block';

export interface ActivityRenderPlan {
  mode: ActivityRenderMode;
  /** Message-line role for message modes */
  role?: 'user' | 'assistant';
  /** Display label for message modes (directional) */
  label?: string;
}

const BOOKKEEPING_PREFIXES = [
  'state_change',
  'tool_call',
  'tool_result',
  'agent_spawn',
  'agent_complete',
];

/**
 * Delivery channels whose inbound "messages" are TRIGGERS, not conversation:
 * the session already renders the injected prompt as a labeled system turn,
 * so a message_in block for the same delivery is a duplicate (Conor's
 * 2026-08-12 screenshot: one heartbeat rendered three times — the system
 * turn plus two activity blocks).
 */
const INTERNAL_MESSAGE_PLATFORMS = new Set(['heartbeat', 'internal']);

export function classifyActivity(activity: ActivityLike, selfAgentId: string): ActivityRenderPlan {
  const rawType = activity.subtype
    ? `${activity.type}:${activity.subtype}`
    : activity.type || 'activity';
  const actor = activity.agentId || 'system';
  const platform = activity.platform || 'channel';

  if (rawType.startsWith('message_in')) {
    // Only a genuine external platform (telegram, discord, …) is real
    // inbound conversation. Trigger deliveries — internal platforms or
    // platformless routing records — stay dim bookkeeping receipts; their
    // content already renders as the injected system turn.
    if (!activity.platform || INTERNAL_MESSAGE_PLATFORMS.has(activity.platform)) {
      return { mode: 'bookkeeping' };
    }
    // The human's words arriving via a platform — render as a user message
    return { mode: 'message-in', role: 'user', label: `📨 ${platform} → ${actor}` };
  }
  if (rawType.startsWith('message_out')) {
    // The agent's words leaving via a platform — render as the agent speaking
    return { mode: 'message-out', role: 'assistant', label: `📤 ${actor} → ${platform}` };
  }
  if (activity.agentId === selfAgentId && BOOKKEEPING_PREFIXES.some((p) => rawType.startsWith(p))) {
    return { mode: 'bookkeeping' };
  }
  return { mode: 'block' };
}
