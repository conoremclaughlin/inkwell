/**
 * Retry + circuit breaker helper for Supabase / PostgREST calls.
 *
 * Motivation: on 2026-04-19 the local Supabase Docker VM disk filled up
 * because Kong logged every 503 from PostgREST at full detail. The 503s
 * themselves were amplified by hot-path callers (inbox polling via the
 * ink CLI, `resolveUser` inside tool handlers) that retried instantly
 * without any backoff. Each failing request left an audit trail in Kong.
 *
 * This helper gives callers a tiny, zero-config wrapper that:
 *   1. Retries a handful of times on transient errors (5xx, PostgREST
 *      "cannot connect to DB" codes, fetch/network errors).
 *   2. Uses exponential backoff + jitter so concurrent callers don't
 *      synchronize and resonate.
 *   3. Short-circuits (fails fast) once a shared circuit breaker trips
 *      after a burst of failures — avoiding the stampede pattern that
 *      pushed Kong into meltdown.
 *
 * The circuit breaker is process-local (a module-level singleton) so it
 * protects a single server's shared Supabase client, which is what we
 * want: if Postgres is down for us, every concurrent request sees it
 * within milliseconds, and we want them to back off together.
 */

import { logger } from './logger';

export interface RetryOptions {
  /** Max attempts including the initial call. Default 4. */
  maxAttempts?: number;
  /** Initial backoff in ms. Default 100. Doubles each attempt, capped. */
  initialDelayMs?: number;
  /** Cap on any single backoff (before jitter). Default 2000. */
  maxDelayMs?: number;
  /** Label for logs, e.g. "resolveUser.findById". */
  label?: string;
  /**
   * Override the default "is this transient" classifier. Returns true if
   * the error should trigger a retry. Defaults to `isTransientSupabaseError`.
   */
  isTransient?: (err: unknown) => boolean;
  /**
   * Optional abort signal. If aborted, retries stop immediately and the
   * current attempt's error is rethrown.
   */
  signal?: AbortSignal;
}

export interface CircuitBreakerState {
  /** Consecutive transient failures observed globally. */
  consecutiveFailures: number;
  /** Timestamp (ms since epoch) when the breaker may be probed again. */
  openUntil: number;
}

export interface CircuitBreakerOptions {
  /** Trip after this many consecutive transient failures. Default 5. */
  failureThreshold?: number;
  /** How long to stay open before allowing a probe. Default 10s. */
  cooldownMs?: number;
}

const DEFAULT_RETRY: Required<Pick<RetryOptions, 'maxAttempts' | 'initialDelayMs' | 'maxDelayMs'>> =
  {
    maxAttempts: 4,
    initialDelayMs: 100,
    maxDelayMs: 2000,
  };

const DEFAULT_BREAKER: Required<CircuitBreakerOptions> = {
  failureThreshold: 5,
  cooldownMs: 10_000,
};

export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN';
  constructor(openForMs: number, label?: string) {
    super(
      `Supabase circuit breaker is open${label ? ` for ${label}` : ''}; retry in ${openForMs}ms`
    );
    this.name = 'CircuitOpenError';
  }
}

/**
 * Default transient-error classifier. Conservative — only retries things
 * we're confident are safe to retry (idempotent reads + upserts). Callers
 * using non-idempotent mutations should pass their own classifier.
 */
export function isTransientSupabaseError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const anyErr = err as Record<string, unknown>;

  // PostgREST error codes — see https://postgrest.org/en/stable/references/errors.html
  // PGRST002 = cannot query schema cache (DB unreachable)
  // 57P03 / 57P01 = Postgres cannot_connect_now / admin_shutdown
  const code = typeof anyErr.code === 'string' ? anyErr.code : undefined;
  if (code === 'PGRST002' || code === '57P03' || code === '57P01') return true;

  // HTTP status on Supabase-js errors (status + statusText set on PostgrestError)
  const status = typeof anyErr.status === 'number' ? anyErr.status : undefined;
  if (status !== undefined && status >= 500 && status < 600) return true;
  if (status === 429) return true; // rate-limit

  // fetch / undici network failures
  const message = typeof anyErr.message === 'string' ? anyErr.message.toLowerCase() : '';
  if (
    message.includes('fetch failed') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('etimedout') ||
    message.includes('socket hang up') ||
    message.includes('network error')
  ) {
    return true;
  }

  return false;
}

function nextDelay(attempt: number, initial: number, cap: number): number {
  const exp = initial * 2 ** attempt;
  const base = Math.min(exp, cap);
  // Full jitter: pick uniformly in [0, base]. Prevents thundering herd.
  return Math.floor(Math.random() * base);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Creates a fresh circuit-breaker + retry context. Exported for tests that
 * need isolation between cases. Production code uses `withSupabaseRetry`,
 * which uses a shared process-level breaker.
 */
export function createSupabaseRetry(breakerOpts: CircuitBreakerOptions = {}) {
  const opts = { ...DEFAULT_BREAKER, ...breakerOpts };
  const state: CircuitBreakerState = {
    consecutiveFailures: 0,
    openUntil: 0,
  };

  async function run<T>(fn: () => Promise<T>, retryOpts: RetryOptions = {}): Promise<T> {
    const {
      maxAttempts = DEFAULT_RETRY.maxAttempts,
      initialDelayMs = DEFAULT_RETRY.initialDelayMs,
      maxDelayMs = DEFAULT_RETRY.maxDelayMs,
      label,
      isTransient = isTransientSupabaseError,
      signal,
    } = retryOpts;

    const now = Date.now();
    if (state.openUntil > now) {
      throw new CircuitOpenError(state.openUntil - now, label);
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');

      try {
        const result = await fn();
        // Success — close the breaker if it was probing back.
        if (state.consecutiveFailures > 0) {
          logger.debug('Supabase circuit breaker recovered', {
            label,
            previousFailures: state.consecutiveFailures,
          });
          state.consecutiveFailures = 0;
          state.openUntil = 0;
        }
        return result;
      } catch (err) {
        lastErr = err;
        if (!isTransient(err)) {
          // Non-transient — bubble up untouched, don't pollute breaker.
          throw err;
        }

        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= opts.failureThreshold) {
          state.openUntil = Date.now() + opts.cooldownMs;
          logger.warn('Supabase circuit breaker opened', {
            label,
            failures: state.consecutiveFailures,
            cooldownMs: opts.cooldownMs,
          });
          throw err;
        }

        if (attempt === maxAttempts - 1) {
          // Out of attempts — rethrow after last failure.
          throw err;
        }

        const delay = nextDelay(attempt, initialDelayMs, maxDelayMs);
        logger.debug('Supabase call transient failure, retrying', {
          label,
          attempt: attempt + 1,
          maxAttempts,
          delayMs: delay,
        });
        await sleep(delay, signal);
      }
    }

    // Unreachable — loop either returns or throws.
    throw lastErr ?? new Error('supabase retry exhausted');
  }

  return {
    run,
    getState: () => ({ ...state }),
    reset: () => {
      state.consecutiveFailures = 0;
      state.openUntil = 0;
    },
  };
}

const sharedRetry = createSupabaseRetry();

/**
 * Wrap a Supabase call with retry + shared circuit breaker.
 *
 * Usage:
 *   const user = await withSupabaseRetry(
 *     () => usersRepo.findById(id),
 *     { label: 'users.findById' }
 *   );
 */
export function withSupabaseRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  return sharedRetry.run(fn, options);
}

/** Exposed for tests / metrics endpoints. */
export function getSharedBreakerState(): CircuitBreakerState {
  return sharedRetry.getState();
}

/** Exposed for tests — do not call in production. */
export function resetSharedBreakerForTests(): void {
  sharedRetry.reset();
}
