/**
 * Audit Service
 *
 * Logs sensitive operations for security monitoring and compliance.
 * All external requests, permission changes, and auth events are logged.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export type AuditAction =
  | 'web_search'
  | 'web_search_batch'
  | 'web_fetch'
  | 'bash_curl'
  | 'bash_command'
  | 'file_read'
  | 'file_write'
  | 'permission_change'
  | 'auth_login'
  | 'auth_logout'
  | 'group_authorize'
  | 'group_revoke'
  | 'trusted_user_add'
  | 'trusted_user_remove';

export type AuditCategory = 'network' | 'filesystem' | 'permission' | 'auth' | 'execution';
// A pending entry records intent, not a successful external action. A later
// entry carries the outcome and the same metadata.requestId.
export type AuditStatus = 'pending' | 'success' | 'blocked' | 'error';

export interface AuditEntry {
  // Who
  userId?: string;
  platform?: string;
  platformUserId?: string;
  conversationId?: string;

  // What
  action: AuditAction;
  category: AuditCategory;

  // Details
  target?: string;
  requestSummary?: string;
  responseStatus: AuditStatus;
  responseSummary?: string;

  // Context
  backend?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogRecord extends AuditEntry {
  id: string;
  timestamp: Date;
}

export interface AuditQueryOptions {
  userId?: string;
  action?: AuditAction;
  category?: AuditCategory;
  status?: AuditStatus;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

export class AuditService {
  private supabase: SupabaseClient;

  constructor() {
    this.supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Log an audit entry
   */
  async log(entry: AuditEntry, options: { required?: boolean } = {}): Promise<void> {
    const record = {
      user_id: entry.userId || null,
      platform: entry.platform || null,
      platform_user_id: entry.platformUserId || null,
      conversation_id: entry.conversationId || null,
      action: entry.action,
      category: entry.category,
      target: entry.target || null,
      request_summary: entry.requestSummary || null,
      response_status: entry.responseStatus,
      response_summary: entry.responseSummary || null,
      backend: entry.backend || null,
      session_id: entry.sessionId || null,
      metadata: entry.metadata || {},
    };

    try {
      const query = this.supabase.from('audit_log').insert(record);
      // Required callers must not wait forever before (or after) an external
      // effect. A timeout is unknown persistence, never proof of no insertion.
      const { error } = await (options.required
        ? query.abortSignal(AbortSignal.timeout(5000))
        : query);
      if (error) throw new Error('Audit write failed');
      logger.debug('Audit logged', { action: entry.action });
    } catch {
      // Queries/results can contain private text. Neither the entry nor a
      // database/provider exception belongs in global diagnostic logs.
      logger.error('Failed to write audit log', { action: entry.action });
      if (options.required) throw new Error('Required audit persistence unavailable');
    }
  }

  /**
   * Log a network request (web search, web fetch, curl)
   */
  async logNetworkRequest(
    action: 'web_search' | 'web_fetch' | 'bash_curl',
    target: string,
    status: AuditStatus,
    context: {
      userId?: string;
      platform?: string;
      platformUserId?: string;
      conversationId?: string;
      backend?: string;
      sessionId?: string;
      requestSummary?: string;
      responseSummary?: string;
    }
  ): Promise<void> {
    await this.log({
      action,
      category: 'network',
      target,
      responseStatus: status,
      ...context,
    });
  }

  /**
   * Log a permission change
   */
  async logPermissionChange(
    userId: string,
    permissionId: string,
    enabled: boolean,
    context: {
      grantedBy?: string;
      reason?: string;
      platform?: string;
    }
  ): Promise<void> {
    await this.log({
      userId,
      action: 'permission_change',
      category: 'permission',
      target: permissionId,
      requestSummary: `${enabled ? 'Enable' : 'Disable'} ${permissionId}`,
      responseStatus: 'success',
      responseSummary: context.reason,
      platform: context.platform,
      metadata: { grantedBy: context.grantedBy, enabled },
    });
  }

  /**
   * Log an auth event (group auth, trusted user changes)
   */
  async logAuthEvent(
    action: 'group_authorize' | 'group_revoke' | 'trusted_user_add' | 'trusted_user_remove',
    target: string,
    status: AuditStatus,
    context: {
      userId?: string;
      platform?: string;
      platformUserId?: string;
      responseSummary?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    await this.log({
      action,
      category: 'auth',
      target,
      responseStatus: status,
      ...context,
    });
  }

  /**
   * Query audit logs
   */
  async query(options: AuditQueryOptions = {}): Promise<AuditLogRecord[]> {
    let query = this.supabase
      .from('audit_log')
      .select('*')
      .order('timestamp', { ascending: false });

    if (options.userId) {
      query = query.eq('user_id', options.userId);
    }
    if (options.action) {
      query = query.eq('action', options.action);
    }
    if (options.category) {
      query = query.eq('category', options.category);
    }
    if (options.status) {
      query = query.eq('response_status', options.status);
    }
    if (options.startDate) {
      query = query.gte('timestamp', options.startDate.toISOString());
    }
    if (options.endDate) {
      query = query.lte('timestamp', options.endDate.toISOString());
    }

    query = query.limit(options.limit || 100);

    if (options.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 100) - 1);
    }

    const { data, error } = await query;

    if (error || !data) {
      logger.error('Failed to query audit log', { error });
      return [];
    }

    return data.map((r) => ({
      id: r.id,
      timestamp: new Date(r.timestamp),
      userId: r.user_id,
      platform: r.platform,
      platformUserId: r.platform_user_id,
      conversationId: r.conversation_id,
      action: r.action as AuditAction,
      category: r.category as AuditCategory,
      target: r.target,
      requestSummary: r.request_summary,
      responseStatus: r.response_status as AuditStatus,
      responseSummary: r.response_summary,
      backend: r.backend,
      sessionId: r.session_id,
      metadata: r.metadata,
    }));
  }

  /**
   * Get recent activity summary for a user
   */
  async getUserActivitySummary(
    userId: string,
    hours = 24
  ): Promise<{ action: AuditAction; count: number }[]> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const { data, error } = await this.supabase
      .from('audit_log')
      .select('action')
      .eq('user_id', userId)
      .gte('timestamp', since.toISOString());

    if (error || !data) {
      return [];
    }

    // Count by action
    const counts = new Map<AuditAction, number>();
    for (const row of data) {
      const action = row.action as AuditAction;
      counts.set(action, (counts.get(action) || 0) + 1);
    }

    return Array.from(counts.entries()).map(([action, count]) => ({ action, count }));
  }
}

// Singleton
let auditServiceInstance: AuditService | null = null;

export function getAuditService(): AuditService {
  if (!auditServiceInstance) {
    auditServiceInstance = new AuditService();
  }
  return auditServiceInstance;
}
