import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';

vi.mock('../config/env', async () => ({
  env: { ...(await import('../test/fake-env')).fakeEnv },
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { fakeEnv } from '../test/fake-env';
import { requireHumanLogin } from './require-human-login';

const USER = '11111111-1111-4111-8111-111111111111';
const BASE = { type: 'pcp_admin', sub: USER, scope: 'admin', email: 'person@example.com' };

function token(extra: Record<string, unknown> = {}, expiresIn = 60): string {
  return jwt.sign({ ...BASE, ...extra }, fakeEnv.JWT_SECRET, { expiresIn });
}

function invoke(authorization: unknown, cookie = 'synthetic-refresh-cookie') {
  // Neither cookies nor caller-supplied identity can rescue a rejected bearer.
  const req = {
    headers: { authorization, 'x-ink-context': 'synthetic-context' },
    cookies: { 'pcp-admin-refresh': cookie },
    body: { humanLoginUserId: USER, approvedBy: USER },
  } as unknown as Request;
  const res = {
    locals: { humanLoginUserId: 'stale-principal' } as Record<string, unknown>,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const next = vi.fn();
  requireHumanLogin(req, res as unknown as Response, next);
  return { res, next };
}

function refused(authorization: unknown, status = 401) {
  const result = invoke(authorization);
  expect(result.next).not.toHaveBeenCalled();
  expect(result.res.status).toHaveBeenCalledWith(status);
  expect(result.res.locals).not.toHaveProperty('humanLoginUserId');
  return result;
}

describe('requireHumanLogin — credential preflight, not approval authority', () => {
  it('accepts only a verified human login and stores its user outside request input', () => {
    const { res, next } = invoke(`Bearer ${token()}`);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.locals.humanLoginUserId).toBe(USER);
  });

  it('accepts the case-insensitive HTTP bearer scheme', () => {
    expect(invoke(`bearer ${token()}`).next).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, '', 'Basic value', 'Bearer', 'Bearer ', [], {}])(
    'refuses missing or malformed authorization %j despite a refresh cookie',
    (authorization) => {
      refused(authorization);
    }
  );

  it.each([' ', '\n', '\r\n', '\t'])('refuses trailing whitespace %j', (suffix) => {
    refused(`Bearer ${token()}${suffix}`);
  });

  it('refuses invalid signatures without exposing token or cookie contents', () => {
    const bearer = jwt.sign(BASE, 'synthetic-wrong-key', { expiresIn: 60 });
    const { res } = refused(`Bearer ${bearer}`);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Human login required',
      code: 'human_login_required',
    });
  });

  it('refuses an expired token even with a refresh cookie', () => {
    refused(`Bearer ${token({}, -1)}`);
  });

  it('refuses a signed token with no expiry', () => {
    refused(`Bearer ${jwt.sign(BASE, fakeEnv.JWT_SECRET)}`);
  });

  it.each([null, '', '9999999999', false, [], {}])('refuses malformed expiry %j', (exp) => {
    // Sign the JSON bytes directly so the signer cannot pre-reject the fixture.
    const bearer = jwt.sign(JSON.stringify({ ...BASE, exp }), fakeEnv.JWT_SECRET);
    refused(`Bearer ${bearer}`);
  });

  it('refuses a valid signature whose not-before time has not arrived', () => {
    refused(`Bearer ${token({ nbf: Math.floor(Date.now() / 1000) + 60 })}`);
  });

  it('accepts an otherwise valid login whose not-before time has arrived', () => {
    expect(
      invoke(`Bearer ${token({ nbf: Math.floor(Date.now() / 1000) - 60 })}`).next
    ).toHaveBeenCalledOnce();
  });

  it.each(['mcp_access', 'browser_client', 'unknown'])('refuses token type %s', (type) => {
    refused(`Bearer ${token({ type })}`);
  });

  it.each(['', 'mcp:tools', 'admin other', null, []])('refuses scope %j', (scope) => {
    refused(`Bearer ${token({ scope })}`);
  });

  it.each(['', 'not-a-user-id', null, 17, []])('refuses subject %j', (sub) => {
    refused(`Bearer ${token({ sub })}`);
  });

  // Known and hypothetical claims: a new binding must fail closed without
  // requiring its author to update this guard's vocabulary.
  const keys = [
    'sbId',
    'identityId',
    'sbSlug',
    'agentId',
    'sessionId',
    'contactId',
    'installationId',
    'grantId',
    'clientId',
    'workspaceId',
    'futureBinding',
  ];
  for (const key of keys) {
    it.each(['bound', '', null, false, 0, [], {}])(
      `refuses present ${key} binding %j on an otherwise valid admin login`,
      (value) => {
        refused(`Bearer ${token({ [key]: value })}`, 403);
      }
    );
  }

  it('does not infer human authority from an unbound MCP token', () => {
    refused(`Bearer ${token({ type: 'mcp_access', scope: 'mcp:tools' })}`);
  });
});
