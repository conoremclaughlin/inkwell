/**
 * What the agent loop stores as the assistant text of a local-tool-routing
 * turn that ended on tool calls with no prose. It describes the transcript,
 * not anything the SB said, so a consumer looking for a reply must not take it
 * for one (runner/turn-reply.ts).
 */
export const LOCAL_TOOL_CALL_PLACEHOLDER = '(local tool call emitted; see tool results above)';
