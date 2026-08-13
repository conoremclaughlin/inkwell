import { logger } from '../../utils/logger';

/**
 * Canonical thread read-pointer advance — the ONLY way any code path may
 * move `inbox_thread_read_status.last_read_at`.
 *
 * Spec: ink://specs/inkmail-read-state §2 (approved 2026-08-06).
 *
 * Delegates to the `advance_thread_read_pointer` Postgres function, which is
 * atomic and monotonic (GREATEST of existing vs the message's created_at) and
 * validates the message belongs to the thread. Wall-clock timestamps are
 * banned: the pointer only advances through a real message, so a concurrently
 * inserted, never-seen message can't be marked read.
 *
 * Every failure is logged at error level — a pointer-write failure is a
 * delivery-system fault, never a silent no-op. Four months of silently
 * dropped writes caused the 2026-07-30 replay incident.
 */
// The thread tables are not yet in generated Supabase types — accept any
// client shape that exposes rpc(), mirroring threadTable()'s cast approach.
interface RpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface AdvanceReadPointerParams {
  threadId: string;
  agentId: string;
  /** The pointer advances through this message's created_at. */
  throughMessageId: string;
  /** Call-site label for logs (e.g. 'get_thread_messages:markRead'). */
  source: string;
}

export async function advanceThreadReadPointer(
  supabase: unknown,
  params: AdvanceReadPointerParams
): Promise<boolean> {
  const { threadId, agentId, throughMessageId, source } = params;
  try {
    const { error } = await (supabase as RpcClient).rpc('advance_thread_read_pointer', {
      p_thread_id: threadId,
      p_agent_id: agentId,
      p_through_message_id: throughMessageId,
    });
    if (error) {
      logger.error('[ReadState] Failed to advance thread read pointer', {
        threadId,
        agentId,
        throughMessageId,
        source,
        error: error.message,
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.error('[ReadState] Thread read pointer advance threw', {
      threadId,
      agentId,
      throughMessageId,
      source,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
