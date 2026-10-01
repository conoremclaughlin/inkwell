import {
  PendingCodexDelivery,
  UnconfirmedCodexDelivery,
  type CodexMailDelivery,
} from './delivery.js';

/** Report state changes, not repeated polls. An exact receipt clears and
 * reports its recovery; a new failure after recovery is visible again. */
export class CodexMailDiagnostics {
  private firstMissing = new Map<string, number>();
  private lastWarning = new Map<string, string>();
  constructor(
    private emit: (message: string) => void,
    private now: () => number = Date.now
  ) {}

  warn(message: string, key = message) {
    if (this.lastWarning.get(key) === message) return;
    this.lastWarning.set(key, message);
    this.emit(message);
  }

  clearWarning(key: string, recovery?: string) {
    if (this.lastWarning.delete(key) && recovery) this.emit(recovery);
  }

  async deliver(
    delivery: Pick<CodexMailDelivery, 'deliver'>,
    messageId: string,
    content: string,
    meta: Record<string, unknown>
  ) {
    const thread =
      typeof meta.thread_key === 'string' && meta.thread_key
        ? meta.thread_key
        : 'legacy inbox (global read pointer)';
    const label = `message ${messageId} in ${thread}`;
    const key = `delivery:${messageId}`;
    try {
      await delivery.deliver(messageId, content, meta);
      this.firstMissing.delete(key);
      if (this.lastWarning.delete(key))
        this.emit(
          `Exact receipt confirmed for ${label}; its read acknowledgement can now proceed.`
        );
    } catch (error) {
      // The TUI can dequeue between scans before recording the completed
      // item. Quiet only this known transition, never transport/journal errors.
      // We STILL throw: the drain must not ACK, skip or resend during grace.
      if (error instanceof UnconfirmedCodexDelivery) {
        const since = this.firstMissing.get(key) ?? this.now();
        this.firstMissing.set(key, since);
        if (this.now() - since < 15_000) throw error;
      } else {
        this.firstMissing.delete(key);
      }
      if (!(error instanceof PendingCodexDelivery)) {
        this.warn(
          `${label}: ${error instanceof Error ? error.message : 'delivery failed'}. ` +
            'Later mail behind this message is held unread; reconciliation continues without resending. ' +
            'If this persists, see docs/codex-inkmail.md#recovering-a-blocked-message.',
          key
        );
      }
      throw error;
    }
  }
}
