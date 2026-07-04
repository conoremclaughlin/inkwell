/**
 * useEventStream — live activity_stream subscription over SSE.
 *
 * Connects to GET /api/admin/events (same-origin, cookie-authenticated —
 * same pattern as the WhatsApp QR EventSource). The browser handles
 * reconnects natively; the server reads Last-Event-ID as a since-cursor,
 * so reconnects are gapless.
 *
 * See ink://specs/live-session-experience (WS1).
 */

'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

/** activity_stream row as serialized by /api/admin/events */
export interface StreamActivity {
  id: string;
  userId: string;
  sessionId: string | null;
  agentId: string;
  type: string;
  subtype: string | null;
  content: string;
  payload: Record<string, unknown>;
  parentId: string | null;
  childSessionId: string | null;
  taskGroupId: string | null;
  platform: string | null;
  status: string;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

export interface EventStreamFilter {
  sessionId?: string;
  taskGroupId?: string;
  agentId?: string;
  /** ISO timestamp — backfill persisted events from this point on connect */
  since?: string;
}

export type EventStreamStatus = 'connecting' | 'live' | 'error' | 'idle';

export interface UseEventStreamResult {
  /** Events received this connection, oldest first (backfill + live) */
  events: StreamActivity[];
  status: EventStreamStatus;
  /** Clear accumulated events (e.g. after merging into another store) */
  clear: () => void;
}

const MAX_BUFFERED_EVENTS = 1000;

export function useEventStream(
  filter: EventStreamFilter,
  options?: { enabled?: boolean; onEvent?: (activity: StreamActivity) => void }
): UseEventStreamResult {
  const enabled = options?.enabled ?? true;
  const [events, setEvents] = useState<StreamActivity[]>([]);
  const [status, setStatus] = useState<EventStreamStatus>(enabled ? 'connecting' : 'idle');
  const onEventRef = useRef(options?.onEvent);
  onEventRef.current = options?.onEvent;

  const { sessionId, taskGroupId, agentId, since } = filter;

  const clear = useCallback(() => setEvents([]), []);

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return;
    }

    const params = new URLSearchParams();
    if (sessionId) params.set('sessionId', sessionId);
    if (taskGroupId) params.set('taskGroupId', taskGroupId);
    if (agentId) params.set('agentId', agentId);
    if (since) params.set('since', since);

    setStatus('connecting');
    const source = new EventSource(`/api/admin/events?${params.toString()}`);
    const seen = new Set<string>();

    source.addEventListener('ready', () => setStatus('live'));

    source.addEventListener('activity', (event: MessageEvent) => {
      try {
        const activity = JSON.parse(event.data) as StreamActivity;
        if (seen.has(activity.id)) return;
        seen.add(activity.id);
        setEvents((prev) => {
          const next = [...prev, activity];
          return next.length > MAX_BUFFERED_EVENTS
            ? next.slice(next.length - MAX_BUFFERED_EVENTS)
            : next;
        });
        onEventRef.current?.(activity);
      } catch {
        // Malformed frame — skip.
      }
    });

    source.onerror = () => {
      // EventSource retries automatically; reflect degraded state so views
      // can fall back to polling while it reconnects.
      setStatus('error');
    };

    source.onopen = () => setStatus('live');

    return () => {
      source.close();
      setStatus('idle');
    };
  }, [enabled, sessionId, taskGroupId, agentId, since]);

  return { events, status, clear };
}
