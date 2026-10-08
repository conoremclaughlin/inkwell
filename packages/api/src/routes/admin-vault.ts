/**
 * Saved logins: a person's own, like a password manager's.
 *
 * Mounted by routes/admin.ts under /api/admin/vault, after admin auth. Every
 * query is the signed-in person's own rows, whatever workspace is selected:
 * a saved login is never shared into a group.
 *
 * What may be listed (name, address, username) and the secrets (password,
 * authenticator) are kept as separate encrypted halves, in Supabase Vault or
 * sealed by this server (services/saved-logins). Listing opens only the
 * first. A password leaves only through `reveal`, and an authenticator only as
 * its current code; its setup key is never sent back. Answers that carry
 * either are marked no-store. No route logs a request body or a value, and
 * errors carry no detail. Revealing a password or a code needs only the
 * person's ordinary signed-in session; nothing more is asked here.
 *
 * The server can read every value: this protects what is stored, not what
 * the server itself can read, and it is not end-to-end encryption. A value
 * that won't open refuses; nothing is ever written over a value that didn't
 * open.
 *
 * Agents can't use saved logins yet: no agent tool or integration reads
 * them. That is the absence of a dedicated path, not isolation from an agent
 * with generic shell, file or authenticated HTTP access to this server.
 */
import { Router, type Request, type Response } from 'express';
import { getDataComposer } from '../data/composer';
import { logger } from '../utils/logger';
import {
  authenticatorCode,
  authenticatorFrom,
  type Authenticator,
} from '../services/saved-logins/authenticator';
import { savedLoginStore, type SavedLoginStore } from '../services/saved-logins';
import type { LoginItem, LoginSecret, StoredLogin } from '../services/saved-logins/store';

type SignedIn = Request & { inkUserId: string };

export const LIMITS = { name: 120, url: 2048, username: 320, password: 1024 } as const;

const UNAVAILABLE = {
  error: 'Saved logins aren’t available on this server yet.',
  code: 'vault_unavailable',
};
const NOT_FOUND = { error: 'No saved login with that id', code: 'login_not_found' };
const REVISION_REQUIRED = {
  error: 'An edit must say which revision it was made from (ifRevision)',
  code: 'revision_required',
};
const TOO_MANY = { error: 'Too many saved logins to list', code: 'too_many_logins' };
const CHANGED = {
  error: 'This login changed since it was opened. Open it again to see the latest.',
  code: 'login_changed',
};

class Invalid extends Error {}

/** A trimmed text field: undefined if absent, null if empty, or refused if too long. */
function text(
  value: unknown,
  field: keyof typeof LIMITS,
  required = false
): string | null | undefined {
  if (value === undefined) {
    if (required) throw new Invalid(`${field} is required`);
    return undefined;
  }
  if (value === null) {
    if (required) throw new Invalid(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new Invalid(`${field} must be text`);
  // A password keeps its spaces; everything else is trimmed.
  const kept = field === 'password' ? value : value.trim();
  if (!kept) {
    if (required) throw new Invalid(`${field} is required`);
    return null;
  }
  if ([...kept].length > LIMITS[field]) {
    throw new Invalid(`${field} must be at most ${LIMITS[field]} characters`);
  }
  return kept;
}

/** An authenticator field: undefined if absent, null to remove, or refused if it isn't one. */
function authenticatorField(value: unknown): Authenticator | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const auth = typeof value === 'string' ? authenticatorFrom(value) : null;
  if (!auth) {
    throw new Invalid(
      'That isn’t an authenticator setup key. Copy the key the site shows when you set up two-step sign-in.'
    );
  }
  return auth;
}

function shape(login: StoredLogin, item: LoginItem, secret: LoginSecret | null) {
  return {
    id: login.id,
    name: item.name,
    url: item.url,
    username: item.username,
    hasPassword: secret ? secret.password !== null : undefined,
    hasAuthenticator: secret ? secret.authenticator !== null : undefined,
    revision: login.revision,
    createdAt: login.createdAt,
    updatedAt: login.updatedAt,
  };
}

async function client() {
  return (await getDataComposer()).getClient();
}

/** The store and the signed-in person, or the answer is sent and null returned. */
function context(req: Request, res: Response): { store: SavedLoginStore; userId: string } | null {
  const store = savedLoginStore(client);
  if (!store) {
    res.status(503).json(UNAVAILABLE);
    return null;
  }
  return { store, userId: (req as SignedIn).inkUserId };
}

function noStore(res: Response) {
  res.setHeader('Cache-Control', 'no-store');
}

function failed(res: Response, label: string, error: unknown) {
  if (error instanceof Invalid) {
    res.status(400).json({ error: error.message, code: 'invalid_login' });
    return;
  }
  // The message names the operation only; nothing from the request or the store.
  logger.error(`Saved logins: failed to ${label}`, {
    reason: error instanceof Error ? error.name : 'unknown',
  });
  res.status(500).json({ error: `Failed to ${label}` });
}

export const vaultRouter: Router = Router();

/** GET /api/admin/vault/logins: the person's logins by name, never their secrets. */
vaultRouter.get('/logins', async (req: Request, res: Response) => {
  try {
    const ctx = context(req, res);
    if (!ctx) return;
    const listed = await ctx.store.list(ctx.userId);
    if (listed === null) {
      res.status(500).json(TOO_MANY);
      return;
    }
    const logins = listed
      .map(({ login, item }) => shape(login, item, null))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map(({ hasPassword: _p, hasAuthenticator: _a, ...login }) => login);
    res.json({ logins });
  } catch (error) {
    failed(res, 'list saved logins', error);
  }
});

/** POST /api/admin/vault/logins: body { name, url?, username?, password?, authenticator? }. */
vaultRouter.post('/logins', async (req: Request, res: Response) => {
  try {
    const ctx = context(req, res);
    if (!ctx) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const item: LoginItem = {
      name: text(body.name, 'name', true)!,
      url: text(body.url, 'url') ?? null,
      username: text(body.username, 'username') ?? null,
    };
    const secret: LoginSecret = {
      password: text(body.password, 'password') ?? null,
      authenticator: authenticatorField(body.authenticator) ?? null,
    };
    const login = await ctx.store.create(ctx.userId, item, secret);
    res.status(201).json({ login: shape(login, item, secret) });
  } catch (error) {
    failed(res, 'save the login', error);
  }
});

/**
 * PATCH /api/admin/vault/logins/:id: any of { name, url, username, password,
 * authenticator }. null (or empty) clears a field; name can't be cleared.
 * Fields not sent keep their values. `ifRevision` is required and must be
 * the login's current revision: an edit made from an older copy is refused,
 * and so is one that loses a race with another write. Both halves and the next
 * revision are written in one statement.
 */
vaultRouter.patch('/logins/:id', async (req: Request, res: Response) => {
  try {
    const ctx = context(req, res);
    if (!ctx) return;
    const opened = await ctx.store.open(ctx.userId, req.params.id, ['item', 'secret']);
    if (!opened) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.ifRevision !== 'number') {
      res.status(400).json(REVISION_REQUIRED);
      return;
    }
    if (body.ifRevision !== opened.login.revision) {
      res.status(409).json(CHANGED);
      return;
    }
    const item = opened.item!;
    const secret = opened.secret!;
    if (body.name !== undefined) item.name = text(body.name, 'name', true)!;
    const url = text(body.url, 'url');
    if (url !== undefined) item.url = url;
    const username = text(body.username, 'username');
    if (username !== undefined) item.username = username;
    const password = text(body.password, 'password');
    if (password !== undefined) secret.password = password;
    const authenticator = authenticatorField(body.authenticator);
    if (authenticator !== undefined) secret.authenticator = authenticator;
    const login = await ctx.store.replace(
      ctx.userId,
      opened.login.id,
      opened.login.revision,
      item,
      secret
    );
    if (!login) {
      res.status(409).json(CHANGED);
      return;
    }
    res.json({ login: shape(login, item, secret) });
  } catch (error) {
    failed(res, 'update the login', error);
  }
});

/** DELETE /api/admin/vault/logins/:id */
vaultRouter.delete('/logins/:id', async (req: Request, res: Response) => {
  try {
    const ctx = context(req, res);
    if (!ctx) return;
    if (!(await ctx.store.remove(ctx.userId, req.params.id))) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    res.json({ deleted: true });
  } catch (error) {
    failed(res, 'delete the login', error);
  }
});

/** GET /api/admin/vault/logins/:id: one login, with whether it has each secret, never the secrets. */
vaultRouter.get('/logins/:id', async (req: Request, res: Response) => {
  try {
    const ctx = context(req, res);
    if (!ctx) return;
    const opened = await ctx.store.open(ctx.userId, req.params.id, ['item', 'secret']);
    if (!opened) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    res.json({ login: shape(opened.login, opened.item!, opened.secret!) });
  } catch (error) {
    failed(res, 'read the login', error);
  }
});

/** POST /api/admin/vault/logins/:id/reveal: the password, for the person to see or copy. */
vaultRouter.post('/logins/:id/reveal', async (req: Request, res: Response) => {
  try {
    const ctx = context(req, res);
    if (!ctx) return;
    const opened = await ctx.store.open(ctx.userId, req.params.id, ['secret']);
    if (!opened) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    noStore(res);
    res.json({ password: opened.secret!.password });
  } catch (error) {
    failed(res, 'show the password', error);
  }
});

/** POST /api/admin/vault/logins/:id/code: the authenticator's current code. */
vaultRouter.post('/logins/:id/code', async (req: Request, res: Response) => {
  try {
    const ctx = context(req, res);
    if (!ctx) return;
    const opened = await ctx.store.open(ctx.userId, req.params.id, ['secret']);
    if (!opened) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const { authenticator } = opened.secret!;
    if (!authenticator) {
      res.status(404).json({ error: 'This login has no authenticator', code: 'no_authenticator' });
      return;
    }
    noStore(res);
    res.json(authenticatorCode(authenticator));
  } catch (error) {
    failed(res, 'make the code', error);
  }
});
