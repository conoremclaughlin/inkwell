import { randomUUID } from 'node:crypto';
import { LIMITS, validateBatchInput, webSearchQuerySchema } from './config.js';
import { staticError, WebSearchError, type WebSearchReason } from './errors.js';
import { searchWebBatch } from './index.js';
import { SearchObservations, type SearchObservationSnapshot } from './observations.js';
import type { WebSearchBatchInput, WebSearchBatchItem, WebSearchBatchOutput } from './types.js';

export const QUEUE_LIMITS = Object.freeze({
  collectMs: 25,
  waitMs: 30_000,
  requests: 16,
  queries: 32,
});

export interface CoordinatedSearchInput extends WebSearchBatchInput {
  /** Resolved by the authenticated handler, NEVER forwarded from tool arguments. */
  accountId: string;
  /** Operator policy snapshot; not a public tool argument. */
  contentRecording: boolean;
}

export interface CoordinatedSearchOutput {
  batchId: string;
  provider: WebSearchBatchOutput['provider'];
  model: string;
  items: WebSearchBatchItem[];
  /** Shared across this batchId. Do not count this as a separate bill per caller. */
  batchUsage: Pick<WebSearchBatchOutput, 'modelToolCallCount' | 'nativeSearchCount' | 'usage'>;
}

export class CoordinatedSearchError extends WebSearchError {
  constructor(
    reason: WebSearchReason,
    launched: boolean,
    readonly batchId?: string
  ) {
    super(reason, launched);
  }
}

export interface SearchBatchRecord {
  accountId: string;
  batchId: string;
  contentRecording: boolean;
  searchMayHaveRun: boolean;
  reason?: WebSearchReason;
  observations: SearchObservationSnapshot;
}

interface Pending {
  accountId: string;
  contentRecording: boolean;
  queries: string[];
  maxResults: number;
  signal?: AbortSignal;
  resolve(value: CoordinatedSearchOutput): void;
  reject(error: CoordinatedSearchError): void;
  onAbort(): void;
  timer?: ReturnType<typeof setTimeout>;
  batch?: Running;
  settled: boolean;
}

interface Running {
  id: string;
  members: Pending[];
  controller: AbortController;
}

/**
 * Bounded FIFO coalescing, not a durable job queue or retry engine. Each caller
 * must have passed permission and required request audit BEFORE submit. Only
 * consecutive same-account callers share context; never skip another account.
 * The MCP handler supplies the caller-specific audit/receipt boundary.
 */
export class SearchCoordinator {
  private queue: Pending[] = [];
  private running?: Running;
  private collection?: ReturnType<typeof setTimeout>;
  private quarantined = false;

  constructor(
    private readonly run = searchWebBatch,
    private readonly recordBatch?: (record: SearchBatchRecord) => Promise<void>
  ) {}

  async submit(input: CoordinatedSearchInput): Promise<CoordinatedSearchOutput> {
    try {
      const { accountId, contentRecording, ...providerInput } = input;
      if (
        !accountId ||
        typeof accountId !== 'string' ||
        accountId.length > 200 ||
        typeof contentRecording !== 'boolean'
      )
        throw new WebSearchError('invalid_input');
      const parsed = validateBatchInput(providerInput);
      // The provider deduplicates; the caller keeps all original positions.
      const queries = input.queries.map((query) => webSearchQuerySchema.parse(query));
      if (this.quarantined) throw new WebSearchError('service_quarantined');
      if (
        this.queue.length >= QUEUE_LIMITS.requests ||
        this.queue.reduce((n, item) => n + item.queries.length, 0) + queries.length >
          QUEUE_LIMITS.queries
      )
        throw new WebSearchError('capacity_exhausted');
      return await new Promise<CoordinatedSearchOutput>((resolve, reject) => {
        const pending: Pending = {
          accountId,
          contentRecording,
          queries,
          maxResults: parsed.maxResults,
          signal: parsed.signal,
          resolve,
          reject,
          settled: false,
          onAbort: () => this.cancel(pending),
        };
        this.queue.push(pending);
        pending.signal?.addEventListener('abort', pending.onAbort, { once: true });
        pending.timer = setTimeout(() => {
          if (!pending.batch)
            this.fail(pending, new CoordinatedSearchError('queue_timeout', false));
        }, QUEUE_LIMITS.waitMs);
        this.schedule();
      });
    } catch (error) {
      if (error instanceof CoordinatedSearchError) throw error;
      // Only validation/admission happens outside the per-request promise.
      throw new CoordinatedSearchError(staticError(error).reason, false);
    }
  }

  private settle(pending: Pending): boolean {
    if (pending.settled) return false;
    pending.settled = true;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.onAbort);
    const index = this.queue.indexOf(pending);
    if (index !== -1) this.queue.splice(index, 1);
    if (!this.queue.length && this.collection) {
      clearTimeout(this.collection);
      this.collection = undefined;
    }
    return true;
  }

  private fail(pending: Pending, error: CoordinatedSearchError): void {
    if (this.settle(pending)) pending.reject(error);
  }

  private cancel(pending: Pending): void {
    this.fail(pending, new CoordinatedSearchError('cancelled', !!pending.batch, pending.batch?.id));
    const batch = pending.batch;
    if (batch && batch.members.every((member) => member.settled)) batch.controller.abort();
  }

  private schedule(): void {
    if (this.running || this.collection || !this.queue.length) return;
    this.collection = setTimeout(() => {
      this.collection = undefined;
      void this.dispatch();
    }, QUEUE_LIMITS.collectMs);
  }

  private async dispatch(): Promise<void> {
    if (this.running || !this.queue.length) return;
    const { accountId, contentRecording } = this.queue[0];
    const members: Pending[] = [];
    let queries = new Set<string>();
    while (
      this.queue[0]?.accountId === accountId &&
      this.queue[0]?.contentRecording === contentRecording
    ) {
      const candidate = this.queue[0];
      const combined = new Set([...queries, ...candidate.queries]);
      if (combined.size > LIMITS.searches) break;
      this.queue.shift();
      queries = combined;
      members.push(candidate);
    }
    const batch: Running = { id: randomUUID(), members, controller: new AbortController() };
    this.running = batch;
    for (const member of members) {
      member.batch = batch;
      clearTimeout(member.timer);
    }
    try {
      const observations = new SearchObservations(contentRecording);
      let result: WebSearchBatchOutput | undefined;
      let failure: WebSearchError | undefined;
      let byQuery = new Map<string, WebSearchBatchItem>();
      try {
        result = await this.run(
          {
            queries: [...queries],
            maxResults: Math.max(...members.map((member) => member.maxResults)),
            signal: batch.controller.signal,
          },
          (line) => observations.observe(line)
        );
        byQuery = new Map(result.items.map((item) => [item.query, item]));
        if (
          byQuery.size !== queries.size ||
          result.items.length !== queries.size ||
          [...queries].some((query) => !byQuery.has(query))
        )
          throw new WebSearchError('invalid_output');
      } catch (error) {
        failure = staticError(error);
        // Latch stop uncertainty BEFORE audit; its failure must never erase it.
        if (failure.reason === 'stop_unconfirmed' || failure.reason === 'service_quarantined') {
          this.quarantined = true;
          for (const queued of [...this.queue])
            this.fail(queued, new CoordinatedSearchError('service_quarantined', false));
        }
      }
      try {
        // Also runs when every subscriber cancelled. Caller lifetime does not
        // erase the account-level evidence. Production supplies a required sink.
        await this.recordBatch?.({
          accountId,
          batchId: batch.id,
          contentRecording,
          searchMayHaveRun: failure?.launched ?? true,
          ...(failure && { reason: failure.reason }),
          observations: observations.snapshot(),
        });
      } catch {
        failure = new WebSearchError('audit_unavailable', failure?.launched ?? true);
      }
      if (failure) throw failure;
      if (!result) throw new WebSearchError('internal_error');
      for (const member of members) {
        const output: CoordinatedSearchOutput = {
          batchId: batch.id,
          provider: result.provider,
          model: result.model,
          items: member.queries.map((query) => {
            const item = byQuery.get(query)!;
            return item.success
              ? {
                  ...item,
                  results: item.results.slice(0, member.maxResults).map((hit) => ({ ...hit })),
                }
              : { ...item };
          }),
          batchUsage: {
            modelToolCallCount: result.modelToolCallCount,
            ...(result.nativeSearchCount !== undefined && {
              nativeSearchCount: result.nativeSearchCount,
            }),
            ...(result.usage && { usage: { ...result.usage } }),
          },
        };
        if (this.settle(member)) member.resolve(output);
      }
    } catch (error) {
      const failure = staticError(error);
      if (failure.reason === 'stop_unconfirmed' || failure.reason === 'service_quarantined') {
        this.quarantined = true;
        for (const queued of [...this.queue])
          this.fail(queued, new CoordinatedSearchError('service_quarantined', false));
      }
      for (const member of members)
        this.fail(member, new CoordinatedSearchError(failure.reason, failure.launched, batch.id));
    } finally {
      // Cancellation may resolve all callers first, but never frees the slot
      // before the owned runner confirms physical settlement or quarantine.
      this.running = undefined;
      this.schedule();
    }
  }
}
