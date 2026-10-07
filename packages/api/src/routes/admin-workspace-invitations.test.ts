/**
 * Group invitations through the real admin routes, over the in-memory
 * FakePostgrest and the real WorkspacesRepository. The database function
 * accept_workspace_invitation is faked at the RPC boundary: these tests pin
 * what the routes send it and how they answer; the function's own SQL is
 * checked against a disposable Postgres separately.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  invitationAttempts,
  invitationDigest,
  normalizeInvitationCode,
} from '../services/workspace-invitations';

type Handler = (req: Request, res: Response) => Promise<void>;
type Method = 'get' | 'post' | 'patch';
/* eslint-disable @typescript-eslint/no-explicit-any */
function route(method: Method, path: string): Handler {
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const OWNER = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const OUTSIDER = '33333333-3333-4333-8333-333333333333';

async function call(
  handler: Handler,
  {
    as = OWNER,
    email = 'owner@example.test',
    params = {},
    body = {},
    selected = 'personal-ws',
  }: { as?: string; email?: string; params?: Row; body?: Row; selected?: string } = {}
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
      params,
      headers: {},
      cookies: {},
      user: { email },
      inkUserId: as,
      inkWorkspaceId: selected,
      inkWorkspaceRole: 'owner',
    } as unknown as Request,
    res as unknown as Response
  );
  return answer;
}

let group: Row;
let personal: Row;

beforeEach(() => {
  vi.stubEnv('INVITE_EMAIL_OWNERSHIP_CONFIRMED', 'true');
  db = new FakePostgrest();
  composer.repositories = {
    workspaces: new WorkspacesRepository(db as never),
  };
  invitationAttempts.reset();
  group = db.seed('workspaces', {
    user_id: OWNER,
    name: 'The Smiths',
    slug: 'the-smiths',
    type: 'team',
    metadata: { membershipMode: 'invite_only' },
    archived_at: null,
  });
  personal = db.seed('workspaces', {
    user_id: OWNER,
    name: 'Personal',
    slug: 'personal',
    type: 'personal',
    metadata: {},
    archived_at: null,
  });
  db.seed('workspace_members', { workspace_id: group.id, user_id: OWNER, role: 'owner' });
  db.seed('workspace_members', { workspace_id: personal.id, user_id: OWNER, role: 'owner' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const create = route('post', '/workspaces/:workspaceId/invitations');
const list = route('get', '/workspaces/:workspaceId/invitations');
const revoke = route('post', '/workspaces/:workspaceId/invitations/:invitationId/revoke');
const preview = route('post', '/invitations/preview');
const accept = route('post', '/invitations/accept');
const rename = route('patch', '/workspaces/:workspaceId');
const addMember = route('post', '/workspaces/:workspaceId/members');
const createWorkspace = route('post', '/workspaces');

describe('creating an invitation', () => {
  it('makes a code for the group, shows it once, and stores only its digest', async () => {
    const res = await call(create, { params: { workspaceId: group.id }, body: { kind: 'code' } });
    expect(res.status).toBe(201);
    const code = res.body.code as string;
    expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    const [stored] = db.rows('workspace_invitations');
    expect(stored).toMatchObject({
      workspace_id: group.id,
      kind: 'code',
      invitee_email: null,
      created_by: OWNER,
      max_uses: null,
      token_digest: invitationDigest(normalizeInvitationCode(code)!),
    });
    expect(JSON.stringify(stored)).not.toContain(code.replace('-', ''));
    expect(res.body.invitation).toMatchObject({ kind: 'code', email: null, maxUses: null });
    expect(JSON.stringify(res.body.invitation)).not.toContain(code);
  });

  it('takes an optional use limit for a code, and an email invitation is used once', async () => {
    await call(create, { params: { workspaceId: group.id }, body: { kind: 'code', maxUses: 5 } });
    await call(create, {
      params: { workspaceId: group.id },
      body: { kind: 'email', email: ' Friend@Example.TEST ' },
    });
    const [code, email] = db.rows('workspace_invitations');
    expect(code).toMatchObject({ kind: 'code', max_uses: 5 });
    expect(email).toMatchObject({
      kind: 'email',
      invitee_email: 'friend@example.test',
      max_uses: 1,
    });
  });

  it('refuses bad input, a personal space, and anyone who is not an owner or admin', async () => {
    const bad = [
      { kind: 'link' },
      { kind: 'email' },
      { kind: 'email', email: 'not-an-address' },
      { kind: 'code', maxUses: 0 },
      { kind: 'code', maxUses: 2.5 },
    ];
    for (const body of bad) {
      const res = await call(create, { params: { workspaceId: group.id }, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(
      (await call(create, { params: { workspaceId: personal.id }, body: { kind: 'code' } })).body
    ).toMatchObject({ code: 'personal_workspace' });

    db.seed('workspace_members', { workspace_id: group.id, user_id: FRIEND, role: 'member' });
    const member = await call(create, {
      as: FRIEND,
      params: { workspaceId: group.id },
      body: { kind: 'code' },
    });
    expect(member.status).toBe(403);
    const outsider = await call(create, {
      as: OUTSIDER,
      params: { workspaceId: group.id },
      body: { kind: 'code' },
    });
    expect(outsider.status).toBe(404);
    expect(db.rows('workspace_invitations')).toHaveLength(0);
  });
});

describe('listing and revoking', () => {
  it('lists the group’s invitations without codes, and revoking says how it stands', async () => {
    const made = await call(create, { params: { workspaceId: group.id }, body: { kind: 'code' } });
    const id = (made.body.invitation as Row).id as string;
    const listed = await call(list, { params: { workspaceId: group.id } });
    expect(listed.body.invitations).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(made.body.code as string);

    const revoked = await call(revoke, { params: { workspaceId: group.id, invitationId: id } });
    expect(revoked.body.invitation).toMatchObject({ id, status: 'revoked' });
    const firstRevokedAt = (revoked.body.invitation as Row).revokedAt;
    // Again: no change, and it says it is already revoked.
    const again = await call(revoke, { params: { workspaceId: group.id, invitationId: id } });
    expect((again.body.invitation as Row).revokedAt).toBe(firstRevokedAt);
  });

  it('never reaches another group’s invitation', async () => {
    const other = db.seed('workspaces', {
      user_id: OUTSIDER,
      name: 'Other',
      slug: 'other',
      type: 'team',
      metadata: {},
    });
    db.seed('workspace_members', { workspace_id: other.id, user_id: OUTSIDER, role: 'owner' });
    const theirs = await call(create, {
      as: OUTSIDER,
      params: { workspaceId: other.id },
      body: { kind: 'code' },
    });
    const id = (theirs.body.invitation as Row).id as string;
    const res = await call(revoke, { params: { workspaceId: group.id, invitationId: id } });
    expect(res.status).toBe(404);
    expect(db.rows('workspace_invitations')[0]!.revoked_at).toBeUndefined();
  });
});

describe('previewing a code', () => {
  async function makeCode(body: Row = { kind: 'code' }): Promise<string> {
    return (await call(create, { params: { workspaceId: group.id }, body })).body.code as string;
  }

  it('shows the group’s name for a usable code, however it is typed', async () => {
    const code = await makeCode();
    const res = await call(preview, { as: FRIEND, body: { code: code.toLowerCase() } });
    expect(res.body).toEqual({
      available: true,
      workspace: { id: group.id, name: 'The Smiths' },
      alreadyMember: false,
    });
  });

  it('says the same thing for every code it won’t honour', async () => {
    const revokedCode = await makeCode();
    db.rows('workspace_invitations')[0]!.revoked_at = '2026-10-06T20:00:00Z';
    const emailCode = await makeCode({ kind: 'email', email: 'someone@example.test' });
    const answers = await Promise.all(
      [revokedCode, emailCode, 'ZZZZZ-ZZZZZ'].map((code) =>
        call(preview, { as: FRIEND, email: 'friend@example.test', body: { code } })
      )
    );
    for (const res of answers) {
      expect(res.body).toMatchObject({ available: false, code: 'invitation_unavailable' });
      expect(res.body.workspace).toBeUndefined();
    }
    expect((await call(preview, { as: FRIEND, body: { code: 'not a code' } })).body).toMatchObject({
      code: 'invalid_code',
    });
  });

  it('shows an email invitation only to the account with that address', async () => {
    const code = await makeCode({ kind: 'email', email: 'friend@example.test' });
    const res = await call(preview, { as: FRIEND, email: 'Friend@Example.test', body: { code } });
    expect(res.body).toMatchObject({ available: true });
  });

  it('shows a join whose answer was lost as done, even on the code it used up', async () => {
    const code = await makeCode({ kind: 'code', maxUses: 1 });
    const invitation = db.rows('workspace_invitations')[0]!;
    // What a committed accept leaves behind, as accept_workspace_invitation writes it.
    const membership = db.seed('workspace_members', {
      workspace_id: group.id,
      user_id: FRIEND,
      role: 'member',
    });
    db.seed('workspace_invitation_redemptions', {
      invitation_id: invitation.id,
      user_id: FRIEND,
      membership_id: membership.id,
    });
    invitation.use_count = 1;

    expect((await call(preview, { as: FRIEND, body: { code } })).body).toEqual({
      available: true,
      workspace: { id: group.id, name: 'The Smiths' },
      alreadyMember: true,
    });
    const outsider = await call(preview, { as: OUTSIDER, body: { code } });
    expect(outsider.body).toMatchObject({ available: false, code: 'invitation_unavailable' });
    expect(outsider.body.workspace).toBeUndefined();
  });

  it('refuses an account that used the code and has since left', async () => {
    const code = await makeCode();
    db.seed('workspace_invitation_redemptions', {
      invitation_id: db.rows('workspace_invitations')[0]!.id,
      user_id: FRIEND,
      membership_id: 'gone',
    });
    const res = await call(preview, { as: FRIEND, body: { code } });
    expect(res.body).toMatchObject({ available: false, code: 'invitation_unavailable' });
  });

  it('refuses a code whose maker may no longer invite', async () => {
    const code = await makeCode();
    db.rows('workspace_members').find((m) => m.workspace_id === group.id)!.role = 'member';
    const res = await call(preview, { as: FRIEND, body: { code } });
    expect(res.body).toMatchObject({ available: false, code: 'invitation_unavailable' });
  });

  it('stops an account after twenty tries in ten minutes', async () => {
    for (let i = 0; i < 20; i++) await call(preview, { as: FRIEND, body: { code: 'ZZZZZ-ZZZZZ' } });
    const res = await call(preview, { as: FRIEND, body: { code: 'ZZZZZ-ZZZZZ' } });
    expect(res).toMatchObject({ status: 429, body: { code: 'too_many_attempts' } });
  });
});

describe('accepting', () => {
  it('asks the database function with the code’s digest and the signed-in account', async () => {
    const code = (await call(create, { params: { workspaceId: group.id }, body: { kind: 'code' } }))
      .body.code as string;
    const seen: Row[] = [];
    db.rpcHandlers.accept_workspace_invitation = (args) => {
      seen.push(args);
      return {
        data: { status: 'joined', workspaceId: group.id, alreadyMember: false },
        error: null,
      };
    };
    const res = await call(accept, {
      as: FRIEND,
      email: ' Friend@Example.test ',
      body: { code: ` ${code.toLowerCase()} ` },
    });
    expect(seen).toEqual([
      {
        p_token_digest: invitationDigest(normalizeInvitationCode(code)!),
        p_user_id: FRIEND,
        p_user_email: 'friend@example.test',
        p_email_ownership_confirmed: true,
      },
    ]);
    expect(res.body).toEqual({
      workspace: { id: group.id, name: 'The Smiths' },
      alreadyMember: false,
    });
  });

  it('answers 404 with the same words for any refusal, and 500 when the database fails', async () => {
    db.rpcHandlers.accept_workspace_invitation = () => ({
      data: { status: 'unavailable' },
      error: null,
    });
    const refused = await call(accept, { as: FRIEND, body: { code: 'ZZZZZ-ZZZZZ' } });
    expect(refused).toMatchObject({ status: 404, body: { code: 'invitation_unavailable' } });

    db.rpcHandlers.accept_workspace_invitation = () => ({
      data: null,
      error: { message: 'function accept_workspace_invitation does not exist' },
    });
    const failed = await call(accept, { as: FRIEND, body: { code: 'ZZZZZ-ZZZZZ' } });
    expect(failed.status).toBe(500);
  });

  it('never calls the function for something that cannot be a code, or past the limit', async () => {
    const handler = vi.fn();
    db.rpcHandlers.accept_workspace_invitation = handler;
    expect((await call(accept, { as: FRIEND, body: { code: '12' } })).status).toBe(400);
    for (let i = 0; i < 20; i++) await call(preview, { as: FRIEND, body: { code: 'ZZZZZ-ZZZZZ' } });
    expect((await call(accept, { as: FRIEND, body: { code: 'ZZZZZ-ZZZZZ' } })).status).toBe(429);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('email invitations need a server that confirms addresses', () => {
  it('without INVITE_EMAIL_OWNERSHIP_CONFIRMED, refuses to make, show or accept one; codes still work', async () => {
    const made = await call(create, {
      params: { workspaceId: group.id },
      body: { kind: 'email', email: 'friend@example.test' },
    });
    const code = made.body.code as string;
    vi.stubEnv('INVITE_EMAIL_OWNERSHIP_CONFIRMED', '');

    const refused = await call(create, {
      params: { workspaceId: group.id },
      body: { kind: 'email', email: 'friend@example.test' },
    });
    expect(refused).toMatchObject({ status: 409, body: { code: 'email_invites_unavailable' } });
    const shown = await call(preview, {
      as: FRIEND,
      email: 'friend@example.test',
      body: { code },
    });
    expect(shown.body).toMatchObject({ available: false });

    const seen: Row[] = [];
    db.rpcHandlers.accept_workspace_invitation = (args) => {
      seen.push(args);
      return { data: { status: 'unavailable' }, error: null };
    };
    await call(accept, { as: FRIEND, email: 'friend@example.test', body: { code } });
    expect(seen[0]).toMatchObject({ p_email_ownership_confirmed: false });

    const codeInvite = await call(create, {
      params: { workspaceId: group.id },
      body: { kind: 'code' },
    });
    expect(codeInvite.status).toBe(201);
  });
});

describe('a signed-in person outside the group', () => {
  it('previews and accepts with any of their own workspaces selected', async () => {
    const theirs = db.seed('workspaces', {
      user_id: FRIEND,
      name: 'Friend’s team',
      slug: 'friends-team',
      type: 'team',
      metadata: {},
    });
    db.seed('workspace_members', { workspace_id: theirs.id, user_id: FRIEND, role: 'owner' });
    const code = (await call(create, { params: { workspaceId: group.id }, body: { kind: 'code' } }))
      .body.code as string;
    const shown = await call(preview, {
      as: FRIEND,
      selected: theirs.id as string,
      body: { code },
    });
    expect(shown.body).toMatchObject({ available: true, workspace: { id: group.id } });
    db.rpcHandlers.accept_workspace_invitation = () => ({
      data: { status: 'joined', workspaceId: group.id, alreadyMember: false },
      error: null,
    });
    const joined = await call(accept, {
      as: FRIEND,
      selected: theirs.id as string,
      body: { code },
    });
    expect(joined.body).toMatchObject({ workspace: { id: group.id, name: 'The Smiths' } });
  });
});

describe('naming a group', () => {
  it('lets an owner or admin rename it; a member and a bad name are refused', async () => {
    const res = await call(rename, {
      params: { workspaceId: group.id },
      body: { name: '  The Smith-Joneses ' },
    });
    expect(res.body.workspace).toMatchObject({ id: group.id, name: 'The Smith-Joneses' });
    db.seed('workspace_members', { workspace_id: group.id, user_id: FRIEND, role: 'member' });
    expect(
      (
        await call(rename, {
          as: FRIEND,
          params: { workspaceId: group.id },
          body: { name: 'Mine' },
        })
      ).status
    ).toBe(403);
    expect(
      (await call(rename, { params: { workspaceId: group.id }, body: { name: '   ' } })).status
    ).toBe(400);
    expect(db.rows('workspaces').find((w) => w.id === group.id)!.name).toBe('The Smith-Joneses');
  });
});

describe('limit B: a group created invite-only takes nobody directly', () => {
  it('refuses the direct add-collaborator route for an invite-only group', async () => {
    const res = await call(addMember, {
      params: { workspaceId: group.id },
      body: { email: 'friend@example.test' },
    });
    expect(res).toMatchObject({ status: 409, body: { code: 'invite_only' } });
    expect(db.rows('workspace_members').filter((m) => m.workspace_id === group.id)).toHaveLength(1);
  });

  it('creates a group as invite-only when asked, and only a team group', async () => {
    const created: Row[] = [];
    composer.repositories = {
      workspaces: {
        create: vi.fn(async (input: Row) => {
          created.push(input);
          return { id: 'ws-new', name: input.name, slug: input.slug, type: input.type };
        }),
        addMember: vi.fn(async () => ({})),
      },
    };
    await call(createWorkspace, {
      body: { name: 'The Smiths', type: 'team', membershipMode: 'invite_only' },
    });
    await call(createWorkspace, { body: { name: 'Mine', membershipMode: 'invite_only' } });
    expect(created[0]).toMatchObject({ type: 'team', metadata: { membershipMode: 'invite_only' } });
    expect(created[1]).toMatchObject({ type: 'personal' });
    expect(created[1]!.metadata).toBeUndefined();
  });

  it('gives an invite-only group a free slug when its plain one is taken, and nothing else', async () => {
    const tried: string[] = [];
    composer.repositories = {
      workspaces: {
        create: vi.fn(async (input: Row) => {
          tried.push(input.slug as string);
          if (input.slug === 'personal') {
            throw new Error('duplicate key value violates unique constraint');
          }
          return { id: 'ws-new', name: input.name, slug: input.slug, type: input.type };
        }),
        addMember: vi.fn(async () => ({})),
      },
    };
    const group = await call(createWorkspace, {
      body: { name: 'Personal', type: 'team', membershipMode: 'invite_only' },
    });
    expect(group.status).toBe(201);
    expect(tried).toEqual(['personal', expect.stringMatching(/^personal-[0-9a-f]{6}$/)]);

    // A slug asked for, or an ordinary workspace, still says the slug is taken.
    tried.length = 0;
    const named = await call(createWorkspace, {
      body: { name: 'Personal', slug: 'personal', type: 'team', membershipMode: 'invite_only' },
    });
    const ordinary = await call(createWorkspace, { body: { name: 'Personal', type: 'team' } });
    expect([named.status, ordinary.status]).toEqual([409, 409]);
    expect(tried).toEqual(['personal', 'personal']);
  });
});
