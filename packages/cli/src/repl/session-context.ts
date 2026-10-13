/** CLI lookup only; the recovery format and budget are shared with replay. */
import {
  recoverSessionContext,
  SESSION_CONTEXT_LIMIT,
  type RecoveredSessionContext,
} from '@inklabs/shared/runtime';
export {
  SESSION_CONTEXT_LIMIT,
  SESSION_CONTEXT_SOURCE,
  SESSION_CONTEXT_NOTE_MAX_BYTES,
  sessionContextNote,
  sessionContextStatusText,
  type SessionContextStatus,
  type RecoveredSessionContext,
} from '@inklabs/shared/runtime';

export async function loadSessionContext(
  client: { callTool(tool: string, args: Record<string, unknown>): Promise<unknown> },
  sessionId: string
): Promise<RecoveredSessionContext> {
  let result: unknown;
  try {
    result = await client.callTool('get_session_context', {
      sessionId,
      limit: SESSION_CONTEXT_LIMIT,
    });
  } catch {
    // Never include private transport error text in the recovery note.
  }
  return recoverSessionContext(result);
}
