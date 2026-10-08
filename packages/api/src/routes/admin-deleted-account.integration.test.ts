/**
 * A deleted account's mobile tokens against the REAL admin middleware and a
 * real database (task 7ee3c7be; Lumen's 72 gate on 45c06ff0). The access
 * token is still signed and unexpired after its account is gone, and Tier 1
 * took it on its claims alone: GET /workspaces then reached
 * ensurePersonalWorkspace, whose insert the users key refused, as a 500.
 *
 * Pinned here: before deletion the app's token is taken; after it, the same
 * token is refused 401 on every route shape tried, the refresh token is
 * refused too, and nothing is written for the deleted account anywhere. The
 * refusal comes from the database, not from this process's account gate,
 * so it holds the same after a restart.
 *
 * Run via: yarn test:integration:db:local src/routes/admin-deleted-account.integration.test.ts
 *
 * Every person here is invented, at example.com.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Client } from 'pg';
import { accountGate } from '../services/account-deletion/gate';
import router, { issueMobileTokens } from './admin';

let db: Client;

async function connect(): Promise<Client> {
  const url = process.env.INTEGRATION_DB_URL;
  if (!url) throw new Error('INTEGRATION_DB_URL is required: run through the managed harness');
  const { Client: PgClient } = await import('pg');
  const client = new PgClient({ connectionString: url });
  await client.connect();
  return client;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query<{ n: string }>(sql, params);
  return Number(rows[0].n);
}

type Middleware = (req: Request, res: Response, next: NextFunction) => Promise<void>;
type Handler = (req: Request, res: Response) => Promise<void>;

function middleware(): Middleware {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find((entry: any) => entry.name === 'adminAuthMiddleware');
  if (!layer) throw new Error('adminAuthMiddleware not found in router stack');
  return layer.handle;
}

function route(method: 'post', path: string): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

interface Sent {
  status: number;
  body: unknown;
  closes: Array<() => void>;
}

function request(token: string, method: string, path: string, workspaceId?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (workspaceId) headers['x-ink-workspace-id'] = workspaceId;
  return {
    method,
    path,
    headers,
    cookies: {},
    params: {},
    query: {},
    body: {},
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function response(): { res: Response; sent: Sent } {
  const sent: Sent = { status: 200, body: undefined, closes: [] };
  const res = {
    once(event: string, fn: () => void) {
      if (event === 'close') sent.closes.push(fn);
      return this;
    },
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
    set() {
      return this;
    },
    cookie() {
      return this;
    },
  };
  return { res: res as unknown as Response, sent };
}

/** One request through the real middleware: whether it reached the routes, and what it answered. */
async function through(req: Request): Promise<{ reached: boolean; sent: Sent }> {
  const { res, sent } = response();
  let reached = false;
  await middleware()(req, res, () => {
    reached = true;
  });
  for (const close of sent.closes) close();
  return { reached, sent };
}

/** Rows that name the account in every table an authenticated request could create one in. */
async function rowsNaming(userId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [table, column] of [
    ['users', 'id'],
    ['workspaces', 'user_id'],
    ['workspace_members', 'user_id'],
    ['user_identity', 'user_id'],
    ['scheduled_reminders', 'user_id'],
    ['mcp_tokens', 'user_id'],
    ['agent_identities', 'user_id'],
  ] as const) {
    out[table] = await count(`SELECT count(*) AS n FROM ${table} WHERE ${column} = $1`, [userId]);
  }
  return out;
}

beforeAll(async () => {
  db = await connect();
});

afterAll(async () => {
  await db?.end();
});

describe("a deleted account's mobile tokens", () => {
  it('are taken before the deletion, and refused 401 on every route shape after it, writing nothing', async () => {
    const run = randomUUID().slice(0, 8);
    const email = `ivo-${run}@example.com`;
    const { rows } = await db.query<{ id: string }>(
      'INSERT INTO users (email, auth_uid) VALUES ($1, gen_random_uuid()) RETURNING id',
      [email]
    );
    const userId = rows[0].id;
    const { rows: personal } = await db.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE user_id = $1 AND type = 'personal'",
      [userId]
    );
    const { rows: other } = await db.query<{ id: string }>(
      "INSERT INTO workspaces (user_id, name, slug, type) VALUES ($1, 'Choir', $2, 'team') RETURNING id",
      [userId, `choir-${run}`]
    );

    // Signed in exactly as the app is.
    const { getDataComposer } = await import('../data/composer');
    const supabase = (await getDataComposer()).getClient();
    const tokens = await issueMobileTokens(supabase as never, userId, email);

    // The control: before the deletion, the app's token is taken.
    const before = await through(request(tokens.accessToken, 'GET', '/workspaces'));
    expect(before.reached).toBe(true);

    // The deletion, through delete_account itself.
    await db.query(
      "INSERT INTO account_deletion_requests (user_id, step, started_at) VALUES ($1, 'files_removed', now())",
      [userId]
    );
    await db.query('SELECT delete_account($1)', [userId]);
    const afterDeletion = await rowsNaming(userId);
    expect(Object.values(afterDeletion).every((n) => n === 0)).toBe(true);

    // This process never closed the account's gate, as a server restarted
    // after the deletion has none: the refusal comes from the database.
    expect(accountGate.isClosed(userId)).toBe(false);

    for (const req of [
      request(tokens.accessToken, 'GET', '/workspaces'),
      request(tokens.accessToken, 'GET', '/workspaces', other[0].id),
      request(tokens.accessToken, 'GET', '/workspaces', personal[0].id),
      request(tokens.accessToken, 'POST', '/workspaces'),
    ]) {
      const replay = await through(req);
      expect(replay.reached, `${req.method} ${req.headers['x-ink-workspace-id'] ?? ''}`).toBe(
        false
      );
      expect(replay.sent.status).toBe(401);
      expect(replay.sent.body).toEqual({ error: 'Account not found' });
    }
    expect(accountGate.inFlightCount(userId)).toBe(0);

    // The app answers a 401 by refreshing; the refresh token went with the account.
    const { res, sent } = response();
    await route('post', '/auth/mobile-refresh')(
      { body: { refreshToken: tokens.refreshToken }, headers: {} } as unknown as Request,
      res
    );
    expect(sent.status).toBe(401);

    // Nothing was written for the deleted account anywhere a request could.
    expect(await rowsNaming(userId)).toEqual(afterDeletion);
  });
});
