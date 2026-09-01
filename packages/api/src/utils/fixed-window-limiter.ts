/**
 * A bounded, in-memory fixed-window rate limiter for unauthenticated routes.
 *
 * In-memory is enough — the API is one process and this only needs to blunt
 * online guessing — but "in-memory" must not mean "unbounded": a spray of
 * distinct keys (one IP, endless emails) would otherwise grow the map without
 * limit, and a cleanup that scans it on every request makes each attempt
 * more expensive than the last. So:
 *
 *  - pruning is amortised (every `pruneEvery` hits) rather than per request;
 *  - the map is capped at `maxKeys`; past that, the oldest windows are
 *    evicted first. Those keys lose their count — a limiter that forgets a
 *    little under attack beats a process that keeps every attacker's key.
 *
 * Callers compose their own policy from `hit()`: charge a per-IP bucket AND a
 * per-(IP, account) bucket and refuse if either is over.
 */
interface Bucket {
  count: number;
  windowStartedAt: number;
}

export class FixedWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private hitsSincePrune = 0;

  constructor(
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
    private readonly pruneEvery = 256
  ) {}

  /** Record one attempt for `key`; true when the key is now over `limit` in its window. */
  hit(key: string, limit: number, now: number = Date.now()): boolean {
    this.hitsSincePrune += 1;
    if (this.hitsSincePrune >= this.pruneEvery || this.buckets.size >= this.maxKeys) {
      this.prune(now);
    }

    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStartedAt >= this.windowMs) {
      // Delete-then-set moves a refreshed key to the end of insertion order,
      // which is what makes eviction below oldest-first.
      this.buckets.delete(key);
      this.buckets.set(key, { count: 1, windowStartedAt: now });
      return 1 > limit;
    }
    bucket.count += 1;
    return bucket.count > limit;
  }

  /** Drop expired windows; if still over the cap, evict the oldest down to 90% of it. */
  prune(now: number = Date.now()): void {
    this.hitsSincePrune = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStartedAt >= this.windowMs) this.buckets.delete(key);
    }
    const target = Math.floor(this.maxKeys * 0.9);
    if (this.buckets.size > target) {
      let toDrop = this.buckets.size - target;
      for (const key of this.buckets.keys()) {
        if (toDrop <= 0) break;
        this.buckets.delete(key);
        toDrop -= 1;
      }
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
