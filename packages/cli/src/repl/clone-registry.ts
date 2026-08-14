/**
 * Clone Registry
 *
 * Every shadow clone this process has spawned, running or finished.
 *
 * The registry exists because a clone outlives the tool call that started it.
 * `runAgentLoop` is in-process, so a backgrounded clone keeps working while the
 * parent moves on — switches sessions inside ink, answers the user, starts
 * another turn. Something has to hold the handle to that work, name it, and let
 * the TUI (and later the desktop app) navigate to it. That is this.
 *
 * In-process and non-durable by design: a clone is bounded work handed back to
 * its parent, not a session that should survive a restart. What survives is the
 * clone's JSONL transcript on disk and whatever the parent chose to keep.
 *
 * See `ink://specs/ink-runtime-shadow-clones`.
 */

import type { AgentLoopStopReason } from './agent-loop.js';

export type CloneStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface CloneRecord {
  /** Short, stable, human-typeable: `clone-1`. Used by the TUI and tools. */
  id: string;
  label: string;
  prompt: string;
  status: CloneStatus;
  /** The parent's PCP session, so the graph can link a clone to its origin. */
  parentSessionId?: string;
  /** The clone's own JSONL transcript: `<parent>.<id>.jsonl`. */
  transcriptPath: string;
  startedAt: number;
  endedAt?: number;
  /** Backend turns the clone's loop ran. */
  iterations: number;
  /** Tool calls the clone executed, for a one-glance sense of what it did. */
  toolCalls: number;
  stopReason?: AgentLoopStopReason;
  /**
   * Someone asked this clone to stop; its loop has not unwound yet.
   *
   * The status stays `running` until it actually settles, because that is what
   * `runningCount` — and therefore the concurrency ceiling — is counting. Marking
   * it aborted the moment cancel is requested would free a slot while the
   * backend child is still alive, letting a new fan-out overlap the old one.
   */
  cancelRequested?: boolean;
  /** What the clone hands back. Bounded before it reaches the parent's ledger. */
  summary?: string;
  error?: string;
}

export interface CloneRegistryChange {
  record: CloneRecord;
  kind: 'registered' | 'updated' | 'settled';
}

/** Terminal states — a settled clone will not change again. */
export function isSettled(status: CloneStatus): boolean {
  return status !== 'running';
}

export class CloneRegistry {
  private records = new Map<string, CloneRecord>();
  private order: string[] = [];
  private listeners = new Set<(change: CloneRegistryChange) => void>();
  /**
   * How to stop a running clone. Kept beside the records rather than inside
   * them: a `CloneRecord` is data — it goes over the wire to the TUI and, later,
   * the desktop app — and a function is not.
   */
  private cancellers = new Map<string, () => void>();
  private seq = 0;

  /** Sequential id: readable in a prompt, typeable in the TUI. */
  nextId(): string {
    this.seq += 1;
    return `clone-${this.seq}`;
  }

  register(
    input: Omit<CloneRecord, 'status' | 'startedAt' | 'iterations' | 'toolCalls'> & {
      startedAt?: number;
    }
  ): CloneRecord {
    const record: CloneRecord = {
      ...input,
      status: 'running',
      startedAt: input.startedAt ?? Date.now(),
      iterations: 0,
      toolCalls: 0,
    };
    this.records.set(record.id, record);
    this.order.push(record.id);
    this.emit({ record, kind: 'registered' });
    return record;
  }

  update(id: string, patch: Partial<Omit<CloneRecord, 'id'>>): CloneRecord | undefined {
    const current = this.records.get(id);
    if (!current) return undefined;
    // Terminal states are MONOTONIC. A settled clone is final — late writes from
    // a loop still unwinding must not resurrect it, and must not swap one
    // outcome for another. Without that, cancelling produced records like
    // `{status: 'completed', error: 'cancelled', summary: 'late success'}`.
    if (isSettled(current.status)) return current;

    const next: CloneRecord = { ...current, ...patch };

    // A cancelled clone settles as aborted, whatever its loop reports on the way
    // out. The user's decision outranks whatever the backend managed last.
    if (current.cancelRequested && isSettled(next.status)) {
      next.status = 'aborted';
      next.error = next.error ?? 'cancelled';
    }
    if (isSettled(next.status)) {
      if (next.endedAt === undefined) next.endedAt = Date.now();
      // Nothing left to cancel — drop the closure so a long session does not
      // accumulate one per clone it has ever run.
      this.cancellers.delete(id);
    }
    this.records.set(id, next);
    this.emit({ record: next, kind: isSettled(next.status) ? 'settled' : 'updated' });
    return next;
  }

  get(id: string): CloneRecord | undefined {
    return this.records.get(id);
  }

  /**
   * Register how to stop this clone.
   *
   * Load-bearing for background clones specifically: a clone spawned with
   * `wait:false` outlives the turn that started it, so the turn's own abort
   * handler can no longer reach it. Without a canceller here, a runaway
   * background clone cannot be stopped, and a still-running one at session end
   * keeps its backend child alive — which keeps the whole process alive.
   */
  attachCanceller(id: string, cancel: () => void): void {
    this.cancellers.set(id, cancel);
  }

  /** Stop one running clone. Returns false if it is unknown or already settled. */
  cancel(id: string): boolean {
    const record = this.records.get(id);
    if (!record || isSettled(record.status)) return false;
    const cancel = this.cancellers.get(id);
    this.cancellers.delete(id);
    // Record the intent BEFORE firing, so a synchronous unwind still settles as
    // aborted rather than racing the flag.
    this.update(id, { cancelRequested: true, error: 'cancelled' });
    cancel?.();
    return true;
  }

  /** Stop every running clone. Returns how many were still running. */
  cancelAll(): number {
    const running = this.list({ status: 'running' });
    for (const record of running) this.cancel(record.id);
    return running.length;
  }

  /** Insertion order — the order the parent spawned them, which is how it thinks. */
  list(filter?: { status?: CloneStatus | 'settled' }): CloneRecord[] {
    const all = this.order
      .map((id) => this.records.get(id))
      .filter((r): r is CloneRecord => r !== undefined);
    if (!filter?.status) return all;
    if (filter.status === 'settled') return all.filter((r) => isSettled(r.status));
    return all.filter((r) => r.status === filter.status);
  }

  get runningCount(): number {
    return this.list({ status: 'running' }).length;
  }

  /** Subscribe to changes; returns an unsubscribe function. */
  onChange(listener: (change: CloneRegistryChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: CloneRegistryChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // A subscriber (usually the TUI) must never take down a clone.
      }
    }
  }
}

/** One-line status for the TUI and for `/clones`. */
export function formatCloneLine(record: CloneRecord): string {
  const icon =
    record.status === 'running'
      ? record.cancelRequested
        ? '⏹'
        : '🌀'
      : record.status === 'completed'
        ? '✅'
        : record.status === 'aborted'
          ? '↩'
          : '⚠️';
  const elapsedMs = (record.endedAt ?? Date.now()) - record.startedAt;
  const elapsed = elapsedMs < 1000 ? '<1s' : `${Math.round(elapsedMs / 1000)}s`;
  const detail =
    record.status === 'running'
      ? record.cancelRequested
        ? `cancelling — ${record.iterations} turn(s), ${record.toolCalls} tool call(s)`
        : `${record.iterations} turn(s), ${record.toolCalls} tool call(s)`
      : (record.error ?? record.stopReason ?? record.status);
  return `${icon} ${record.id} · ${record.label} — ${detail} (${elapsed})`;
}
