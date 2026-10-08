/**
 * The inkling starter set through the real admin routes, over the in-memory
 * FakePostgrest and the real WorkspacesRepository (the harness of
 * admin-workspace-invitations.test.ts). A space created with
 * `starter: 'inkling'` gets the inkling values, no process, and its creator's
 * own About page; each person who joins gets their own; and the app learns
 * the person's own space from `defaultWorkspaceId` rather than guessing it.
 */

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { FakePostgrest, type Row } from '../test/fake-postgrest';
import { WorkspacesRepository } from '../data/repositories/workspaces.repository';

let db: FakePostgrest;
const composer = vi.hoisted(() => ({ repositories: {} as Record<string, unknown> }));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => db) }));
vi.mock('../auth/ink-tokens', () => ({
  signInkAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  exchangeRefreshToken: vi.fn(),
  verifyInkAccessToken: vi.fn(),
}));
vi.mock('../data/composer', () => ({
  getDataComposer: vi.fn(async () => ({
    repositories: composer.repositories,
    getClient: () => db,
  })),
}));
vi.mock('../services/authorization', () => ({ getAuthorizationService: vi.fn(() => ({})) }));
vi.mock('../services/oauth', () => ({ getOAuthService: vi.fn(() => ({})) }));
vi.mock('../mcp/tools/inbox-handlers', () => ({ handleSendToInbox: vi.fn() }));
vi.mock('../mcp/tools/thread-handlers', () => ({ getParticipants: vi.fn() }));
vi.mock('../config/env', async () => ({
  env: {
    ...(await import('../test/fake-env')).fakeEnv,
    NODE_ENV: 'development',
    MCP_HTTP_PORT: 3001,
  },
  isDevelopment: () => true,
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/request-context', () => ({
  runWithRequestContext: (_context: Record<string, unknown>, fn: () => void) => fn(),
}));

import router from './admin';
import { invitationAttempts } from '../services/workspace-invitations';
import {
  ABOUT_YOU_TEMPLATE,
  INKLING_SPACE_VALUES,
  INKLING_STARTER,
} from '../services/inklings/starter-space';

type Handler = (req: Request, res: Response) => Promise<void>;
/* eslint-disable @typescript-eslint/no-explicit-any */
function route(method: 'get' | 'post', path: string): Handler {
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const OWNER = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';

async function call(
  handler: Handler,
  { as = OWNER, body = {}, selected }: { as?: string; body?: Row; selected?: string } = {}
): Promise<{ status: number; body: Row }> {
  const answer = { status: 200, body: {} as Row };
  const res = {
    status(n: number) {
      answer.status = n;
      return res;
    },
    json(r: Row) {
      answer.body = r;
      return res;
    },
  };
  await handler(
    {
      body,
      params: {},
      headers: {},
      cookies: {},
      user: { email: 'owner@example.test' },
      inkUserId: as,
      inkWorkspaceId: selected ?? personal.id,
      inkWorkspaceRole: 'owner',
    } as unknown as Request,
    res as unknown as Response
  );
  return answer;
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex');
const pagesIn = (workspaceId: unknown) =>
  db.rows('user_identity').filter((row) => row.workspace_id === workspaceId);

let personal: Row;

beforeEach(() => {
  db = new FakePostgrest();
  db.unique.user_identity = [
    {
      name: 'user_identity_user_workspace_key',
      key: (row) => `${String(row.user_id)}|${String(row.workspace_id)}`,
    },
  ];
  const workspaces = new WorkspacesRepository(db as never);
  // addMember upserts, which the fake does not model; record the row as the
  // invitations suite does.
  workspaces.addMember = (async (workspaceId: string, userId: string, role: string) =>
    db.seed('workspace_members', {
      workspace_id: workspaceId,
      user_id: userId,
      role,
    })) as unknown as typeof workspaces.addMember;
  composer.repositories = { workspaces };
  invitationAttempts.reset();
  personal = db.seed('workspaces', {
    user_id: OWNER,
    name: 'Personal',
    slug: 'personal',
    type: 'personal',
    metadata: {},
    archived_at: null,
  });
  db.seed('workspace_members', { workspace_id: personal.id, user_id: OWNER, role: 'owner' });
});

const createWorkspace = route('post', '/workspaces');
const listWorkspaces = route('get', '/workspaces');
const accept = route('post', '/invitations/accept');

describe('the starter texts', () => {
  it('are design v3 as written to Conor’s inkling space on Oct 7', () => {
    // md5 of the values and the About page stored on that space, read back
    // from the database after the write (thread:inkling-starter-space).
    expect(md5(INKLING_SPACE_VALUES)).toBe('bcd9725ebe0c9c26400ac8cb08d40d0b');
    expect(md5(ABOUT_YOU_TEMPLATE)).toBe('6994d9d45f65793c68532e6cb2386517');
  });
});

describe('creating a space', () => {
  it('as an inkling space: the inkling values, no process, and the creator’s own About page', async () => {
    const res = await call(createWorkspace, {
      body: { name: 'Family', type: 'team', membershipMode: 'invite_only', starter: 'inkling' },
    });

    expect(res.status).toBe(201);
    const space = db.rows('workspaces').find((row) => row.id === res.body.workspace.id)!;
    expect(space.shared_values).toBe(INKLING_SPACE_VALUES);
    expect(space.process ?? null).toBeNull();
    expect(space.metadata).toEqual({ membershipMode: 'invite_only', starter: INKLING_STARTER });
    expect(pagesIn(space.id)).toEqual([
      expect.objectContaining({ user_id: OWNER, user_profile_md: ABOUT_YOU_TEMPLATE }),
    ]);
  });

  it('any other way: exactly as before, with no values, no page and no starter mark', async () => {
    const res = await call(createWorkspace, {
      body: { name: 'SB Lab', type: 'team', membershipMode: 'invite_only' },
    });

    const space = db.rows('workspaces').find((row) => row.id === res.body.workspace.id)!;
    expect(space.shared_values ?? null).toBeNull();
    expect(space.metadata).toEqual({ membershipMode: 'invite_only' });
    expect(pagesIn(space.id)).toEqual([]);
  });

  it('ignores a starter it does not know', async () => {
    const res = await call(createWorkspace, {
      body: { name: 'Odd', type: 'team', membershipMode: 'invite_only', starter: 'team' },
    });
    const space = db.rows('workspaces').find((row) => row.id === res.body.workspace.id)!;
    expect(space.shared_values ?? null).toBeNull();
    expect(pagesIn(space.id)).toEqual([]);
  });
});

describe('joining', () => {
  function seedSpace(metadata: Row): Row {
    const space = db.seed('workspaces', {
      user_id: OWNER,
      name: 'Friends',
      slug: 'friends',
      type: 'team',
      metadata,
      archived_at: null,
    });
    db.seed('workspace_members', { workspace_id: space.id, user_id: OWNER, role: 'owner' });
    db.seed('user_identity', {
      user_id: OWNER,
      workspace_id: space.id,
      user_profile_md: 'OWNER-PAGE',
    });
    db.rpcHandlers.accept_workspace_invitation = (args) => ({
      data: { status: 'joined', workspaceId: space.id, alreadyMember: false, args },
      error: null,
    });
    return space;
  }

  it('an inkling space gives the person their own page, and leaves everyone else’s alone', async () => {
    const space = seedSpace({ membershipMode: 'invite_only', starter: INKLING_STARTER });

    const res = await call(accept, { as: FRIEND, body: { code: 'ABCDE-FGHJK' } });

    expect(res.status).toBe(200);
    expect(res.body.workspace).toEqual({ id: space.id, name: 'Friends' });
    expect(pagesIn(space.id)).toEqual([
      expect.objectContaining({ user_id: OWNER, user_profile_md: 'OWNER-PAGE' }),
      expect.objectContaining({ user_id: FRIEND, user_profile_md: ABOUT_YOU_TEMPLATE }),
    ]);
  });

  it('never replaces a page the person already has, on a retried accept', async () => {
    const space = seedSpace({ membershipMode: 'invite_only', starter: INKLING_STARTER });
    await call(accept, { as: FRIEND, body: { code: 'ABCDE-FGHJK' } });
    pagesIn(space.id).find((row) => row.user_id === FRIEND)!.user_profile_md = 'FRIEND-EDITED';

    const retried = await call(accept, { as: FRIEND, body: { code: 'ABCDE-FGHJK' } });

    expect(retried.status).toBe(200);
    expect(pagesIn(space.id).filter((row) => row.user_id === FRIEND)).toEqual([
      expect.objectContaining({ user_profile_md: 'FRIEND-EDITED' }),
    ]);
  });

  it('any other group writes no page', async () => {
    const space = seedSpace({ membershipMode: 'invite_only' });
    await call(accept, { as: FRIEND, body: { code: 'ABCDE-FGHJK' } });
    expect(pagesIn(space.id).map((row) => row.user_id)).toEqual([OWNER]);
  });
});

describe('listing spaces', () => {
  it('names the person’s own space even while the request is scoped to another', async () => {
    const created = await call(createWorkspace, {
      body: { name: 'Family', type: 'team', membershipMode: 'invite_only', starter: 'inkling' },
    });
    const family = created.body.workspace.id as string;

    const res = await call(listWorkspaces, { selected: family });

    expect(res.body.currentWorkspaceId).toBe(family);
    expect(res.body.defaultWorkspaceId).toBe(personal.id);
  });
});
