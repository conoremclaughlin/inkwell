/**
 * Approval Request Manager
 *
 * Two-phase deferred promise pattern for remote tool approval.
 * When a tool call needs approval and the user is away:
 * 1. register() creates a pending request and returns a promise
 * 2. The request is sent to inbox as a permission_request
 * 3. The promise resolves when resolve() is called (from inbox poll finding a matching grant)
 *    or when the request times out / is cancelled
 *
 * Inspired by Openclaw's ExecApprovalManager pattern.
 */

import { randomUUID } from 'crypto';

export type ApprovalDecision = 'approved' | 'denied' | 'timeout';

export interface ApprovalRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  createdAt: number;
  timeoutMs: number;
}

export interface ApprovalResponse {
  requestId: string;
  decision: ApprovalDecision;
  resolvedBy?: string;
}

interface PendingEntry {
  request: ApprovalRequest;
  resolve: (response: ApprovalResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalRequestManager {
  private pending = new Map<string, PendingEntry>();

  /**
   * Register a new approval request.
   * Returns a promise that resolves when the request is approved, denied, or times out.
   */
  register(
    tool: string,
    args: Record<string, unknown>,
    reason: string,
    timeoutMs = 300_000 // 5 minutes default
  ): { request: ApprovalRequest; promise: Promise<ApprovalResponse> } {
    const request: ApprovalRequest = {
      id: randomUUID(),
      tool,
      args,
      reason,
      createdAt: Date.now(),
      timeoutMs,
    };

    const promise = new Promise<ApprovalResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.expire(request.id);
      }, timeoutMs);

      // Don't hold the process open for the timer
      if (timer.unref) timer.unref();

      this.pending.set(request.id, { request, resolve, timer });
    });

    return { request, promise };
  }

  /**
   * Resolve a pending request with a decision.
   * Returns true if the request was found and resolved.
   */
  resolve(requestId: string, decision: ApprovalDecision, resolvedBy?: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve({ requestId, decision, resolvedBy });
    return true;
  }

  /**
   * Expire a pending request (timeout).
   */
  expire(requestId: string): boolean {
    return this.resolve(requestId, 'timeout');
  }

  /**
   * Get all pending requests.
   */
  getPending(): ApprovalRequest[] {
    return Array.from(this.pending.values()).map((e) => e.request);
  }

  /**
   * Check if a request ID is pending.
   */
  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /**
   * Find a pending request that matches a tool name.
   * Used when a permission grant arrives without a specific requestId
   * but matches the tool being waited on.
   */
  findPendingForTool(tool: string): ApprovalRequest | undefined {
    for (const entry of this.pending.values()) {
      if (entry.request.tool === tool) return entry.request;
    }
    return undefined;
  }

  /**
   * Cancel all pending requests.
   */
  cancelAll(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ requestId: id, decision: 'denied', resolvedBy: 'session-end' });
    }
    this.pending.clear();
  }

  /**
   * Number of pending requests.
   */
  get size(): number {
    return this.pending.size;
  }
}
