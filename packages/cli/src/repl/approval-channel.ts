/**
 * Approval Channel
 *
 * Abstraction over how tool approval requests are emitted and responses received.
 * Three modes:
 *
 * 1. **interactive** — TUI readline/Ink prompt (current default)
 * 2. **jsonl** — structured JSONL on configurable I/O (test harnesses, remote apps, pipes)
 * 3. **remote** — inbox-based approval (existing away-mode pattern)
 *
 * The JSONL protocol is the universal wire format. Interactive mode is a consumer
 * that renders JSONL requests as TUI prompts. Remote mode is a consumer that
 * routes requests to the PCP inbox.
 *
 * ## JSONL Protocol
 *
 * Request (emitted by sb):
 * ```jsonl
 * {"type":"approval_request","id":"<uuid>","tool":"send_to_inbox","args":{...},"reason":"...","sessionId":"...","ts":"..."}
 * ```
 *
 * Response (consumed by sb):
 * ```jsonl
 * {"type":"approval_response","id":"<uuid>","decision":"approved|denied|session|always","by":"conor"}
 * ```
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

// ─── Protocol types ──────────────────────────────────────────────

export interface ApprovalRequestEvent {
  type: 'approval_request';
  id: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  sessionId?: string;
  ts: string;
  /**
   * Present when a shadow clone raised the request. Structured rather than
   * smuggled through `reason`, so the TUI, JSONL consumers, 2FA, audit, and
   * tests all correlate on one key.
   */
  origin?: ApprovalOriginInfo;
}

export type ApprovalResponseDecision = 'once' | 'session' | 'always' | 'deny' | 'cancel';

export interface ApprovalResponseEvent {
  type: 'approval_response';
  id: string;
  decision: ApprovalResponseDecision;
  by?: string;
}

const VALID_DECISIONS: Set<string> = new Set(['once', 'session', 'always', 'deny', 'cancel']);

function isApprovalResponse(obj: Record<string, unknown>): boolean {
  return (
    obj.type === 'approval_response' &&
    typeof obj.id === 'string' &&
    typeof obj.decision === 'string' &&
    VALID_DECISIONS.has(obj.decision)
  );
}

// ─── Channel interface ──────────────────────────────────────────

export interface ApprovalRequestParams {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  sessionId?: string;
  timeoutMs?: number;
  /**
   * Abort the wait. Without this, cancelling a turn cannot reach a request
   * already in flight — it sits for the full timeout (5 minutes by default),
   * which for a shadow clone means Ctrl+C does not actually stop it.
   * Resolves as `cancel` rather than rejecting, so callers keep one code path.
   */
  signal?: AbortSignal;
  /** Who asked. Lets consumers label, correlate, and audit clone requests. */
  origin?: ApprovalOriginInfo;
}

/** Where an approval request came from — the parent turn, or one of its clones. */
export interface ApprovalOriginInfo {
  origin: 'parent' | 'clone';
  /** Stable id of the requesting clone; absent for the parent. */
  cloneId?: string;
  /** Human-facing clone label ("audit auth paths"), for prompts and audit. */
  cloneLabel?: string;
}

export interface ApprovalChannel {
  /**
   * Emit an approval request and wait for a response.
   * Returns the decision (once/session/always/deny/cancel).
   */
  requestApproval(params: ApprovalRequestParams): Promise<ApprovalResponseEvent>;

  /** Clean up resources (timers, listeners, etc.) */
  dispose(): void;
}

// ─── JSONL Channel ──────────────────────────────────────────────

/**
 * JSONL-based approval channel.
 *
 * Emits requests as JSON lines to `output` (writable stream).
 * Reads responses as JSON lines from `input` (readable stream) or an EventEmitter.
 *
 * For test harnesses: wire input/output to mock streams.
 * For remote apps: wire output to a pipe/socket, input from the same.
 * For programmatic use: use the EventEmitter-based `respond()` method.
 */
export class JsonlApprovalChannel implements ApprovalChannel {
  private pending = new Map<
    string,
    {
      resolve: (response: ApprovalResponseEvent) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private emitter = new EventEmitter();
  private lineBuffer = '';
  private onDataHandler?: (chunk: Buffer | string) => void;

  constructor(
    private output: { write: (data: string) => boolean | void },
    private input?: {
      on: (event: string, cb: (data: Buffer | string) => void) => void;
      off?: (event: string, cb: (data: Buffer | string) => void) => void;
    }
  ) {
    if (input) {
      this.onDataHandler = (chunk: Buffer | string) => {
        this.lineBuffer += String(chunk);
        const lines = this.lineBuffer.split('\n');
        this.lineBuffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            if (isApprovalResponse(parsed)) {
              const response = parsed as unknown as ApprovalResponseEvent;
              this.emitter.emit(`response:${response.id}`, response);
            }
          } catch {
            // Ignore non-JSON lines
          }
        }
      };
      input.on('data', this.onDataHandler);
    }
  }

  /**
   * Programmatically respond to a pending request (for test harnesses).
   */
  respond(response: ApprovalResponseEvent): void {
    this.emitter.emit(`response:${response.id}`, response);
  }

  requestApproval(params: ApprovalRequestParams): Promise<ApprovalResponseEvent> {
    const id = randomUUID();
    const timeoutMs = params.timeoutMs ?? 300_000;

    if (params.signal?.aborted) {
      return Promise.resolve({ type: 'approval_response', id, decision: 'cancel', by: 'aborted' });
    }

    const request: ApprovalRequestEvent = {
      type: 'approval_request',
      id,
      tool: params.tool,
      args: params.args,
      reason: params.reason,
      sessionId: params.sessionId,
      ts: new Date().toISOString(),
      ...(params.origin ? { origin: params.origin } : {}),
    };

    // Emit the request as a JSON line
    this.output.write(JSON.stringify(request) + '\n');

    return new Promise<ApprovalResponseEvent>((resolve) => {
      let onAbort: (() => void) | undefined;

      const finish = (response: ApprovalResponseEvent) => {
        this.pending.delete(id);
        this.emitter.removeAllListeners(`response:${id}`);
        if (onAbort) params.signal?.removeEventListener('abort', onAbort);
        resolve(response);
      };

      const timer = setTimeout(() => {
        finish({ type: 'approval_response', id, decision: 'cancel', by: 'timeout' });
      }, timeoutMs);
      if (timer.unref) timer.unref();

      const settle = (response: ApprovalResponseEvent) => {
        clearTimeout(timer);
        finish(response);
      };

      this.pending.set(id, { resolve: settle, timer });

      if (params.signal) {
        onAbort = () =>
          settle({ type: 'approval_response', id, decision: 'cancel', by: 'aborted' });
        params.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.emitter.once(`response:${id}`, (response: ApprovalResponseEvent) => {
        settle(response);
      });
    });
  }

  dispose(): void {
    if (this.input?.off && this.onDataHandler) {
      this.input.off('data', this.onDataHandler);
    }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ type: 'approval_response', id, decision: 'cancel', by: 'disposed' });
    }
    this.pending.clear();
    this.emitter.removeAllListeners();
  }
}

// ─── Auto-approve channel (for non-interactive deny-all or allow-all) ─────

export class AutoApprovalChannel implements ApprovalChannel {
  constructor(private decision: ApprovalResponseDecision = 'cancel') {}

  async requestApproval(params: ApprovalRequestParams): Promise<ApprovalResponseEvent> {
    return {
      type: 'approval_response',
      id: randomUUID(),
      // An auto channel answers instantly, so there is no wait to interrupt —
      // but an already-cancelled turn must not be handed a fresh approval.
      decision: params.signal?.aborted ? 'cancel' : this.decision,
      by: params.signal?.aborted ? 'aborted' : 'auto',
    };
  }

  dispose(): void {
    // Nothing to clean up
  }
}
