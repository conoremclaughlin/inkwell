/**
 * Approval Coordinator
 *
 * Serializes tool-approval prompts to whatever concurrency the *adapter* can
 * actually sustain.
 *
 * Before shadow clones there was only ever one asker, so nothing needed
 * coordinating. Concurrent clones break that: the interactive Ink adapter holds
 * a single input slot (`renderApp.tsx` — `waitForInput()` reassigns
 * `pendingInput` unconditionally), so two simultaneous prompts orphan the first
 * promise forever. A JSONL or 2FA adapter has the opposite property: it already
 * correlates by request id and handles out-of-order responses, so serializing it
 * would only add head-of-line blocking and an N × timeout tail.
 *
 * Hence concurrency is a property of the adapter, not a global constant:
 *
 * | Adapter                   | Concurrency | Why                                  |
 * |---------------------------|-------------|--------------------------------------|
 * | interactive Ink / readline| 1, FIFO     | single input slot                    |
 * | JSONL / remote 2FA        | unbounded   | correlated by request id             |
 * | auto-approve / auto-deny  | unbounded   | answers immediately, nothing to wait |
 *
 * See `ink://specs/ink-runtime-shadow-clones`, Q1.
 */

import { randomUUID } from 'crypto';
import type { ApprovalOriginInfo } from './approval-channel.js';

export type { ApprovalOriginInfo };

/** Concurrency for an adapter that can only ask one question at a time. */
export const SERIAL_CONCURRENCY = 1;

export interface ApprovalTicket<TPolicy = unknown> {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  sessionId?: string;
  /** Parent turn or a named clone. Drives labelling, correlation, and audit. */
  origin: ApprovalOriginInfo;
  /** Cancels the request whether it is queued or already prompting. */
  signal?: AbortSignal;
  /**
   * The policy this request is being made AGAINST — the requester's own, which
   * for a clone is not the parent's.
   *
   * Without it the coordinator rechecks and mutates whatever policy it captured
   * at construction, so a granted clone escalation lands on the parent while the
   * clone's own executor re-checks its unchanged policy and blocks the call
   * anyway. The grant would be spent, the parent widened, and the work still not
   * done.
   */
  policy?: TPolicy;
}

export type ApprovalOutcomeReason =
  | 'granted'
  | 'denied'
  /** A sibling's decision already allowed this tool — never prompted. */
  | 'policy-allow'
  /** A sibling's decision already denied this tool — never prompted. */
  | 'policy-deny'
  /** The ticket's signal fired, queued or mid-prompt. */
  | 'aborted'
  /** The prompt itself threw. Treated as a denial. */
  | 'error';

export interface ApprovalOutcome {
  approved: boolean;
  reason: ApprovalOutcomeReason;
  /** Set when `reason` is 'error'. */
  error?: unknown;
}

/**
 * What to do with a ticket that has reached the front of the queue.
 *
 * `allow`/`deny` short-circuit the prompt. This is the point of re-checking:
 * while a ticket waited, a sibling's "session" or "always" answer may have
 * settled the same tool, and prompting again would ask the user a question they
 * already answered. The check MUST be non-consuming — see
 * `ToolPolicyState.inspectPcpTool`.
 */
export type ApprovalRecheck = 'allow' | 'deny' | 'prompt';

export interface ApprovalCoordinatorOptions<TPolicy = unknown> {
  /**
   * Max prompts in flight. 1 for adapters with a single input slot;
   * `Number.POSITIVE_INFINITY` for id-correlated ones.
   *
   * A function when the answer can change mid-session — toggling away mode
   * swaps the interactive prompt for id-correlated 2FA, and a value frozen at
   * construction would keep serializing requests that no longer need it (or,
   * worse, stop serializing ones that do).
   */
  concurrency: number | (() => number);
  /** Ask the user. Resolves true when approved. */
  prompt: (ticket: ApprovalTicket<TPolicy>, ctx: PromptContext) => Promise<boolean>;
  /**
   * Re-evaluate authority just before prompting. Omit to always prompt.
   * Must not mutate policy.
   */
  recheck?: (ticket: ApprovalTicket<TPolicy>) => ApprovalRecheck;
  /** Notified whenever the queue depth changes, for "2 waiting" affordances. */
  onQueueDepth?: (depth: number) => void;
}

export interface PromptContext {
  /** Stable id for this request, for correlation with the adapter. */
  id: string;
  /**
   * How many tickets are waiting behind this one, RIGHT NOW.
   *
   * A function rather than a number because the queue keeps growing while the
   * prompt is on screen — a value captured at prompt-start is stale by the time
   * anyone reads it, and would under-report "2 more waiting". Adapters that
   * re-render should also subscribe via `onQueueDepth`.
   */
  queuedNow: () => number;
}

interface QueueEntry<TPolicy> {
  id: string;
  ticket: ApprovalTicket<TPolicy>;
  settle: (outcome: ApprovalOutcome) => void;
  settled: boolean;
}

export class ApprovalCoordinator<TPolicy = unknown> {
  private queue: Array<QueueEntry<TPolicy>> = [];
  private active = 0;
  private disposed = false;

  constructor(private readonly options: ApprovalCoordinatorOptions<TPolicy>) {}

  /** Prompts currently in flight plus tickets still waiting. */
  get pending(): number {
    return this.active + this.queue.length;
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  async request(ticket: ApprovalTicket<TPolicy>): Promise<ApprovalOutcome> {
    if (this.disposed) return { approved: false, reason: 'aborted' };
    if (ticket.signal?.aborted) return { approved: false, reason: 'aborted' };

    return new Promise<ApprovalOutcome>((resolve) => {
      const entry: QueueEntry<TPolicy> = {
        id: randomUUID(),
        ticket,
        settled: false,
        settle: () => {},
      };

      let detachAbort: (() => void) | undefined;

      entry.settle = (outcome) => {
        if (entry.settled) return;
        entry.settled = true;
        detachAbort?.();
        resolve(outcome);
      };

      if (ticket.signal) {
        const onAbort = () => {
          // Drop it from the queue so the pump never picks up a dead ticket,
          // then settle. If it is already prompting, the adapter receives the
          // same signal and unwinds on its own.
          this.dropQueued(entry);
          entry.settle({ approved: false, reason: 'aborted' });
        };
        ticket.signal.addEventListener('abort', onAbort, { once: true });
        detachAbort = () => ticket.signal?.removeEventListener('abort', onAbort);
      }

      this.queue.push(entry);
      this.options.onQueueDepth?.(this.queue.length);
      void this.pump();
    });
  }

  /**
   * Settle every queued and in-flight ticket as aborted.
   *
   * In-flight prompts can only be *reported* aborted here — the adapter owns the
   * actual input wait, and unblocks via each ticket's own signal.
   */
  dispose(): void {
    this.disposed = true;
    const draining = this.queue;
    this.queue = [];
    for (const entry of draining) {
      entry.settle({ approved: false, reason: 'aborted' });
    }
    this.options.onQueueDepth?.(0);
  }

  private dropQueued(entry: QueueEntry<TPolicy>): void {
    const index = this.queue.indexOf(entry);
    if (index === -1) return;
    this.queue.splice(index, 1);
    this.options.onQueueDepth?.(this.queue.length);
  }

  private resolveConcurrency(): number {
    const limit =
      typeof this.options.concurrency === 'function'
        ? this.options.concurrency()
        : this.options.concurrency;
    return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : Number.POSITIVE_INFINITY;
  }

  private async pump(): Promise<void> {
    while (this.active < this.resolveConcurrency()) {
      const entry = this.queue.shift();
      if (!entry) return;
      this.options.onQueueDepth?.(this.queue.length);
      // Aborted while it waited — skip without spending a slot.
      if (entry.settled) continue;

      this.active += 1;
      void this.run(entry).finally(() => {
        this.active -= 1;
        // The slot MUST come back even if the prompt threw, or one bad request
        // poisons the FIFO tail and every later approval hangs forever.
        void this.pump();
      });
    }
  }

  private async run(entry: QueueEntry<TPolicy>): Promise<void> {
    const { ticket } = entry;
    try {
      if (entry.settled) return;
      if (ticket.signal?.aborted) {
        entry.settle({ approved: false, reason: 'aborted' });
        return;
      }

      const verdict = this.options.recheck?.(ticket) ?? 'prompt';
      if (verdict === 'allow') {
        entry.settle({ approved: true, reason: 'policy-allow' });
        return;
      }
      if (verdict === 'deny') {
        entry.settle({ approved: false, reason: 'policy-deny' });
        return;
      }

      const approved = await this.options.prompt(ticket, {
        id: entry.id,
        queuedNow: () => this.queue.length,
      });
      entry.settle({ approved, reason: approved ? 'granted' : 'denied' });
    } catch (error) {
      // A prompt that throws is a refusal, not a crash: an aborted Ink input
      // rejects, and the turn it belonged to is already unwinding.
      const aborted = ticket.signal?.aborted === true || isAbortError(error);
      entry.settle(
        aborted
          ? { approved: false, reason: 'aborted' }
          : { approved: false, reason: 'error', error }
      );
    }
  }
}

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | undefined)?.name;
  return name === 'AbortError' || name === 'InkInputAborted';
}

/**
 * Concurrency an adapter can sustain.
 *
 * Interactive adapters own one input slot; everything else correlates responses
 * by id and can run as many as it likes.
 */
export function concurrencyForAdapter(kind: 'interactive' | 'correlated'): number {
  return kind === 'interactive' ? SERIAL_CONCURRENCY : Number.POSITIVE_INFINITY;
}
