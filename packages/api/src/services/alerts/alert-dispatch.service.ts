/**
 * Alert dispatch — record first, then fan out.
 *
 * Ordering is the whole design. The event is durably written before any
 * delivery is attempted, and every sink is isolated behind its own try/catch
 * and timeout. A broken Telegram token, a refused inbox trigger, or a dead
 * outbound webhook degrades that one sink and nothing else. The failure this
 * avoids is the one that keeps recurring in this system: a delivery path
 * throwing and taking the record of the incident down with it, so afterwards
 * there is no evidence the alarm ever fired.
 *
 * The corollary is that "alert accepted" and "human was told" are different
 * claims, and the response says which happened per sink rather than
 * collapsing them into one boolean.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DataComposer } from '../../data/composer';
import type { Database, Json } from '../../data/supabase/types';
import { logger } from '../../utils/logger';
import {
  type AlertSeverity,
  type ParsedAlert,
  type QuietHours,
  shouldNotifyUser,
  signWebhookPayload,
  sourceStaleness,
  webhookMatches,
} from './alert-policy';

/** Per-operation ceiling for a single outbound send. */
const SINK_TIMEOUT_MS = 5_000;

/**
 * Whole-sink ceiling.
 *
 * SINK_TIMEOUT_MS bounds the individual sends, but a sink is more than its
 * sends: quiet-hours lookup, webhook-registry load, per-delivery bookkeeping.
 * Those sit outside the per-send race, so one hung DB call could keep
 * Promise.allSettled open indefinitely and the checker's request with it —
 * the alerting path hanging on the infrastructure it is trying to report on
 * (PR #539, Lumen).
 *
 * The number is bounded from ABOVE by the client, not chosen for comfort.
 * ink-disk-monitor.sh gives the ingest POST `--max-time 20`, so a 45s
 * server-side budget meant the checker could give up, declare the pipeline
 * blind and fire a direct Telegram while this process was still delivering
 * the same alert through the normal path — one incident, two messages, and a
 * fallback that had not actually fallen back (PR #539 r2, Lumen). 12s leaves
 * room for the ingest RPC and the response inside the client's 20s.
 */
export const SINK_TOTAL_TIMEOUT_MS = 12_000;

/**
 * Budget for the liveness *recovery* notice, which is not the request's main
 * work.
 *
 * A monitor coming back from the dead posts its alert through the same request
 * that closes its liveness incident, so two fan-outs can run in one call:
 * "disk-monitor is alive again" and then the disk alert itself. At the full
 * budget each, those sum to 24s and blow past the checker's 20s — re-creating,
 * out of the fix, precisely the timeout-then-double-notify this round set out
 * to remove. Bounded so the worst case (5 + 12) still lands inside it.
 */
export const RECOVERY_FANOUT_TIMEOUT_MS = 5_000;

/**
 * Budget for the diagnostic delivery write. Small on purpose: it sits between
 * the fan-out and settleClaim, and the poster's own deadline is 20s. Fan-out
 * can take SINK_TOTAL_TIMEOUT_MS, so this has to leave settleClaim room inside
 * that budget rather than consume what is left of it.
 */
const DELIVERY_RECORD_TIMEOUT_MS = 3_000;

/** Per-operation ceiling for a single database call (RPC or PostgREST). */
const DB_CALL_TIMEOUT_MS = 5_000;

/**
 * The sink result for a send that was abandoned at the door.
 *
 * The distinction this preserves is the one the whole claim machinery rests
 * on: nothing was attempted, so the claim must ride to TTL rather than be
 * released to a second dispatcher. Same rule as a timed-out send, different
 * reason.
 */
function abandonedAtDeadline(sink: 'user' | 'agents', target: string): SinkResult {
  return {
    sink,
    target,
    ok: false,
    detail: 'request budget expired before send',
    timedOut: true,
  };
}

/**
 * The whole request's budget, shared by every stage.
 *
 * The per-sink and per-write ceilings above bound individual operations, and
 * that was never the same thing as bounding the request. Round three named the
 * gap as the database awaits generally — source touch, liveness resolution,
 * the ingest RPC, persistence and settlement — and round four showed that
 * bounding persistence alone left the other four able to hang the response
 * past the poster's deadline on their own. Stage ceilings cannot add up to a
 * guarantee: five 3s ceilings are still 15s, and a sum is not a deadline.
 *
 * ink-disk-monitor.sh gives the POST `--max-time 20`, so the server must be
 * finished before that or the checker gives up, declares the pipeline blind
 * and fires a direct Telegram for an alert this process is still delivering.
 * 18s leaves margin for the HTTP round trip inside the client's 20.
 */
export const REQUEST_TOTAL_TIMEOUT_MS = 18_000;

/**
 * What is left of the request's budget.
 *
 * Every stage takes min(its own ceiling, what remains) rather than its ceiling
 * outright, so a slow-but-not-hung earlier stage shortens the later ones
 * instead of pushing them past the end. Work is not STARTED once the budget is
 * gone — particularly a fan-out, which would otherwise send an alert after the
 * checker has already given up and sent its own.
 */
export class RequestBudget {
  private readonly expiresAt: number;

  constructor(budgetMs: number = REQUEST_TOTAL_TIMEOUT_MS, now: number = Date.now()) {
    this.expiresAt = now + budgetMs;
  }

  remaining(now: number = Date.now()): number {
    return Math.max(0, this.expiresAt - now);
  }

  expired(now: number = Date.now()): boolean {
    return this.remaining(now) <= 0;
  }

  /** A stage ceiling, clamped to what the request has left. */
  cap(stageMs: number, now: number = Date.now()): number {
    return Math.min(stageMs, this.remaining(now));
  }
}

/**
 * A sink that ran out of time, as distinct from one that failed.
 *
 * The difference matters exactly once, at settle time: a failed fan-out
 * released its claim so the next occurrence could retry immediately, but a
 * timed-out one may still be in flight and may still deliver. Releasing that
 * claim invites a second dispatcher to run alongside the first. Timeout is
 * therefore *uncertain* rather than failed, and an uncertain claim is left for
 * the TTL to reap.
 */
class SinkTimeoutError extends Error {}

export interface SinkResult {
  sink: 'user' | 'agents' | 'webhook';
  target: string;
  ok: boolean;
  detail?: string;
  /** Ran out of time; may or may not have delivered. See SinkTimeoutError. */
  timedOut?: boolean;
}

export interface AlertDispatchResult {
  accepted: true;
  eventId: string | null;
  status: 'raised' | 'deduped' | 'resolved' | 'already-resolved';
  isNew: boolean;
  notified: boolean;
  occurrenceCount: number;
  deliveries: SinkResult[];
}

async function withTimeout<T>(
  label: string,
  work: Promise<T>,
  budgetMs: number = SINK_TIMEOUT_MS
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SinkTimeoutError(`${label} timed out after ${budgetMs}ms`)),
          budgetMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * An abort signal that fires on whichever comes first: this operation's own
 * budget, or the whole fan-out's deadline.
 *
 * Promise.race only stops *waiting* — it does not stop the work. A timed-out
 * webhook POST would carry on and could still deliver after the service had
 * already written off the attempt. Passing a real signal to fetch() means the
 * request is actually cancelled.
 *
 * AbortSignal.any() would say this in one line but landed in Node 20, and the
 * package still declares 18.
 */
function deadlineSignal(parent: AbortSignal, budgetMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new SinkTimeoutError('send timed out')),
    budgetMs
  );
  const onParentAbort = () => {
    clearTimeout(timer);
    controller.abort(parent.reason);
  };

  if (parent.aborted) onParentAbort();
  else parent.addEventListener('abort', onParentAbort, { once: true });

  // Node keeps a pending timer alive on its own; clearing it once the signal
  // is settled keeps a finished dispatch from holding the event loop open.
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}

export class AlertDispatchService {
  private readonly supabase: SupabaseClient<Database>;

  constructor(
    private readonly dataComposer: DataComposer,
    supabase?: SupabaseClient<Database>
  ) {
    this.supabase = supabase ?? dataComposer.getClient();
  }

  /**
   * Ingest one alert post. `status: 'ok'` resolves an open incident; anything
   * else raises or re-raises it.
   */
  async ingest(
    userId: string,
    alert: ParsedAlert,
    budget: RequestBudget = new RequestBudget()
  ): Promise<AlertDispatchResult> {
    await this.touchSource(userId, alert, budget);

    if (alert.status === 'ok') {
      return this.resolve(userId, alert, budget);
    }

    const { data, error } = await withTimeout(
      'ingest rpc',
      // Promise.resolve because a PostgREST builder is a thenable, not a
      // Promise, and Promise.race needs something it can actually race.
      Promise.resolve(
        this.supabase.rpc('ingest_alert_event', {
          p_user_id: userId,
          p_source: alert.source,
          p_severity: alert.severity,
          p_title: alert.title,
          p_dedupe_key: alert.dedupeKey,
          p_cooldown_seconds: alert.cooldownSeconds,
          // Omitted when absent so the SQL default applies, rather than passing an
          // explicit null the generated arg types (correctly) refuse.
          ...(alert.detail === undefined ? {} : { p_detail: alert.detail }),
          ...(alert.metrics === undefined ? {} : { p_metrics: alert.metrics as Json }),
        })
      ),
      budget.cap(DB_CALL_TIMEOUT_MS)
    );

    if (error) throw new Error(`Failed to record alert: ${error.message}`);

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('Failed to record alert: ingest returned no row');

    const eventId: string = row.event_id;
    const isNew: boolean = row.is_new;
    const shouldNotify: boolean = row.should_notify;
    const claimToken: string | null = row.claim_token ?? null;
    const occurrenceCount: number = row.occurrence_count ?? 1;

    if (!shouldNotify) {
      return {
        accepted: true,
        eventId,
        status: 'deduped',
        isNew,
        notified: false,
        occurrenceCount,
        deliveries: [],
      };
    }

    // Not merely bounded — not STARTED once the budget is gone. A fan-out
    // begun after the checker has given up delivers an alert it already sent
    // itself, which is the double-notify this round exists to remove.
    const deliveries = budget.expired()
      ? [
          {
            sink: 'user' as const,
            target: 'none',
            ok: false,
            detail: 'request budget exhausted before fan-out',
            // Uncertain, not failed: nothing was attempted, so the claim must
            // ride to TTL rather than be released to a second dispatcher.
            timedOut: true,
          },
        ]
      : await this.fanOut(
          userId,
          {
            severity: alert.severity,
            source: alert.source,
            title: alert.title,
            detail: alert.detail,
            dedupeKey: alert.dedupeKey,
            metrics: alert.metrics,
            occurrenceCount,
            notifyAgents: alert.notifyAgents,
            notifyUser: alert.notifyUser,
            kind: 'raised',
          },
          budget.cap(SINK_TOTAL_TIMEOUT_MS),
          budget
        );

    await this.recordDelivery(eventId, deliveries, budget);
    const notified = await this.settleClaim(
      eventId,
      claimToken,
      alert.severity,
      deliveries,
      budget
    );

    return {
      accepted: true,
      eventId,
      status: 'raised',
      isNew,
      notified,
      occurrenceCount,
      deliveries,
    };
  }

  /**
   * Close out the notification claim taken by ingest_alert_event.
   *
   * The claim is the right to attempt; this records what actually happened.
   * Three outcomes, not two:
   *
   *   delivered  — stamp last_notified_at and drop the claim. The cooldown now
   *                runs from a real delivery.
   *   failed     — release the claim so the next occurrence retries at once.
   *                The alternative is an hour of silence bought by a
   *                notification nobody received.
   *   uncertain  — a sink ran out of time and may still be in flight. Releasing
   *                here would let the next occurrence dispatch alongside it, so
   *                the claim is left for the TTL to reap instead.
   *
   * Settlement is fenced on the claim token: an escalation may have superseded
   * this dispatcher mid-fan-out, and a superseded dispatcher must record its
   * own delivery without disturbing the claim now in force.
   *
   * Returns whether anything was delivered.
   */
  private async settleClaim(
    eventId: string,
    claimToken: string | null,
    severity: AlertSeverity,
    deliveries: SinkResult[],
    budget: RequestBudget = new RequestBudget()
  ): Promise<boolean> {
    const delivered = deliveries.some((d) => d.ok);
    const uncertain = !delivered && deliveries.some((d) => d.timedOut);

    if (uncertain) {
      logger.warn('[Alerts] Fan-out timed out; leaving claim for TTL rather than releasing', {
        eventId,
        severity,
      });
      return false;
    }

    // A settle that cannot finish inside the budget is reported, not waited
    // on. The claim then expires by TTL, which is the same outcome as the
    // uncertain branch above and strictly better than holding the response.
    let error: { message: string } | null = null;
    try {
      ({ error } = await withTimeout(
        'settle claim',
        Promise.resolve(
          this.supabase.rpc(
            delivered ? 'mark_alert_notified' : 'release_alert_claim',
            delivered
              ? { p_event_id: eventId, p_claim_token: claimToken, p_severity: severity }
              : { p_event_id: eventId, p_claim_token: claimToken }
          )
        ),
        budget.cap(DB_CALL_TIMEOUT_MS)
      ));
    } catch (timeoutError) {
      logger.error('[Alerts] Claim settlement did not finish inside the request budget', {
        eventId,
        delivered,
        error: timeoutError instanceof Error ? timeoutError.message : String(timeoutError),
      });
      return delivered;
    }

    if (error) {
      // Never throw: the alert itself is recorded and the fan-out already
      // happened. But this must not pass silently either — a stuck claim
      // suppresses this condition until the TTL expires.
      logger.error('[Alerts] Failed to settle notification claim', {
        eventId,
        delivered,
        error: error.message,
      });
    }

    return delivered;
  }

  private async resolve(
    userId: string,
    alert: ParsedAlert,
    budget: RequestBudget = new RequestBudget()
  ): Promise<AlertDispatchResult> {
    const { data, error } = await withTimeout(
      'resolve rpc',
      Promise.resolve(
        this.supabase.rpc('resolve_alert_event', {
          p_user_id: userId,
          p_dedupe_key: alert.dedupeKey,
        })
      ),
      budget.cap(DB_CALL_TIMEOUT_MS)
    );

    if (error) throw new Error(`Failed to resolve alert: ${error.message}`);

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      // Nothing was open. The common case is a healthy checker posting 'ok'
      // on every run; that must stay silent, not announce a recovery from a
      // problem nobody had.
      return {
        accepted: true,
        eventId: null,
        status: 'already-resolved',
        isNew: false,
        notified: false,
        occurrenceCount: 0,
        deliveries: [],
      };
    }

    // Only announce recovery if the incident itself was ever announced.
    // Recovering from an alarm nobody heard is not news.
    if (!row.was_notified) {
      return {
        accepted: true,
        eventId: row.event_id,
        status: 'resolved',
        isNew: false,
        notified: false,
        occurrenceCount: row.occurrence_count ?? 0,
        deliveries: [],
      };
    }

    const minutes = Math.max(
      1,
      Math.round((Date.now() - new Date(row.first_seen_at).getTime()) / 60000)
    );

    const deliveries = await this.fanOut(
      userId,
      {
        severity: 'info',
        source: alert.source,
        title: `Recovered: ${row.title}`,
        detail: `Cleared after ${minutes} min and ${row.occurrence_count} check(s).`,
        dedupeKey: alert.dedupeKey,
        metrics: alert.metrics,
        occurrenceCount: row.occurrence_count ?? 0,
        notifyAgents: alert.notifyAgents,
        notifyUser: alert.notifyUser,
        kind: 'resolved',
      },
      budget.cap(SINK_TOTAL_TIMEOUT_MS),
      budget
    );

    await this.recordDelivery(row.event_id, deliveries, budget);

    return {
      accepted: true,
      eventId: row.event_id,
      status: 'resolved',
      isNew: false,
      notified: deliveries.some((d) => d.ok),
      occurrenceCount: row.occurrence_count ?? 0,
      deliveries,
    };
  }

  // ── Sinks ───────────────────────────────────────────────────────────────

  private async fanOut(
    userId: string,
    event: {
      severity: AlertSeverity;
      source: string;
      title: string;
      detail?: string;
      dedupeKey: string;
      metrics?: Record<string, unknown>;
      occurrenceCount: number;
      notifyAgents?: string[];
      notifyUser?: boolean;
      kind: 'raised' | 'resolved';
    },
    budgetMs: number = SINK_TOTAL_TIMEOUT_MS,
    budget: RequestBudget = new RequestBudget()
  ): Promise<SinkResult[]> {
    // Sinks run concurrently and are settled independently — one sink's
    // failure must never cancel another's delivery. Each is bounded as a
    // WHOLE, not just at its outbound sends: a sink's DB lookups and
    // bookkeeping are part of what can hang, and an unbounded one holds the
    // checker's request open for as long as it likes.
    //
    // Refused BEFORE any sink is invoked. withTimeout races a timer against
    // work that has already started, and a zero-length timer cannot win that
    // race: the sinks run to their first await regardless, which for the user
    // and agents sinks is far enough to send. A budget of zero has to mean
    // "do not begin", not "begin and lose a race" (PR #539 r5, Lumen).
    if (budgetMs <= 0 || budget.expired()) {
      logger.warn('[Alerts] Fan-out refused: request budget exhausted before any sink started', {
        source: event.source,
      });
      return [
        {
          sink: 'user',
          target: 'none',
          ok: false,
          detail: 'request budget exhausted before fan-out',
          // Nothing was attempted, so the claim rides to TTL rather than
          // being released to a second dispatcher.
          timedOut: true,
        },
      ];
    }

    // The deadline is also an abort signal, not just a race. Cancellable work
    // (the webhook POSTs) is actually cancelled when it fires, so a written-off
    // send cannot quietly deliver afterwards.
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(
      () => deadline.abort(new SinkTimeoutError('fan-out deadline reached')),
      budgetMs
    );

    let results: PromiseSettledResult<SinkResult[]>[];
    try {
      results = await Promise.allSettled([
        withTimeout('user sink', this.notifyUserChannel(userId, event, budget), budgetMs),
        withTimeout('agents sink', this.notifyAgents(userId, event, budget), budgetMs),
        withTimeout('webhook sink', this.notifyWebhooks(userId, event, deadline.signal), budgetMs),
      ]);
    } finally {
      clearTimeout(deadlineTimer);
    }

    return results.flatMap((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const sink = (['user', 'agents', 'webhook'] as const)[i];
      const timedOut = r.reason instanceof SinkTimeoutError;
      logger.error('Alert sink failed', { sink, timedOut, error: r.reason });
      return [{ sink, target: sink, ok: false, detail: String(r.reason), timedOut }];
    });
  }

  private async notifyUserChannel(
    userId: string,
    event: {
      severity: AlertSeverity;
      source: string;
      title: string;
      detail?: string;
      occurrenceCount: number;
      notifyUser?: boolean;
      kind: 'raised' | 'resolved';
    },
    budget: RequestBudget = new RequestBudget()
  ): Promise<SinkResult[]> {
    const quietHours = await this.getQuietHours(userId);
    const decision = shouldNotifyUser({
      severity: event.severity,
      at: new Date(),
      quietHours,
      notifyUser: event.notifyUser,
    });

    if (!decision.notify) {
      return [{ sink: 'user', target: 'suppressed', ok: false, detail: decision.reason }];
    }

    const { data: user } = await this.supabase
      .from('users')
      .select('telegram_id, whatsapp_id')
      .eq('id', userId)
      .single();

    let channel: 'telegram' | 'whatsapp' | null = null;
    let conversationId: string | null = null;
    if (user?.telegram_id) {
      channel = 'telegram';
      conversationId = String(user.telegram_id);
    } else if (user?.whatsapp_id) {
      channel = 'whatsapp';
      conversationId = String(user.whatsapp_id);
    }

    if (!channel || !conversationId) {
      return [{ sink: 'user', target: 'none', ok: false, detail: 'no delivery channel on user' }];
    }

    try {
      const { getChannelGateway } = await import('../../channels/gateway.js');

      // Checked HERE, after the user lookup and the dynamic import, rather
      // than only at the top. Those are awaits: the outer race can time out
      // and ingest can return while this continuation is still suspended, and
      // when the lookup finally resolves the send would go out against a
      // request that ended long ago — arriving next to the fallback the
      // checker already sent because it gave up (PR #539 r5, Lumen).
      if (budget.expired()) {
        logger.warn('[Alerts] Abandoning user send: request budget expired during lookup', {
          source: event.source,
        });
        return [abandonedAtDeadline('user', channel)];
      }

      await withTimeout(
        'user channel',
        Promise.resolve(
          getChannelGateway().sendResponse({
            channel,
            conversationId,
            content: formatAlertText(event),
          })
        )
      );
      return [{ sink: 'user', target: channel, ok: true, detail: decision.reason }];
    } catch (error) {
      return [
        {
          sink: 'user',
          target: channel,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          // A timeout here is NOT a failure, and flattening it into one is how
          // the uncertainty gets lost. settleClaim reads `timedOut` to decide
          // between releasing the claim and letting it ride to TTL; without
          // this flag the inner 5s budget reports a send that is still in
          // flight as definitely-not-delivered, the claim is released, and the
          // message can arrive after something else has already been told the
          // delivery failed.
          timedOut: error instanceof SinkTimeoutError,
        },
      ];
    }
  }

  private async notifyAgents(
    userId: string,
    event: {
      severity: AlertSeverity;
      source: string;
      title: string;
      detail?: string;
      metrics?: Record<string, unknown>;
      occurrenceCount: number;
      notifyAgents?: string[];
      kind: 'raised' | 'resolved';
    },
    budget: RequestBudget = new RequestBudget()
  ): Promise<SinkResult[]> {
    const recipients = event.notifyAgents ?? [];
    if (recipients.length === 0) return [];

    // Grouped per source so an SB reading the thread sees this condition's
    // history rather than a pile of disconnected one-off messages.
    const threadKey = `ops:alert:${event.source}`;

    try {
      const { handleSendToInbox } = await import('../../mcp/tools/inbox-handlers.js');

      // Same reasoning as the user sink: the import is an await, so this can
      // resume after the request it belongs to has already returned.
      if (budget.expired()) {
        logger.warn('[Alerts] Abandoning agent sends: request budget expired during import', {
          source: event.source,
        });
        return recipients.map((slug) => abandonedAtDeadline('agents', slug));
      }

      await withTimeout(
        'agent inbox',
        handleSendToInbox(
          {
            userId,
            senderSlug: 'system',
            recipients,
            threadKey,
            messageType: event.severity === 'critical' ? 'task_request' : 'notification',
            priority: event.severity === 'critical' ? 'urgent' : 'high',
            subject: `[${event.severity}] ${event.title}`,
            content: formatAlertText(event),
            // Info is recorded quietly; anything louder wakes them. A trigger
            // refusal still leaves the message stored, which is why inbox
            // delivery is worth attempting even when routing is unhealthy.
            trigger: event.severity !== 'info',
            triggerAll: event.severity === 'critical',
            triggerType: 'error',
            triggerSummary: event.title,
            metadata: {
              alert: {
                source: event.source,
                severity: event.severity,
                occurrenceCount: event.occurrenceCount,
                metrics: event.metrics ?? {},
              },
            },
          },
          this.dataComposer
        )
      );
      return recipients.map((slug) => ({ sink: 'agents' as const, target: slug, ok: true }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Same as the user sink: a timeout is uncertain, not failed. See the
      // note there for what releasing the claim on an in-flight send costs.
      const timedOut = error instanceof SinkTimeoutError;
      return recipients.map((slug) => ({
        sink: 'agents' as const,
        target: slug,
        ok: false,
        detail,
        timedOut,
      }));
    }
  }

  private async notifyWebhooks(
    userId: string,
    event: {
      severity: AlertSeverity;
      source: string;
      title: string;
      detail?: string;
      dedupeKey: string;
      metrics?: Record<string, unknown>;
      occurrenceCount: number;
      kind: 'raised' | 'resolved';
    },
    deadline: AbortSignal
  ): Promise<SinkResult[]> {
    const { data, error } = await this.supabase
      .from('alert_webhooks')
      .select('id, name, url, secret, severities, sources, enabled')
      .eq('user_id', userId)
      .eq('enabled', true);

    if (error) {
      logger.error('Failed to load alert webhooks', { error: error.message });
      return [{ sink: 'webhook', target: 'registry', ok: false, detail: error.message }];
    }

    const webhooks = (data ?? []).filter(
      (w: { enabled: boolean; severities: string[]; sources: string[] }) =>
        webhookMatches(
          {
            enabled: w.enabled,
            severities: w.severities ?? [],
            sources: w.sources ?? [],
          },
          { severity: event.severity, source: event.source }
        )
    );

    if (webhooks.length === 0) return [];

    return Promise.all(
      webhooks.map(
        (w: { id: string; name: string; url: string; secret: string }) =>
          this.deliverWebhook(w, event, deadline) as Promise<SinkResult>
      )
    );
  }

  private async deliverWebhook(
    webhook: { id: string; name: string; url: string; secret: string },
    event: {
      severity: AlertSeverity;
      source: string;
      title: string;
      detail?: string;
      dedupeKey: string;
      metrics?: Record<string, unknown>;
      occurrenceCount: number;
      kind: 'raised' | 'resolved';
    },
    deadline: AbortSignal
  ): Promise<SinkResult> {
    const timestamp = Date.now();
    const body = JSON.stringify({
      event: event.kind === 'resolved' ? 'alert.resolved' : 'alert.raised',
      source: event.source,
      severity: event.severity,
      title: event.title,
      detail: event.detail ?? null,
      dedupeKey: event.dedupeKey,
      metrics: event.metrics ?? {},
      occurrenceCount: event.occurrenceCount,
      timestamp: new Date(timestamp).toISOString(),
    });

    try {
      // The signal is what actually stops the request; withTimeout only stops
      // this function waiting for it.
      const response = await withTimeout(
        `webhook ${webhook.name}`,
        fetch(webhook.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-ink-timestamp': String(timestamp),
            'x-ink-signature': signWebhookPayload(webhook.secret, body, timestamp),
          },
          body,
          signal: deadlineSignal(deadline, SINK_TIMEOUT_MS),
        })
      );

      const ok = response.ok;
      if (ok) {
        const { error: bookkeepingError } = await this.supabase
          .from('alert_webhooks')
          .update({
            last_delivery_at: new Date().toISOString(),
            last_delivery_status: response.status,
            last_delivery_error: null,
            consecutive_failures: 0,
          })
          .eq('id', webhook.id);
        if (bookkeepingError) {
          // The delivery itself succeeded, so this does not change the result
          // — but a failure counter that cannot be reset will eventually
          // disable a healthy webhook.
          logger.warn('Failed to record webhook delivery success', {
            webhook: webhook.name,
            error: bookkeepingError.message,
          });
        }
      } else {
        await this.bumpWebhookFailure(webhook.id, `HTTP ${response.status}`, response.status);
      }

      return {
        sink: 'webhook',
        target: webhook.name,
        ok,
        detail: ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.bumpWebhookFailure(webhook.id, detail);
      // An aborted POST is cancelled, so unlike a whole-sink timeout it cannot
      // still be in flight — but the receiver may already have acted on it, so
      // it stays uncertain rather than counting as a clean failure.
      const timedOut =
        error instanceof SinkTimeoutError ||
        (error instanceof Error && error.name === 'AbortError');
      return { sink: 'webhook', target: webhook.name, ok: false, detail, timedOut };
    }
  }

  private async bumpWebhookFailure(
    webhookId: string,
    detail?: string,
    status?: number
  ): Promise<void> {
    try {
      const { error } = await this.supabase.rpc('record_alert_webhook_failure', {
        p_webhook_id: webhookId,
        ...(detail === undefined ? {} : { p_error: detail }),
        ...(status === undefined ? {} : { p_status: status }),
      });
      if (error) {
        // Still never rethrown — this must not mask the delivery outcome we
        // are in the middle of reporting. But it does need to be visible: the
        // counter this increments is what eventually disables a dead webhook,
        // so losing increments silently means a broken endpoint is retried
        // forever with nothing to show for it.
        logger.warn('Failed to record webhook delivery failure', {
          webhookId,
          error: error.message,
        });
      }
    } catch {
      // Failure bookkeeping is diagnostic; never let it mask the delivery
      // outcome we are in the middle of reporting.
    }
  }

  // ── Liveness ────────────────────────────────────────────────────────────

  /** Record that this source is alive, whatever it is reporting. */
  private async touchSource(
    userId: string,
    alert: ParsedAlert,
    budget: RequestBudget = new RequestBudget()
  ): Promise<void> {
    try {
      // PostgREST reports failures in the returned { error }, not by throwing.
      // The try/catch alone therefore caught nothing, and a failed liveness
      // stamp passed as success — on the one table whose whole purpose is
      // noticing that something stopped reporting.
      const { error } = await withTimeout(
        'source touch',
        Promise.resolve(
          this.supabase.from('alert_sources').upsert(
            {
              user_id: userId,
              source: alert.source,
              last_seen_at: new Date().toISOString(),
              last_status: alert.status === 'ok' ? 'ok' : 'alerting',
              last_detail: alert.detail ?? alert.title,
              // Seeing the source again ends the current silence, so the next
              // disappearance is allowed to alarm afresh.
              stale_alerted_at: null,
            },
            { onConflict: 'user_id,source' }
          )
        ),
        budget.cap(DB_CALL_TIMEOUT_MS)
      );
      if (error) {
        logger.error('Failed to touch alert source', {
          source: alert.source,
          error: error.message,
        });
      }
    } catch (error) {
      logger.error('Failed to touch alert source', { source: alert.source, error });
    }

    await this.resolveLiveness(userId, alert.source, budget);
  }

  /**
   * A source that just reported is alive, so close any open "gone silent"
   * incident against it.
   *
   * Clearing stale_alerted_at (which touchSource and checkIn already did) only
   * re-arms the *sweep*; it leaves the liveness event itself open. A monitor
   * that died, recovered, and died again within the hour then deduped onto
   * that still-open incident and was suppressed by a cooldown earned by the
   * first outage — the second death went unreported (PR #539 r2, Lumen).
   * Resolving closes the row, so a recurrence opens a fresh incident with its
   * own cooldown.
   *
   * Never throws: liveness bookkeeping must not fail the alert or check-in
   * that triggered it.
   */
  private async resolveLiveness(
    userId: string,
    source: string,
    budget: RequestBudget = new RequestBudget()
  ): Promise<void> {
    // The liveness sweep posts under its own source name; it cannot be its own
    // aliveness evidence, and letting it resolve `alert-liveness:alert-liveness`
    // would be meaningless besides.
    if (source === 'alert-liveness') return;

    try {
      const { data, error } = await withTimeout(
        'liveness resolve rpc',
        Promise.resolve(
          this.supabase.rpc('resolve_alert_event', {
            p_user_id: userId,
            p_dedupe_key: `alert-liveness:${source}`,
          })
        ),
        budget.cap(DB_CALL_TIMEOUT_MS)
      );
      if (error) {
        logger.error('Failed to resolve liveness incident', { source, error: error.message });
        return;
      }

      const row = Array.isArray(data) ? data[0] : data;
      // Nothing open is the overwhelmingly common case — a healthy monitor
      // checking in on schedule. It must stay silent.
      if (!row) return;

      // Recovering from an alarm nobody heard is not news.
      if (!row.was_notified) return;

      // Nor is a recovery notice worth starting once the request is out of
      // time. This is the pre-send continuation that must not spawn a fan-out
      // after expiry: the checker has already given up by then, and the notice
      // would arrive alongside the fallback it triggered.
      if (budget.expired()) {
        logger.warn('Skipping liveness recovery notice: request budget exhausted', { source });
        return;
      }

      const minutes = Math.max(
        1,
        Math.round((Date.now() - new Date(row.first_seen_at).getTime()) / 60000)
      );

      const deliveries = await this.fanOut(
        userId,
        {
          severity: 'info',
          source: 'alert-liveness',
          title: `Recovered: ${row.title}`,
          detail: `Monitor "${source}" checked in again after ${minutes} min of silence.`,
          dedupeKey: `alert-liveness:${source}`,
          occurrenceCount: row.occurrence_count ?? 0,
          notifyAgents: ['myra'],
          kind: 'resolved',
        },
        budget.cap(RECOVERY_FANOUT_TIMEOUT_MS),
        budget
      );
      await this.recordDelivery(row.event_id, deliveries, budget);
    } catch (error) {
      logger.error('Failed to resolve liveness incident', { source, error });
    }
  }

  /** Explicit heartbeat with no alert attached — the check-in half. */
  async checkIn(
    userId: string,
    params: { source: string; expectedIntervalSeconds?: number; detail?: string }
  ): Promise<void> {
    const row: Database['public']['Tables']['alert_sources']['Insert'] = {
      user_id: userId,
      source: params.source,
      last_seen_at: new Date().toISOString(),
      last_status: 'ok',
      // These two are "latest run" fields rather than durable attributes, so
      // clearing them on a detail-less check-in is correct: stale_alerted_at
      // in particular must reset, or the source could never alarm twice.
      last_detail: params.detail ?? null,
      stale_alerted_at: null,
      // Omitted rather than nulled when absent — a check-in that forgets to
      // restate the cadence must not erase the promise the source already made.
      ...(params.expectedIntervalSeconds
        ? { expected_interval_seconds: params.expectedIntervalSeconds }
        : {}),
    };
    const { error } = await this.supabase
      .from('alert_sources')
      .upsert(row, { onConflict: 'user_id,source' });
    if (error) throw new Error(`Failed to record check-in: ${error.message}`);

    // A check-in is the source proving it is alive, so it closes any open
    // "gone silent" incident — including announcing the recovery if the
    // silence was ever announced.
    await this.resolveLiveness(userId, params.source);
  }

  /**
   * Raise an alert for every source that has gone quiet past its promised
   * cadence.
   *
   * Honest limitation: this sweep runs inside the API server, so it detects a
   * dead *checker* but not a dead *box*. If the host is what died, nothing
   * here is left to notice. That case needs an observer outside our
   * infrastructure — the healthchecks.io / Dead Man's Snitch shape, where an
   * external service alarms on a missing check-in. This covers the process
   * crash; it does not pretend to cover the outage that motivated it.
   */
  async sweepStaleSources(userId?: string): Promise<{ checked: number; raised: number }> {
    let query = this.supabase
      .from('alert_sources')
      .select(
        'id, user_id, source, last_seen_at, expected_interval_seconds, staleness_grace_factor, stale_alerted_at'
      )
      .not('expected_interval_seconds', 'is', null);
    if (userId) query = query.eq('user_id', userId);

    const { data, error } = await query;
    if (error) throw new Error(`Failed to sweep alert sources: ${error.message}`);

    const now = new Date();
    let raised = 0;

    for (const row of data ?? []) {
      const verdict = sourceStaleness(
        {
          source: row.source,
          lastSeenAt: row.last_seen_at,
          expectedIntervalSeconds: row.expected_interval_seconds,
          stalenessGraceFactor: Number(row.staleness_grace_factor ?? 2),
          staleAlertedAt: row.stale_alerted_at,
        },
        now
      );
      if (!verdict.stale || verdict.alreadyAlerted) continue;

      const minutes = Math.round(verdict.silentForSeconds / 60);
      try {
        const result = await this.ingest(row.user_id, {
          source: 'alert-liveness',
          severity: 'critical',
          title: `Monitor "${row.source}" has gone silent`,
          detail:
            `No check-in for ${minutes} min (promised every ` +
            `${Math.round((row.expected_interval_seconds ?? 0) / 60)} min). ` +
            `The monitor itself may be dead — its silence is not evidence of health.`,
          dedupeKey: `alert-liveness:${row.source}`,
          status: 'alerting',
          cooldownSeconds: 3600,
          notifyAgents: ['myra'],
        });

        // Only mark the silence as handled if it genuinely was.
        //
        // `raised` was previously stamped for any fulfilled ingest, but ingest
        // returns { status: 'raised', notified: false } when every sink failed
        // and released its claim. Stamping there made the source
        // alreadyAlerted, so the next sweep skipped it and the retry the claim
        // release exists to enable never happened — the original "state says
        // something happened when it did not" defect, surviving in the
        // liveness path (PR #539 r2, Lumen).
        //
        // 'deduped' does NOT count as handled on its own. It means
        // should_notify came back false, and that has two causes with opposite
        // consequences: a cooldown earned by a delivery that really happened
        // (handled), or another dispatcher holding an unexpired claim which has
        // not delivered anything yet (emphatically not handled). alert_should_claim
        // ANDs the claim gate and the cooldown gate, and ingest returns one
        // boolean for both, so the status alone cannot tell them apart.
        //
        // Stamping the second case is the r2 defect wearing a different hat:
        // the source becomes alreadyAlerted, every later sweep skips it, and if
        // the in-flight dispatcher then fails and releases its claim, the retry
        // that release exists to enable never comes. Any sweep interval shorter
        // than the claim TTL reaches this routinely rather than rarely.
        //
        // last_notified_at is the fact instead of the inference: the schema
        // sets it only after at least one sink actually delivered.
        let handled = result.notified;
        if (!handled && result.status === 'deduped') {
          // eventId is nullable on the result type. A deduped raise without one
          // is a delivery state we cannot look up, which is the uncertain case
          // below rather than a delivered one.
          if (!result.eventId) {
            logger.warn('Deduped staleness alert carried no event id; leaving source unstamped', {
              source: row.source,
            });
            continue;
          }

          const { data: existing, error: existingError } = await this.supabase
            .from('alert_events')
            .select('last_notified_at')
            .eq('id', result.eventId)
            .maybeSingle();

          if (existingError) {
            // An unknown delivery state must not read as delivered. Leaving the
            // source unstamped costs a duplicate alert on the next sweep;
            // stamping it costs the alert entirely.
            logger.warn('Could not confirm prior delivery for a deduped staleness alert', {
              source: row.source,
              error: existingError.message,
            });
            continue;
          }

          handled = Boolean(
            (existing as { last_notified_at?: string | null } | null)?.last_notified_at
          );
          if (!handled) {
            logger.warn(
              'Staleness alert deduped onto an incident nobody has been told about yet; leaving source unstamped for retry',
              { source: row.source, eventId: result.eventId }
            );
            continue;
          }
        }

        if (!handled) {
          logger.warn('Staleness alert reached no sink; leaving source unstamped for retry', {
            source: row.source,
            status: result.status,
          });
          continue;
        }

        const { error: stampError } = await this.supabase
          .from('alert_sources')
          .update({ stale_alerted_at: now.toISOString() })
          .eq('id', row.id);
        if (stampError) {
          // PostgREST reports failures in { error } rather than throwing, so
          // an unchecked update read as success and the next sweep would raise
          // the same silence again.
          logger.error('Failed to stamp staleness alert', {
            source: row.source,
            error: stampError.message,
          });
          continue;
        }
        raised++;
      } catch (error) {
        logger.error('Failed to raise staleness alert', { source: row.source, error });
      }
    }

    return { checked: data?.length ?? 0, raised };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async getQuietHours(userId: string): Promise<QuietHours | null> {
    try {
      const { data } = await this.supabase
        .from('heartbeat_state')
        .select('quiet_start, quiet_end, timezone')
        .eq('user_id', userId)
        .maybeSingle();
      if (!data?.quiet_start || !data?.quiet_end) return null;
      return {
        start: data.quiet_start,
        end: data.quiet_end,
        timezone: data.timezone || 'UTC',
      };
    } catch {
      // Failing to read quiet hours must not silence an alert.
      return null;
    }
  }

  /**
   * Persist the per-sink record, under its own budget.
   *
   * The sink budgets bound the SENDS; they never covered the database awaits
   * that follow. This write is diagnostic — it answers "why did nobody hear
   * about this" afterwards — while settleClaim, which runs next, is the one
   * that must happen, because an unsettled claim suppresses the condition
   * until TTL expires. Awaiting the diagnostic write unbounded put it in front
   * of the essential one: a hung PostgREST update held the whole ingest past
   * the poster's 20s deadline and settleClaim never ran at all (PR #539 r3,
   * Lumen).
   *
   * Bounded here rather than at the call sites because all three of them —
   * raise, resolve and recovery — had the same unbounded await.
   */
  private async recordDelivery(
    eventId: string,
    deliveries: SinkResult[],
    budget: RequestBudget = new RequestBudget()
  ): Promise<void> {
    try {
      await withTimeout(
        'delivery record',
        this.persistDelivery(eventId, deliveries),
        budget.cap(DELIVERY_RECORD_TIMEOUT_MS)
      );
    } catch (error) {
      // Losing the diagnostic is survivable; losing the settlement is not.
      logger.error('Failed to record alert delivery', { eventId, error });
    }
  }

  private async persistDelivery(eventId: string, deliveries: SinkResult[]): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('alert_events')
        // SinkResult is a flat record of primitives, so it is structurally Json
        // even though TypeScript cannot narrow an interface to it.
        .update({ delivery: deliveries as unknown as Json })
        .eq('id', eventId);
      if (error) {
        // This is the per-sink record that answers "why did nobody hear about
        // this" after the fact. Losing it silently costs exactly the debugging
        // the column exists for.
        logger.error('Failed to record alert delivery', { eventId, error: error.message });
      }
    } catch (error) {
      logger.error('Failed to record alert delivery', { eventId, error });
    }
  }
}

export function formatAlertText(event: {
  severity: AlertSeverity;
  source: string;
  title: string;
  detail?: string;
  occurrenceCount: number;
  kind?: 'raised' | 'resolved';
}): string {
  const icon =
    event.kind === 'resolved'
      ? '✅'
      : event.severity === 'critical'
        ? '🚨'
        : event.severity === 'warning'
          ? '⚠️'
          : 'ℹ️';

  const lines = [`${icon} ${event.title}`];
  if (event.detail) lines.push('', event.detail);

  const context = [`source: ${event.source}`];
  if (event.occurrenceCount > 1) context.push(`${event.occurrenceCount} occurrences`);
  lines.push('', `_${context.join(' · ')}_`);

  return lines.join('\n');
}
