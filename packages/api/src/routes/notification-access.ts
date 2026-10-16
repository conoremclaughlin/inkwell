import { Router, json, type Request, type Response } from 'express';
import { z } from 'zod';
import { accountGate, spaceGate, GateClosedError } from '../services/account-deletion/gate';
import { FixedWindowLimiter } from '../utils/fixed-window-limiter';
import {
  NOTIFICATION_BODY_LIMIT,
  createNotificationWatcherSchema,
} from '../services/notification-access/contract';
import {
  admitNotification,
  notificationDeviceTokenDigest,
} from '../services/notification-access/policy';
import {
  NotificationAccessError,
  notificationAccessState,
  type NotificationAccessStore,
  type NotificationOwner,
  type NotificationWatcher,
} from '../services/notification-access/store';

type Store = Pick<
  NotificationAccessStore,
  'create' | 'deviceAccess' | 'list' | 'revoke' | 'remove' | 'record' | 'events'
>;
export interface NotificationRouterDependencies {
  /** Null means not configured. No hidden in-memory production fallback. */
  store: () => Promise<Store | null>;
  now?: () => number;
}

function failure(res: Response, error: unknown): void {
  const code =
    error instanceof NotificationAccessError
      ? error.code
      : error instanceof GateClosedError
        ? 'access_inactive'
        : 'unavailable';
  const statuses = {
    invalid_request: 422,
    access_inactive: 401,
    target_refused: 403,
    not_found: 404,
    already_active: 409,
    grant_limit: 409,
    event_refused: 422,
    event_conflict: 409,
    rate_limited: 429,
    unavailable: 503,
  } as const;
  if (code === 'rate_limited') res.setHeader('Retry-After', '60');
  res.status(statuses[code]).json({ error: code });
}

function scopeOf(req: Request): NotificationOwner {
  const signed = req as Request & { inkUserId?: string; inkWorkspaceId?: string };
  if (!signed.inkUserId || !signed.inkWorkspaceId)
    throw new NotificationAccessError('access_inactive');
  return { ownerId: signed.inkUserId, workspaceId: signed.inkWorkspaceId };
}

async function underGates<T>(scope: NotificationOwner, work: () => Promise<T>): Promise<T> {
  const account = accountGate.enter(scope.ownerId);
  try {
    const space = spaceGate.enter(scope.workspaceId);
    try {
      return await work();
    } finally {
      space.release();
    }
  } finally {
    account.release();
  }
}

function publicWatcher(watcher: NotificationWatcher, now: number) {
  return {
    id: watcher.id,
    installationId: watcher.installation_id,
    recipientId: watcher.recipient_id,
    conversationId: watcher.thread_id,
    selectedPackages: watcher.selected_packages,
    rules: watcher.rules,
    status:
      watcher.status === 'active' && Date.parse(watcher.expires_at) <= now
        ? 'expired'
        : watcher.status,
    activeSince: watcher.active_since,
    expiresAt: watcher.expires_at,
    createdAt: watcher.created_at,
  };
}

async function requireStore(deps: NotificationRouterDependencies): Promise<Store> {
  const store = await deps.store();
  if (!store) throw new NotificationAccessError('unavailable');
  return store;
}

/** Mount ONLY after existing admin authentication; this router never authenticates an SB. */
export function createNotificationAccessAdminRouter(deps: NotificationRouterDependencies): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/watchers', async (req, res) => {
    try {
      const scope = scopeOf(req);
      const rows = await underGates(scope, async () => (await requireStore(deps)).list(scope));
      res.json({ watchers: rows.map((row) => publicWatcher(row, now())) });
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/watchers', async (req, res) => {
    try {
      const scope = scopeOf(req);
      const input = createNotificationWatcherSchema.safeParse(req.body);
      if (!input.success) throw new NotificationAccessError('invalid_request');
      const result = await underGates(scope, async () =>
        (await requireStore(deps)).create(scope, input.data, now())
      );
      res
        .status(201)
        .json({ watcher: publicWatcher(result.watcher, now()), deviceToken: result.deviceToken });
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/watchers/:watcherId/revoke', async (req, res) => {
    try {
      const scope = scopeOf(req);
      const id = z.string().uuid().safeParse(req.params.watcherId);
      if (!id.success) throw new NotificationAccessError('invalid_request');
      await underGates(scope, async () => (await requireStore(deps)).revoke(scope, id.data));
      res.status(204).end();
    } catch (error) {
      failure(res, error);
    }
  });
  router.delete('/watchers/:watcherId', async (req, res) => {
    try {
      const scope = scopeOf(req);
      const id = z.string().uuid().safeParse(req.params.watcherId);
      if (!id.success) throw new NotificationAccessError('invalid_request');
      await underGates(scope, async () => (await requireStore(deps)).remove(scope, id.data));
      res.status(204).end();
    } catch (error) {
      failure(res, error);
    }
  });
  router.get('/watchers/:watcherId/events', async (req, res) => {
    try {
      const scope = scopeOf(req);
      const id = z.string().uuid().safeParse(req.params.watcherId);
      if (!id.success) throw new NotificationAccessError('invalid_request');
      const events = await underGates(scope, async () =>
        (await requireStore(deps)).events(scope, id.data, now())
      );
      res.json({ events });
    } catch (error) {
      failure(res, error);
    }
  });
  return router;
}

/**
 * Separate, default-deny device surface. Mount before any global body parser
 * so unauthenticated requests cannot make the JSON parser read a large body.
 * No model wake or other side effect is attached to this initial intake path.
 */
export function createNotificationIntakeRouter(deps: NotificationRouterDependencies): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  const attempts = new FixedWindowLimiter(60_000, 10_000);
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST' || req.path !== '/events') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (attempts.hit(req.ip || 'unknown', 1200, now())) {
      failure(res, new NotificationAccessError('rate_limited'));
      return;
    }
    const auth = req.headers.authorization;
    const digest = notificationDeviceTokenDigest(
      auth?.startsWith('Bearer ') ? auth.slice(7) : null
    );
    if (!digest) {
      failure(res, new NotificationAccessError('access_inactive'));
      return;
    }
    res.locals.notificationDigest = digest;
    next();
  });
  router.use(async (_req, res, next) => {
    try {
      const store = await requireStore(deps);
      const watcher = await store.deviceAccess(res.locals.notificationDigest as string, now());
      if (!watcher) throw new NotificationAccessError('access_inactive');
      res.locals.notificationStore = store;
      res.locals.notificationWatcher = watcher;
      next();
    } catch (error) {
      failure(res, error);
    }
  });
  router.use(json({ limit: NOTIFICATION_BODY_LIMIT, strict: true, inflate: false }));
  router.post('/events', async (req, res) => {
    try {
      const store = res.locals.notificationStore as Store;
      const watcher = res.locals.notificationWatcher as NotificationWatcher;
      await underGates(
        { ownerId: watcher.owner_id, workspaceId: watcher.workspace_id },
        async () => {
          const admitted = admitNotification(req.body, notificationAccessState(watcher), now());
          if (!admitted.ok)
            throw new NotificationAccessError(
              admitted.reason === 'access_inactive' ? 'access_inactive' : 'event_refused'
            );
          // The INSERT trigger rechecks revocation/sign-in and deduplicates in
          // the same transaction as the write; this read cannot fence that race.
          await store.record(watcher, admitted.event);
        }
      );
      res.status(202).json({ accepted: true });
    } catch (error) {
      failure(res, error);
    }
  });
  router.use((error: unknown, _req: Request, res: Response, _next: (error?: unknown) => void) => {
    // Parser failures must not reflect a notification body or expose a stack.
    const status = (error as { status?: unknown } | null)?.status;
    res
      .status(status === 413 ? 413 : status === 415 ? 415 : 400)
      .json({ error: 'invalid_request' });
  });
  return router;
}
