import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  createNotificationWatcherSchema,
  notificationPackagesSchema,
  notificationRulesSchema,
  updateNotificationRulesSchema,
  type CreateNotificationWatcher,
  type NotificationEvent,
} from './contract';
import { issueNotificationDeviceToken, notificationFingerprint } from './policy';
import type { NotificationAccessState } from './policy';

export interface NotificationOwner {
  ownerId: string;
  workspaceId: string;
}

export type NotificationErrorCode =
  | 'invalid_request'
  | 'access_inactive'
  | 'target_refused'
  | 'not_found'
  | 'already_active'
  | 'grant_limit'
  | 'event_refused'
  | 'event_conflict'
  | 'rate_limited'
  | 'unavailable';

/** Machine codes only: database errors can contain notification text or credentials. */
export class NotificationAccessError extends Error {
  constructor(readonly code: NotificationErrorCode) {
    super(code);
    this.name = 'NotificationAccessError';
  }
}

function check(error: { code?: string } | null): void {
  if (!error) return;
  const codes: Record<string, NotificationErrorCode> = {
    NPA02: 'access_inactive',
    NPA03: 'target_refused',
    NPA04: 'invalid_request',
    NPA05: 'event_refused',
    NPA06: 'event_conflict',
    NPA07: 'rate_limited',
    NPA08: 'grant_limit',
    '23505': 'already_active',
    '23503': 'access_inactive',
  };
  throw new NotificationAccessError(codes[error.code ?? ''] ?? 'unavailable');
}

const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const watcherSchema = z.object({
  id: z.string().uuid(),
  owner_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  recipient_id: z.string().uuid(),
  thread_id: z.string().uuid(),
  signin_id: z.string().uuid(),
  installation_id: z.string().uuid(),
  selected_packages: notificationPackagesSchema,
  clock_offset_ms: z.number().int().safe(),
  status: z.enum(['active', 'paused', 'revoked']),
  active_since: timestamp,
  expires_at: timestamp,
  created_at: timestamp,
});

export type NotificationWatcher = z.infer<typeof watcherSchema>;

// Never select refresh_token or token_digest on a listing or response path.
const WATCHER_COLUMNS =
  'id, owner_id, workspace_id, recipient_id, thread_id, signin_id, installation_id, selected_packages, clock_offset_ms, status, active_since, expires_at, created_at';

const ruleVersionSchema = z.object({
  revision: z.number().int().positive(),
  rules: notificationRulesSchema,
});

function watcherFrom(raw: unknown): NotificationWatcher {
  const parsed = watcherSchema.safeParse(raw);
  if (!parsed.success) throw new NotificationAccessError('unavailable');
  return parsed.data;
}

export function notificationAccessState(watcher: NotificationWatcher): NotificationAccessState {
  return {
    status: watcher.status,
    selectedPackages: watcher.selected_packages,
    activeSince: Date.parse(watcher.active_since),
    expiresAt: Date.parse(watcher.expires_at),
    clockOffsetMs: watcher.clock_offset_ms,
  };
}

/** Only the person's private one-to-one conversation, not a workspace-readable thread. */
export async function assertNotificationTarget(
  db: SupabaseClient,
  scope: NotificationOwner,
  recipientId: string,
  conversationId: string,
  lookup: 'thread_key' | 'id' = 'thread_key'
): Promise<string> {
  const identity = await db
    .from('agent_identities')
    .select('id')
    .eq('id', recipientId)
    .eq('user_id', scope.ownerId)
    .eq('workspace_id', scope.workspaceId)
    .maybeSingle();
  check(identity.error);
  const thread = await db
    .from('inbox_threads')
    .select('id, metadata')
    .eq(lookup, conversationId)
    .eq('workspace_id', scope.workspaceId)
    .maybeSingle();
  check(thread.error);
  const metadata = thread.data?.metadata as Record<string, unknown> | null | undefined;
  if (
    !identity.data ||
    !thread.data ||
    !z.string().uuid().safeParse(thread.data.id).success ||
    metadata?.inklingConversation !== true ||
    metadata?.inklingShared === true
  ) {
    throw new NotificationAccessError('target_refused');
  }
  const members = await db
    .from('inbox_thread_participants')
    .select('sb_id, user_id')
    .eq('thread_id', thread.data.id)
    .limit(3);
  check(members.error);
  const parsed = z
    .array(z.object({ sb_id: z.string().nullable(), user_id: z.string().nullable() }))
    .safeParse(members.data);
  if (
    !parsed.success ||
    parsed.data.length !== 2 ||
    !parsed.data.some((row) => row.user_id === scope.ownerId && row.sb_id === null) ||
    !parsed.data.some((row) => row.sb_id === recipientId && row.user_id === null)
  )
    throw new NotificationAccessError('target_refused');
  return thread.data.id;
}

/**
 * PostgREST adapter. Intake races are serialized by the INSERT trigger, not
 * by a JavaScript mutex. No method logs a query, token, or notification.
 * New table shapes are local until the migration is applied and types regenerated.
 */
export class NotificationAccessStore {
  constructor(private readonly db: SupabaseClient) {}

  async create(
    scope: NotificationOwner,
    input: CreateNotificationWatcher,
    now: number
  ): Promise<{ watcher: NotificationWatcher; deviceToken: string }> {
    const parsed = createNotificationWatcherSchema.safeParse(input);
    if (!parsed.success) throw new NotificationAccessError('invalid_request');
    const signin = await this.db
      .from('mcp_tokens')
      .select('id, expires_at')
      .eq('refresh_token', parsed.data.refreshToken)
      .eq('user_id', scope.ownerId)
      .eq('client_id', 'mobile')
      .gt('expires_at', new Date(now).toISOString())
      .maybeSingle();
    check(signin.error);
    const session = z
      .object({ id: z.string().uuid(), expires_at: timestamp })
      .safeParse(signin.data);
    if (!session.success) throw new NotificationAccessError('access_inactive');
    const threadId = await assertNotificationTarget(
      this.db,
      scope,
      parsed.data.recipientId,
      parsed.data.conversationId
    );
    const credential = issueNotificationDeviceToken();
    const created = await this.db
      .from('sb_notification_watchers')
      .insert({
        owner_id: scope.ownerId,
        workspace_id: scope.workspaceId,
        recipient_id: parsed.data.recipientId,
        thread_id: threadId,
        signin_id: session.data.id,
        installation_id: parsed.data.installationId,
        selected_packages: parsed.data.selectedPackages,
        device_time_ms: parsed.data.deviceTime,
        token_digest: credential.digest,
        expires_at: session.data.expires_at,
      })
      .select(WATCHER_COLUMNS)
      .single();
    check(created.error);
    return { watcher: watcherFrom(created.data), deviceToken: credential.token };
  }

  async deviceAccess(digest: string, now: number): Promise<NotificationWatcher | null> {
    if (!/^[0-9a-f]{64}$/.test(digest)) return null;
    const result = await this.db
      .from('sb_notification_watchers')
      .select(WATCHER_COLUMNS)
      .eq('token_digest', digest)
      .eq('status', 'active')
      .gt('expires_at', new Date(now).toISOString())
      .maybeSingle();
    check(result.error);
    if (!result.data) return null;
    const watcher = watcherFrom(result.data);
    const signin = await this.db
      .from('mcp_tokens')
      .select('id')
      .eq('id', watcher.signin_id)
      .eq('user_id', watcher.owner_id)
      .eq('client_id', 'mobile')
      .gt('expires_at', new Date(now).toISOString())
      .maybeSingle();
    check(signin.error);
    return signin.data ? watcher : null;
  }

  async find(scope: NotificationOwner, id: string): Promise<NotificationWatcher | null> {
    const result = await this.db
      .from('sb_notification_watchers')
      .select(WATCHER_COLUMNS)
      .eq('id', id)
      .eq('owner_id', scope.ownerId)
      .eq('workspace_id', scope.workspaceId)
      .maybeSingle();
    check(result.error);
    return result.data ? watcherFrom(result.data) : null;
  }

  async list(scope: NotificationOwner): Promise<NotificationWatcher[]> {
    const result = await this.db
      .from('sb_notification_watchers')
      .select(WATCHER_COLUMNS)
      .eq('owner_id', scope.ownerId)
      .eq('workspace_id', scope.workspaceId)
      // The database bounds all active-state grants for an owner at 10.
      // Keep them before historical rows so a busy history cannot hide revoke.
      .order('status', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(100);
    check(result.error);
    return (result.data ?? []).map(watcherFrom);
  }

  async revoke(scope: NotificationOwner, id: string): Promise<void> {
    const result = await this.db
      .from('sb_notification_watchers')
      .update({ status: 'revoked' })
      .eq('id', id)
      .eq('owner_id', scope.ownerId)
      .eq('workspace_id', scope.workspaceId);
    check(result.error);
  }

  async rules(
    scope: NotificationOwner,
    id: string
  ): Promise<{ revision: number; rules: z.infer<typeof notificationRulesSchema> }> {
    if (!(await this.find(scope, id))) throw new NotificationAccessError('not_found');
    const result = await this.db
      .from('sb_notification_rule_versions')
      .select('revision, rules')
      .eq('watcher_id', id)
      .order('revision', { ascending: false })
      .limit(1)
      .maybeSingle();
    check(result.error);
    if (!result.data) return { revision: 0, rules: [] };
    const parsed = ruleVersionSchema.safeParse(result.data);
    if (!parsed.success) throw new NotificationAccessError('unavailable');
    return parsed.data;
  }

  async setRules(
    scope: NotificationOwner,
    id: string,
    raw: unknown,
    now: number
  ): Promise<{ revision: number; rules: z.infer<typeof notificationRulesSchema> }> {
    const parsed = updateNotificationRulesSchema.safeParse(raw);
    if (!parsed.success) throw new NotificationAccessError('invalid_request');
    const watcher = await this.find(scope, id);
    if (!watcher) throw new NotificationAccessError('not_found');
    if (watcher.status !== 'active' || Date.parse(watcher.expires_at) <= now)
      throw new NotificationAccessError('access_inactive');
    if (!parsed.data.rules.every((rule) => watcher.selected_packages.includes(rule.packageName)))
      throw new NotificationAccessError('invalid_request');
    await assertNotificationTarget(this.db, scope, watcher.recipient_id, watcher.thread_id, 'id');
    // Append-only snapshots are both the current rule resource and its change log.
    // The trigger serializes the revision with revoke/logout, not a read/write race here.
    const result = await this.db
      .from('sb_notification_rule_versions')
      .insert({
        watcher_id: id,
        actor_id: scope.ownerId,
        rules: parsed.data.rules,
      })
      .select('revision, rules')
      .single();
    check(result.error);
    const version = ruleVersionSchema.safeParse(result.data);
    if (!version.success) throw new NotificationAccessError('unavailable');
    return version.data;
  }

  async remove(scope: NotificationOwner, id: string): Promise<void> {
    const result = await this.db
      .from('sb_notification_watchers')
      .delete()
      .eq('id', id)
      .eq('owner_id', scope.ownerId)
      .eq('workspace_id', scope.workspaceId);
    check(result.error);
  }

  async record(
    watcher: NotificationWatcher,
    event: NotificationEvent
  ): Promise<{ inserted: boolean }> {
    const result = await this.db
      .from('sb_notification_events')
      .insert({
        watcher_id: watcher.id,
        event_id: event.eventId,
        package_name: event.packageName,
        app_label: event.appLabel ?? null,
        title: event.title,
        text: event.text,
        device_posted_at_ms: event.postedAt,
        fingerprint: notificationFingerprint(event),
        // The trigger calibrates posted_at, sets receipt/expiry and refuses stale consent.
      })
      .select('id');
    // A non-representable event is terminal, not a temporary backend failure.
    // This backstop is deliberately local to event writes.
    if (result.error?.code === '22P05' || result.error?.code === '22P02')
      throw new NotificationAccessError('event_refused');
    check(result.error);
    return { inserted: Array.isArray(result.data) && result.data.length === 1 };
  }

  async events(scope: NotificationOwner, id: string, now: number): Promise<unknown[]> {
    if (!(await this.find(scope, id))) throw new NotificationAccessError('not_found');
    const result = await this.db
      .from('sb_notification_events')
      .select(
        'id, event_id, package_name, app_label, title, text, device_posted_at_ms, posted_at, received_at, expires_at'
      )
      .eq('watcher_id', id)
      .gt('expires_at', new Date(now).toISOString())
      .order('received_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(50);
    check(result.error);
    return result.data ?? [];
  }

  /** Bounded physical cleanup. Read-time expiry is enforced even if this is delayed. */
  async purgeExpired(now: number): Promise<number> {
    const cutoff = new Date(now).toISOString();
    const batch = await this.db
      .from('sb_notification_events')
      .select('id')
      .lte('expires_at', cutoff)
      .order('expires_at')
      .limit(500);
    check(batch.error);
    const ids = z.array(z.object({ id: z.string().uuid() })).safeParse(batch.data);
    if (!ids.success) throw new NotificationAccessError('unavailable');
    if (ids.data.length === 0) return 0;
    let deleted = 0;
    // .in() is encoded in the URL: 500 UUIDs exceed the gateway limit.
    // Retain the 500-row pass bound but issue short, retry-safe deletes.
    for (let offset = 0; offset < ids.data.length; offset += 50) {
      const result = await this.db
        .from('sb_notification_events')
        .delete()
        .in(
          'id',
          ids.data.slice(offset, offset + 50).map((row) => row.id)
        )
        .lte('expires_at', cutoff)
        .select('id');
      check(result.error);
      deleted += result.data?.length ?? 0;
    }
    return deleted;
  }
}
