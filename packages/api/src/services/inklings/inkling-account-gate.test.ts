/**
 * The inkling account gate, alone and on the real path a Google tool takes:
 * the registration wrapper, the Gmail and Calendar handlers, the user
 * resolver, the Google services and OAuthService.getValidAccessToken. The
 * database and Google are fakes: no account is read, no provider is reached,
 * and no mail is read or sent. The end-to-end harness follows Lumen's probe
 * (debug:inkling-google-tools).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failOn: null as string | null,
  reads: [] as Array<{ table: string; filters: Array<[string, string, unknown]> }>,
  provider: vi.fn(),
  findById: vi.fn(),
}));

/** A query builder over fake.tables that records every read and its filters. */
function fakeClient() {
  return {
    from(table: string) {
      const read = { table, filters: [] as Array<[string, string, unknown]> };
      fake.reads.push(read);
      const rows = () => {
        if (fake.failOn === table) return { data: null, error: { message: 'connection reset' } };
        const all = fake.tables[table] ?? [];
        const kept = all.filter((row) =>
          read.filters.every(([op, column, value]) =>
            op === 'in'
              ? (value as unknown[]).includes(row[column])
              : op === 'is'
                ? row[column] === value
                : row[column] === value
          )
        );
        return { data: kept, error: null };
      };
      const builder: Record<string, unknown> = {
        then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
          Promise.resolve(rows()).then(resolve, reject),
        maybeSingle: async () => {
          const result = rows();
          return { data: (result.data as Row[] | null)?.[0] ?? null, error: result.error };
        },
      };
      for (const op of ['eq', 'in', 'is']) {
        builder[op] = (column: string, value: unknown) => {
          read.filters.push([op, column, value]);
          return builder;
        };
      }
      for (const passThrough of ['select', 'order', 'limit']) {
        builder[passThrough] = () => builder;
      }
      return builder;
    },
  };
}

vi.mock('../../config/env', async () => ({
  env: { ...(await import('../../test/fake-env')).fakeEnv, GOOGLE_CREDENTIAL_SOURCES: 'cloud' },
}));
vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeClient() }));
vi.mock('../google-desktop-credentials', () => ({
  getDesktopGoogleCredentialStore: () =>
    new Proxy(
      {},
      {
        get: () => {
          throw new Error('Desktop credentials are outside this test');
        },
      }
    ),
}));
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        constructor() {
          fake.provider();
          throw new Error('Google is outside this test');
        }
      },
    },
    gmail: () => {
      fake.provider();
      throw new Error('Google is outside this test');
    },
    calendar: () => {
      fake.provider();
      throw new Error('Google is outside this test');
    },
  },
}));

import { registerAllTools } from '../../mcp/tools/index';
import { runWithRequestContext, tokenIdentityContext } from '../../utils/request-context';
import { currentToolName, runInToolCall } from '../../utils/tool-call-context';
import {
  accountGateCaller,
  assertAccountTokenAllowed,
  InklingAccountRefusedError,
} from './inkling-account-gate';

const OWNER = '00000000-0000-4000-8000-000000000001';
const INKLING = '00000000-0000-4000-8000-000000000002';
const ORDINARY_SB = '00000000-0000-4000-8000-000000000003';
const WORKSPACE = '00000000-0000-4000-8000-000000000004';
const OTHER_WORKSPACE = '00000000-0000-4000-8000-000000000005';

const identities = (): Row[] => [
  {
    id: INKLING,
    agent_id: 'pip',
    user_id: OWNER,
    workspace_id: WORKSPACE,
    metadata: { client: 'inkling-mobile', ownerTest: true },
  },
  { id: ORDINARY_SB, agent_id: 'myra', user_id: OWNER, workspace_id: WORKSPACE, metadata: {} },
  {
    id: '00000000-0000-4000-8000-000000000006',
    agent_id: 'myra',
    user_id: OWNER,
    workspace_id: OTHER_WORKSPACE,
    metadata: { client: 'inkling-mobile' },
  },
];

const supabase = fakeClient() as never;
const none = new Set<string>();

beforeEach(() => {
  fake.tables = { agent_identities: identities(), connected_accounts: [] };
  fake.failOn = null;
  fake.reads.length = 0;
  vi.clearAllMocks();
  fake.findById.mockResolvedValue({ id: OWNER, email: 'owner@example.test' });
  delete process.env.INK_INKLING_ACCOUNT_TOOLS;
});

describe('assertAccountTokenAllowed', () => {
  const gate = (
    caller: Parameters<typeof accountGateCaller>[0],
    toolName?: string,
    allowlist = none
  ) =>
    assertAccountTokenAllowed(supabase, 'google', OWNER, {
      caller: accountGateCaller(caller),
      toolName,
      allowlist,
    });

  it('refuses an inkling the token minted for it names, by UUID alone', async () => {
    await expect(
      gate({ ...tokenIdentityContext({ sbId: INKLING }), workspaceId: WORKSPACE }, 'list_emails')
    ).rejects.toThrow(
      "list_emails can't use its owner's google account in an inkling's turn: it is not turned on for inklings on this server."
    );
  });

  it('refuses an inkling the context names from its session, with no token identity', async () => {
    await expect(gate({ sbId: INKLING, workspaceId: WORKSPACE }, 'list_emails')).rejects.toThrow(
      InklingAccountRefusedError
    );
  });

  it('refuses an inkling known only by slug, in its workspace', async () => {
    await expect(
      gate({ ...tokenIdentityContext({ sbSlug: 'pip' }), workspaceId: WORKSPACE }, 'list_emails')
    ).rejects.toThrow(InklingAccountRefusedError);
  });

  it('refuses a slug-only inkling token even beside a context naming another SB by UUID', async () => {
    await expect(
      gate(
        { ...tokenIdentityContext({ sbSlug: 'pip' }), sbId: ORDINARY_SB, workspaceId: WORKSPACE },
        'list_emails'
      )
    ).rejects.toThrow(InklingAccountRefusedError);
  });

  it('lets an inkling through for a tool named on the allowlist, and only that tool', async () => {
    const caller = { ...tokenIdentityContext({ sbId: INKLING }), workspaceId: WORKSPACE };
    const allowlist = new Set(['list_email_labels']);
    await expect(gate(caller, 'list_email_labels', allowlist)).resolves.toBeUndefined();
    await expect(gate(caller, 'send_email', allowlist)).rejects.toThrow(InklingAccountRefusedError);
  });

  it('refuses an inkling outside any tool call, even with an allowlist', async () => {
    await expect(
      gate({ ...tokenIdentityContext({ sbId: INKLING }) }, undefined, new Set(['list_emails']))
    ).rejects.toThrow("This call can't use its owner's google account");
  });

  it('lets an ordinary SB through, after reading who it is', async () => {
    await expect(
      gate(
        { ...tokenIdentityContext({ sbId: ORDINARY_SB, sbSlug: 'myra' }), workspaceId: WORKSPACE },
        'list_emails'
      )
    ).resolves.toBeUndefined();
    expect(fake.reads.map((read) => read.table)).toEqual(['agent_identities', 'agent_identities']);
  });

  it("reads a slug in the request's workspace, so a same-named inkling elsewhere doesn't count", async () => {
    // OTHER_WORKSPACE holds an inkling also called "myra".
    await expect(
      gate({ ...tokenIdentityContext({ sbSlug: 'myra' }), workspaceId: WORKSPACE }, 'list_emails')
    ).resolves.toBeUndefined();
    expect(fake.reads[0].filters).toContainEqual(['eq', 'workspace_id', WORKSPACE]);
  });

  it('does not gate a person (no SB in the context), and reads nothing', async () => {
    await expect(
      gate({ userId: OWNER, workspaceId: WORKSPACE }, 'list_emails')
    ).resolves.toBeUndefined();
    expect(fake.reads).toEqual([]);
  });

  it('refuses when the calling SB cannot be read', async () => {
    fake.failOn = 'agent_identities';
    await expect(
      gate({ ...tokenIdentityContext({ sbId: ORDINARY_SB }) }, 'list_emails')
    ).rejects.toThrow('Could not read the calling SB to check whether it is an inkling');
  });
});

describe('a Google tool from an inkling turn, end to end', () => {
  class FakeMcpServer {
    handlers = new Map<
      string,
      (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
    >();
    registerTool(name: string, _config: unknown, handler: never) {
      this.handlers.set(name, handler);
    }
  }

  function registered() {
    const server = new FakeMcpServer();
    const dataComposer = {
      getClient: () => fakeClient(),
      repositories: { users: { findById: fake.findById } },
    };
    registerAllTools(server as never, dataComposer as never, {
      includeInternalLifecycleTools: true,
    });
    return server;
  }

  const inklingTurn = {
    userId: OWNER,
    email: 'owner@example.test',
    workspaceId: WORKSPACE,
    sbId: INKLING,
    sbSlug: 'pip',
    ...tokenIdentityContext({ sbId: INKLING, sbSlug: 'pip' }),
  };

  async function call(server: FakeMcpServer, tool: string, context: object) {
    const result = await runWithRequestContext({ ...context, timestamp: new Date() }, () =>
      server.handlers.get(tool)!({})
    );
    return JSON.parse(result.content[0].text) as { success: boolean; error?: string };
  }

  const accountReads = () => fake.reads.filter((read) => read.table === 'connected_accounts');

  it.each(['list_email_labels', 'list_calendars'])(
    'refuses %s before any account is read',
    async (tool) => {
      const result = await call(registered(), tool, inklingTurn);
      expect(result.success).toBe(false);
      expect(result.error).toContain(
        `${tool} can't use its owner's google account in an inkling's turn`
      );
      expect(accountReads()).toEqual([]);
      expect(fake.provider).not.toHaveBeenCalled();
    }
  );

  it('reaches the account lookup once the tool is turned on for inklings', async () => {
    process.env.INK_INKLING_ACCOUNT_TOOLS = 'list_email_labels';
    const result = await call(registered(), 'list_email_labels', inklingTurn);
    expect(result).toMatchObject({ success: false, error: 'No active google account found' });
    expect(accountReads()).toHaveLength(1);
  });

  it('still refuses a tool the allowlist does not name', async () => {
    process.env.INK_INKLING_ACCOUNT_TOOLS = 'list_calendars';
    const result = await call(registered(), 'list_email_labels', inklingTurn);
    expect(result.error).toContain("can't use its owner's google account");
    expect(accountReads()).toEqual([]);
  });

  it('leaves an ordinary SB where it was: at the account lookup', async () => {
    const result = await call(registered(), 'list_email_labels', {
      userId: OWNER,
      email: 'owner@example.test',
      workspaceId: WORKSPACE,
      ...tokenIdentityContext({ sbId: ORDINARY_SB, sbSlug: 'myra' }),
    });
    expect(result).toMatchObject({ success: false, error: 'No active google account found' });
    expect(accountReads()).toHaveLength(1);
  });

  it('runs every registered handler inside its own tool name', async () => {
    const server = registered();
    // A tool whose name the allowlist carries passes; the same call made
    // under a different tool's name would not, so the name must be the
    // registration's own.
    process.env.INK_INKLING_ACCOUNT_TOOLS = 'list_calendars';
    const result = await call(server, 'list_calendars', inklingTurn);
    expect(result.error).not.toContain("can't use its owner's google account");
    expect(accountReads()).toHaveLength(1);
  });

  it('names the tool for code below the handler, and nothing outside a call', () => {
    expect(runInToolCall('list_emails', () => currentToolName())).toBe('list_emails');
    expect(currentToolName()).toBeUndefined();
  });
});
