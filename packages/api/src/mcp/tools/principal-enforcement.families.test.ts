/**
 * One handler per tool family, called as an authenticated principal naming
 * another account (security G0.1).
 *
 * Every family resolves its caller through resolveUser, so the refusal comes
 * from one place; these cases pin that each family still goes through it,
 * and that none reads the other account first. The data composer refuses
 * every access except the principal's own user row, so a handler that got
 * past resolution fails loudly instead of returning someone's data.
 *
 * Invented users and ids; no database, token or request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import type { DataComposer } from '../../data/composer';
import { clearSessionContext, runWithRequestContext } from '../../utils/request-context';
import { resetSharedBreakerForTests } from '../../utils/supabase-retry';

import { handleSearchLinks } from './link-handlers';
import { handleListProjects } from './context-handlers';
import { handleListThreadKeyTypes } from './thread-key-handlers';
import { handleListTasks } from './task-handlers';
import { handleGetTaskGraph } from './task-graph-handlers';
import { handleGetStrategyStatus } from './strategy-handlers';
import { handleBootstrap, handleRecall } from './memory-handlers';
import { handleDeleteSkill } from './skill-management-handlers';
import { registerMiniAppRecordTools } from './mini-app-records';
import { handleGetUserPermissions } from './permissions';
import { handleListIdentities } from './identity-handlers';
import { handleGetUserIdentity } from './user-identity-handlers';
import { handleGetTeamConstitution } from './team-constitution-handlers';
import { handleListReminders } from './reminder-handlers';
import { handleGetTimezone } from './user-settings-handlers';
import { handleListArtifacts } from './artifact-handlers';
import { handleGetInbox, handleSendToInbox } from './inbox-handlers';
import { handleListThreads } from './thread-handlers';
import { handleGetActivity } from './activity-stream-handlers';
import { handleListStudios } from './studio-handlers';
import { handleListWorkspaces } from './workspace-handlers';
import { handleCreateKindleToken } from './kindle-handlers';
import { handleGetIntegrationHealth } from './integration-health-handlers';
import { handleListCalendars } from '../../stories/google-calendar/handlers';
import { handleListEmails } from '../../stories/gmail/handlers';
import { handleGetSpreadsheet } from '../../stories/google-sheets/handlers';
import { handleGetDocument } from '../../stories/google-docs/handlers';
import { handleListDriveFiles } from '../../stories/google-drive/handlers';

const ALPHA = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'alpha@example.com',
  phone_number: '+15555550101',
  telegram_id: 100200300,
  whatsapp_id: null,
  discord_id: null,
  slack_id: null,
};
const BETA = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'beta@example.com',
  phone_number: '+15555550102',
  telegram_id: 100200301,
  whatsapp_id: null,
  discord_id: null,
  slack_id: null,
};
const USERS = [ALPHA, BETA];
const SOME_UUID = '44444444-4444-4444-8444-444444444444';
const REFUSAL = 'does not match the authenticated user';

/**
 * Anything reached through this throws when called: it stands for data the
 * handler must not touch before its caller is resolved.
 */
function untouched(path: string): unknown {
  return new Proxy(function () {}, {
    get: (_target, prop) => (prop === 'then' ? undefined : untouched(`${path}.${String(prop)}`)),
    apply: () => {
      throw new Error(`unexpected data access before user resolution: ${path}`);
    },
  });
}

function makeComposer() {
  const users = {
    findById: vi.fn(async (id: string) => USERS.find((u) => u.id === id) ?? null),
    findByEmail: vi.fn(async (email: string) => USERS.find((u) => u.email === email) ?? null),
    findByPhoneNumber: vi.fn(
      async (phone: string) => USERS.find((u) => u.phone_number === phone) ?? null
    ),
    findByPlatformId: vi.fn(async (_platform: string, id: string | number) => {
      return USERS.find((u) => u.telegram_id === Number(id)) ?? null;
    }),
  };
  const repositories = new Proxy({ users } as Record<string, unknown>, {
    get: (target, prop) =>
      prop in target ? target[prop as string] : untouched(`repositories.${String(prop)}`),
  });
  const composer = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => {
      if (prop === 'repositories') return repositories;
      if (prop === 'getClient') return () => untouched('client');
      if (prop === 'then') return undefined;
      return untouched(`composer.${String(prop)}`);
    },
  });
  return { users, dc: composer as unknown as DataComposer };
}

/** Run a handler as ALPHA and report how it ended, thrown or returned. */
async function asAlpha(fn: () => Promise<unknown>): Promise<string> {
  try {
    const result = (await runWithRequestContext({ userId: ALPHA.id, email: ALPHA.email }, fn)) as
      | { content?: Array<{ text?: string }> }
      | undefined;
    return `returned: ${result?.content?.[0]?.text ?? JSON.stringify(result)}`;
  } catch (error) {
    return `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** The mini-app record tools are closures registered on a server, not exports. */
function miniAppRecordHandler(name: string, dc: DataComposer) {
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const server = {
    registerTool: (
      toolName: string,
      _config: unknown,
      handler: (args: unknown) => Promise<unknown>
    ) => handlers.set(toolName, handler),
  } as unknown as McpServer;
  registerMiniAppRecordTools(server, dc);
  const handler = handlers.get(name);
  if (!handler) throw new Error(`mini-app record tool not registered: ${name}`);
  return handler;
}

type Family = [
  family: string,
  call: (dc: DataComposer, who: Record<string, unknown>) => Promise<unknown>,
];

const FAMILIES: Family[] = [
  ['links', (dc, who) => handleSearchLinks({ ...who }, dc)],
  ['projects', (dc, who) => handleListProjects({ ...who }, dc)],
  ['thread key types', (dc, who) => handleListThreadKeyTypes({ ...who }, dc)],
  ['tasks', (dc, who) => handleListTasks({ ...who }, dc)],
  ['task graphs', (dc, who) => handleGetTaskGraph({ ...who, taskGroupId: SOME_UUID }, dc)],
  ['strategies', (dc, who) => handleGetStrategyStatus({ ...who, groupId: SOME_UUID }, dc)],
  ['memory', (dc, who) => handleRecall({ ...who, query: 'synthetic' }, dc)],
  ['bootstrap', (dc, who) => handleBootstrap({ ...who }, dc)],
  ['skill management', (dc, who) => handleDeleteSkill({ ...who, name: 'synthetic-skill' }, dc)],
  [
    'mini-app records',
    (dc, who) =>
      miniAppRecordHandler('query_mini_app_records', dc)({ ...who, appName: 'synthetic' }),
  ],
  ['permissions', (dc, who) => handleGetUserPermissions({ ...who }, dc)],
  ['identities', (dc, who) => handleListIdentities({ ...who }, dc)],
  ['user identity', (dc, who) => handleGetUserIdentity({ ...who }, dc)],
  ['team constitution', (dc, who) => handleGetTeamConstitution({ ...who }, dc)],
  ['reminders', (dc, who) => handleListReminders({ ...who }, dc)],
  ['user settings', (dc, who) => handleGetTimezone({ ...who }, dc)],
  ['artifacts', (dc, who) => handleListArtifacts({ ...who }, dc)],
  ['inbox read', (dc, who) => handleGetInbox({ ...who, sbSlug: 'synthetic-alpha' }, dc)],
  [
    'inbox send',
    (dc, who) =>
      handleSendToInbox({ ...who, recipientSlug: 'synthetic-beta', content: 'synthetic' }, dc),
  ],
  ['threads', (dc, who) => handleListThreads({ ...who, sbSlug: 'synthetic-alpha' }, dc)],
  ['activity stream', (dc, who) => handleGetActivity({ ...who }, dc)],
  ['studios', (dc, who) => handleListStudios({ ...who }, dc)],
  ['workspaces', (dc, who) => handleListWorkspaces({ ...who }, dc)],
  ['kindle', (dc, who) => handleCreateKindleToken({ ...who }, dc)],
  ['integration health', (dc, who) => handleGetIntegrationHealth({ ...who }, dc)],
  ['google calendar', (dc, who) => handleListCalendars({ ...who }, dc)],
  ['gmail', (dc, who) => handleListEmails({ ...who }, dc)],
  ['google sheets', (dc, who) => handleGetSpreadsheet({ ...who, spreadsheetId: 'synthetic' }, dc)],
  ['google docs', (dc, who) => handleGetDocument({ ...who, documentId: 'synthetic' }, dc)],
  ['google drive', (dc, who) => handleListDriveFiles({ ...who }, dc)],
];

beforeEach(() => {
  resetSharedBreakerForTests();
  clearSessionContext();
});

describe('every tool family refuses another account named by userId', () => {
  it.each(FAMILIES)('%s', async (_family, call) => {
    const { users, dc } = makeComposer();
    const outcome = await asAlpha(() => call(dc, { userId: BETA.id }));
    expect(outcome).toContain(REFUSAL);
    expect(users.findById).not.toHaveBeenCalledWith(BETA.id);
  });
});

describe('every tool family refuses another account named by email', () => {
  it.each(FAMILIES)('%s', async (_family, call) => {
    const { users, dc } = makeComposer();
    const outcome = await asAlpha(() => call(dc, { email: BETA.email }));
    expect(outcome).toContain(REFUSAL);
    expect(users.findByEmail).not.toHaveBeenCalled();
  });
});

describe('the activity stream keeps its two platform fields apart', () => {
  it('refuses another account named by userPlatform + platformId', async () => {
    const { users, dc } = makeComposer();
    const outcome = await asAlpha(() =>
      handleGetActivity({ userPlatform: 'telegram', platformId: String(BETA.telegram_id) }, dc)
    );
    expect(outcome).toContain(REFUSAL);
    expect(users.findByPlatformId).not.toHaveBeenCalled();
  });

  it('does not treat the activity platform filter as an identifier', async () => {
    const { dc } = makeComposer();
    const outcome = await asAlpha(() => handleGetActivity({ platform: 'telegram' }, dc));
    // Resolution succeeds as the principal; the handler then reaches the
    // (refusing) data layer, which is as far as this composer lets it go.
    expect(outcome).not.toContain(REFUSAL);
    expect(outcome).toContain('unexpected data access');
  });
});
