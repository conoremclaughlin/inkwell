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

/** Per-sink ceiling. A hung sink must not hold the checker's request open. */
const SINK_TIMEOUT_MS = 10_000;

export interface SinkResult {
  sink: 'user' | 'agents' | 'webhook';
  target: string;
  ok: boolean;
  detail?: string;
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

async function withTimeout<T>(label: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${SINK_TIMEOUT_MS}ms`)),
          SINK_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  async ingest(userId: string, alert: ParsedAlert): Promise<AlertDispatchResult> {
    await this.touchSource(userId, alert);

    if (alert.status === 'ok') {
      return this.resolve(userId, alert);
    }

    const { data, error } = await this.supabase.rpc('ingest_alert_event', {
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
    });

    if (error) throw new Error(`Failed to record alert: ${error.message}`);

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('Failed to record alert: ingest returned no row');

    const eventId: string = row.event_id;
    const isNew: boolean = row.is_new;
    const shouldNotify: boolean = row.should_notify;
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

    const deliveries = await this.fanOut(userId, {
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
    });

    await this.recordDelivery(eventId, deliveries);
    const notified = await this.settleClaim(eventId, deliveries);

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
   * On success last_notified_at is stamped and the cooldown starts running
   * from a real delivery. On total failure the claim is released so the next
   * occurrence retries immediately — the alternative is an hour of silence
   * bought by a notification nobody received.
   *
   * Returns whether anything was delivered.
   */
  private async settleClaim(eventId: string, deliveries: SinkResult[]): Promise<boolean> {
    const delivered = deliveries.some((d) => d.ok);

    const { error } = await this.supabase.rpc(
      delivered ? 'mark_alert_notified' : 'release_alert_claim',
      { p_event_id: eventId }
    );

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

  private async resolve(userId: string, alert: ParsedAlert): Promise<AlertDispatchResult> {
    const { data, error } = await this.supabase.rpc('resolve_alert_event', {
      p_user_id: userId,
      p_dedupe_key: alert.dedupeKey,
    });

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

    const deliveries = await this.fanOut(userId, {
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
    });

    await this.recordDelivery(row.event_id, deliveries);

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
    }
  ): Promise<SinkResult[]> {
    // Sinks run concurrently and are settled independently — one sink's
    // failure must never cancel another's delivery.
    const results = await Promise.allSettled([
      this.notifyUserChannel(userId, event),
      this.notifyAgents(userId, event),
      this.notifyWebhooks(userId, event),
    ]);

    return results.flatMap((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const sink = (['user', 'agents', 'webhook'] as const)[i];
      logger.error('Alert sink failed', { sink, error: r.reason });
      return [{ sink, target: sink, ok: false, detail: String(r.reason) }];
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
    }
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
    }
  ): Promise<SinkResult[]> {
    const recipients = event.notifyAgents ?? [];
    if (recipients.length === 0) return [];

    // Grouped per source so an SB reading the thread sees this condition's
    // history rather than a pile of disconnected one-off messages.
    const threadKey = `ops:alert:${event.source}`;

    try {
      const { handleSendToInbox } = await import('../../mcp/tools/inbox-handlers.js');
      await withTimeout(
        'agent inbox',
        handleSendToInbox(
          {
            userId,
            senderAgentId: 'system',
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
      return recipients.map((agentId) => ({ sink: 'agents' as const, target: agentId, ok: true }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return recipients.map((agentId) => ({
        sink: 'agents' as const,
        target: agentId,
        ok: false,
        detail,
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
    }
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
          this.deliverWebhook(w, event) as Promise<SinkResult>
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
    }
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
        })
      );

      const ok = response.ok;
      if (ok) {
        await this.supabase
          .from('alert_webhooks')
          .update({
            last_delivery_at: new Date().toISOString(),
            last_delivery_status: response.status,
            last_delivery_error: null,
            consecutive_failures: 0,
          })
          .eq('id', webhook.id);
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
      return { sink: 'webhook', target: webhook.name, ok: false, detail };
    }
  }

  private async bumpWebhookFailure(
    webhookId: string,
    detail?: string,
    status?: number
  ): Promise<void> {
    try {
      await this.supabase.rpc('record_alert_webhook_failure', {
        p_webhook_id: webhookId,
        ...(detail === undefined ? {} : { p_error: detail }),
        ...(status === undefined ? {} : { p_status: status }),
      });
    } catch {
      // Failure bookkeeping is diagnostic; never let it mask the delivery
      // outcome we are in the middle of reporting.
    }
  }

  // ── Liveness ────────────────────────────────────────────────────────────

  /** Record that this source is alive, whatever it is reporting. */
  private async touchSource(userId: string, alert: ParsedAlert): Promise<void> {
    try {
      await this.supabase.from('alert_sources').upsert(
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
      );
    } catch (error) {
      logger.error('Failed to touch alert source', { source: alert.source, error });
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
        await this.ingest(row.user_id, {
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
        // Marked after a successful raise so a failed raise is retried next
        // sweep instead of being silently marked as handled.
        await this.supabase
          .from('alert_sources')
          .update({ stale_alerted_at: now.toISOString() })
          .eq('id', row.id);
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

  private async recordDelivery(eventId: string, deliveries: SinkResult[]): Promise<void> {
    try {
      await this.supabase
        .from('alert_events')
        // SinkResult is a flat record of primitives, so it is structurally Json
        // even though TypeScript cannot narrow an interface to it.
        .update({ delivery: deliveries as unknown as Json })
        .eq('id', eventId);
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
