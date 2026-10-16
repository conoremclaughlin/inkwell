export interface NotificationRetentionStore {
  /** Deletes at most 500 already-expired events. */
  purgeExpired(now: number): Promise<number>;
}

export interface NotificationRetentionReport {
  deleted: number;
  batches: number;
  /** A bound was reached: another pass may still have work. */
  backlog: boolean;
  failed: boolean;
}

/**
 * Explicitly started maintenance, not an import-time timer. Read paths must
 * still enforce expires_at, since downtime or a backlog can delay physical
 * removal. It cannot run two sweeps concurrently in this process; multiple
 * hosts may safely delete the same expired ids through the bounded store.
 * Reports carry counts only, never notification bytes or database errors.
 */
export class NotificationRetention {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<NotificationRetentionReport> | undefined;
  private started = false;
  private stopping = false;

  constructor(
    private readonly store: NotificationRetentionStore,
    private readonly report: (report: NotificationRetentionReport) => void,
    private readonly now: () => number = Date.now
  ) {}

  /** One fixed cutoff and at most 10 batches (5,000 rows) per pass. */
  sweep(): Promise<NotificationRetentionReport> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<NotificationRetentionReport> {
    const result: NotificationRetentionReport = {
      deleted: 0,
      batches: 0,
      backlog: false,
      failed: false,
    };
    try {
      const cutoff = this.now();
      while (!this.stopping && result.batches < 10) {
        const deleted = await this.store.purgeExpired(cutoff);
        if (!Number.isInteger(deleted) || deleted < 0 || deleted > 500)
          throw new Error('Invalid cleanup count');
        result.deleted += deleted;
        result.batches++;
        result.backlog = deleted === 500;
        if (!result.backlog) break;
      }
    } catch {
      result.failed = true;
    }
    return result;
  }

  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sweep().then((result) => {
        // An observability callback must not strand the cleanup loop.
        try {
          this.report(result);
        } catch {
          // The next pass still runs. No sensitive exception is logged here.
        }
        if (this.started && !this.stopping) {
          this.schedule(result.backlog && !result.failed ? 1_000 : 60_000);
        }
      });
    }, delay);
    this.timer.unref();
  }

  /** Stop scheduling and wait for an in-flight deletion, never abandon it. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
