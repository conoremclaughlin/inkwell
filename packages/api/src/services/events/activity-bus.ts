/**
 * Activity Event Bus
 *
 * In-process pub/sub for activity_stream rows. The API server is the sole
 * writer of activity_stream, so a process-wide EventEmitter gives SSE
 * subscribers zero-latency delivery without DB polling or Supabase Realtime.
 *
 * Publishers: ActivityStreamRepository.logActivity() emits every row it
 * inserts. Subscribers: the /api/admin/events SSE endpoint filters by
 * userId (required) plus optional sessionId / taskGroupId / agentId.
 *
 * See ink://specs/live-session-experience (WS1).
 */

import { EventEmitter } from 'events';
import type { Activity } from '../../data/repositories/activity-stream.repository';

export interface ActivityFilter {
  userId: string;
  sessionId?: string;
  taskGroupId?: string;
  agentId?: string;
}

type ActivityListener = (activity: Activity) => void;

class ActivityBus extends EventEmitter {
  constructor() {
    super();
    // SSE fan-out: every open dashboard tab is a listener. Keep headroom
    // well above the default 10 before Node warns.
    this.setMaxListeners(200);
  }

  publish(activity: Activity): void {
    this.emit('activity', activity);
  }

  /**
   * Subscribe with a filter. Returns an unsubscribe function — callers MUST
   * invoke it when the SSE connection closes or listeners leak.
   */
  subscribe(filter: ActivityFilter, listener: ActivityListener): () => void {
    const wrapped: ActivityListener = (activity) => {
      if (activity.userId !== filter.userId) return;
      if (filter.sessionId && activity.sessionId !== filter.sessionId) return;
      if (filter.taskGroupId && activity.taskGroupId !== filter.taskGroupId) return;
      if (filter.agentId && activity.agentId !== filter.agentId) return;
      listener(activity);
    };
    this.on('activity', wrapped);
    return () => this.off('activity', wrapped);
  }
}

export const activityBus = new ActivityBus();
