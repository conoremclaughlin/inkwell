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

/**
 * A query builder over fake.tables that records every read and its filters.
 * An update applies to the rows its filters keep and bumps their version, as
 * the archive trigger does; an insert appends.
 */
function fakeClient() {
  return {
    from(table: string) {
      const read = { table, filters: [] as Array<[string, string, unknown]> };
      fake.reads.push(read);
      let updateFields: Row | undefined;
      let inserted: Row | undefined;
      const rows = () => {
        if (fake.failOn === table) return { data: null, error: { message: 'connection reset' } };
        if (inserted) {
          (fake.tables[table] ??= []).push(inserted);
          return { data: [inserted], error: null };
        }
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
        if (updateFields) {
          for (const row of kept) {
            Object.assign(row, updateFields, { version: Number(row.version ?? 1) + 1 });
          }
        }
        return { data: kept, error: null };
      };
      const builder: Record<string, unknown> = {
        then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
          Promise.resolve(rows()).then(resolve, reject),
        update: (fields: Row) => {
          updateFields = fields;
          return builder;
        },
        insert: (fields: Row) => {
          inserted = { id: '00000000-0000-4000-8000-0000000000aa', version: 1, ...fields };
          return builder;
        },
        single: async () => {
          const result = rows();
          return { data: (result.data as Row[] | null)?.[0] ?? null, error: result.error };
        },
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

import { applyProfile } from '../../../../cli/src/repl/tool-profiles';
import { ToolPolicyState } from '../../../../cli/src/repl/tool-policy';
import { signRunnerAccessToken } from '../../auth/ink-tokens';
import { executionTierFor } from '../../config/execution-tier';
import { InkAuthProvider } from '../../mcp/auth/ink-auth-provider';
import { registerAllTools } from '../../mcp/tools/index';
import { runWithRequestContext, tokenIdentityContext } from '../../utils/request-context';
import { currentToolName, runInToolCall } from '../../utils/tool-call-context';
import { resolveWorkspaceContextForRequest } from '../../utils/workspace-scope';
import {
  accountGateCaller,
  assertAccountTokenAllowed,
  INKLING_CONSENTED_ACCOUNT_TOOLS,
  InklingAccountRefusedError,
  SPACE_BUSY_TIMES_TOOL,
  SPACE_EVENT_TOOL,
} from './inkling-account-gate';
import { INKLING_CLIENT } from './inkling-client';
import { classifyIdentityById, inklingTurnRefusal } from './inkling-turn-gate';

const OWNER = '00000000-0000-4000-8000-000000000001';
const INKLING = '00000000-0000-4000-8000-000000000002';
const ORDINARY_SB = '00000000-0000-4000-8000-000000000003';
const WORKSPACE = '00000000-0000-4000-8000-000000000004';
const OTHER_WORKSPACE = '00000000-0000-4000-8000-000000000005';
const INKLING_METADATA = { client: 'inkling-mobile', ownerTest: true };

// A real inkling's slug is `kindle-<token id>`; "pip" stands in for one.
const identities = (): Row[] => [
  {
    id: INKLING,
    version: 2,
    name: 'Pip',
    role: 'Inkling',
    agent_id: 'pip',
    user_id: OWNER,
    workspace_id: WORKSPACE,
    metadata: { ...INKLING_METADATA },
  },
  {
    id: ORDINARY_SB,
    version: 1,
    name: 'Myra',
    role: 'Messenger',
    agent_id: 'myra',
    user_id: OWNER,
    workspace_id: WORKSPACE,
    metadata: {},
  },
];

/** An ordinary SB in another workspace, under the inkling's own slug. */
const ordinaryTwin = (): Row => ({
  id: '00000000-0000-4000-8000-000000000006',
  agent_id: 'pip',
  user_id: OWNER,
  workspace_id: OTHER_WORKSPACE,
  metadata: {},
});

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

  it('admits get_space_busy_times and create_space_event with nothing turned on, and no other tool', async () => {
    const caller = { ...tokenIdentityContext({ sbId: INKLING }), workspaceId: WORKSPACE };
    expect([...INKLING_CONSENTED_ACCOUNT_TOOLS]).toEqual([SPACE_BUSY_TIMES_TOOL, SPACE_EVENT_TOOL]);
    expect(SPACE_BUSY_TIMES_TOOL).toBe('get_space_busy_times');
    expect(SPACE_EVENT_TOOL).toBe('create_space_event');
    await expect(gate(caller, SPACE_BUSY_TIMES_TOOL)).resolves.toBeUndefined();
    await expect(gate(caller, SPACE_EVENT_TOOL)).resolves.toBeUndefined();
    for (const tool of [
      'list_calendars',
      'list_calendar_events',
      'get_calendar_event',
      'create_calendar_event',
      'update_calendar_event',
    ]) {
      await expect(gate(caller, tool)).rejects.toThrow(InklingAccountRefusedError);
    }
    // A name only like it is not it.
    await expect(gate(caller, 'get_space_busy_times_all')).rejects.toThrow(
      InklingAccountRefusedError
    );
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

  it.each([
    ['holds no row under its slug', () => {}],
    [
      'holds an ordinary SB under its slug',
      () => fake.tables.agent_identities.push(ordinaryTwin()),
    ],
  ])(
    'refuses a slug-only inkling token whose request names a workspace that %s',
    async (_case, arrange) => {
      arrange();
      await expect(
        gate(
          { ...tokenIdentityContext({ sbSlug: 'pip' }), workspaceId: OTHER_WORKSPACE },
          'list_emails'
        )
      ).rejects.toThrow(InklingAccountRefusedError);
      // The slug is read among all the owner's identities, never in one workspace.
      const slugRead = fake.reads.find((read) =>
        read.filters.some(([, column]) => column === 'agent_id')
      )!;
      expect(slugRead.filters).toEqual([
        ['eq', 'user_id', OWNER],
        ['in', 'agent_id', ['pip']],
      ]);
    }
  );

  describe('an SB the request names that no row answers to is refused like an inkling (Lumen, PR #793)', () => {
    const GONE = '00000000-0000-4000-8000-0000000000dd';

    it('refuses a token whose identity row is gone', async () => {
      await expect(
        gate({ ...tokenIdentityContext({ sbId: GONE, sbSlug: 'pip-gone' }) }, 'list_emails')
      ).rejects.toThrow(
        "list_emails can't use its owner's google account: the calling SB has no identity on this account"
      );
    });

    it('refuses a slug-only token whose slug no row carries', async () => {
      await expect(
        gate({ ...tokenIdentityContext({ sbSlug: 'kindle-gone' }) }, 'list_emails')
      ).rejects.toThrow('the calling SB has no identity on this account');
    });

    it("refuses an ordinary SB's token beside a context naming an SB that is gone", async () => {
      await expect(
        gate(
          { ...tokenIdentityContext({ sbId: ORDINARY_SB, sbSlug: 'myra' }), sbId: GONE },
          'list_emails'
        )
      ).rejects.toThrow(InklingAccountRefusedError);
    });

    it('admits it for a tool turned on for inklings, as it would an inkling', async () => {
      await expect(
        gate({ ...tokenIdentityContext({ sbId: GONE }) }, 'list_emails', new Set(['list_emails']))
      ).resolves.toBeUndefined();
    });

    it('counts a slug as identified by the row its UUID names, whoever owns that row', async () => {
      fake.tables.agent_identities.push({
        id: '00000000-0000-4000-8000-0000000000ee',
        agent_id: 'quill',
        user_id: '00000000-0000-4000-8000-0000000000ff',
        workspace_id: WORKSPACE,
        metadata: {},
      });
      await expect(
        gate(
          {
            ...tokenIdentityContext({
              sbId: '00000000-0000-4000-8000-0000000000ee',
              sbSlug: 'quill',
            }),
          },
          'list_emails'
        )
      ).resolves.toBeUndefined();
    });
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

  async function call(server: FakeMcpServer, tool: string, context: object, args: object = {}) {
    const result = await runWithRequestContext(context, () => server.handlers.get(tool)!(args));
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

  describe("get_space_busy_times: each member's own switch, nothing turned on for inklings", () => {
    const SAM = '00000000-0000-4000-8000-0000000000b1';
    const KIT = '00000000-0000-4000-8000-0000000000b2';
    const CALENDAR = 'https://www.googleapis.com/auth/calendar.readonly';

    beforeEach(() => {
      fake.tables.workspace_members = [
        { workspace_id: WORKSPACE, user_id: OWNER, role: 'owner', calendar_share: 'busy' },
        { workspace_id: WORKSPACE, user_id: SAM, role: 'member', calendar_share: 'busy' },
        { workspace_id: WORKSPACE, user_id: KIT, role: 'member', calendar_share: 'none' },
      ];
      fake.tables.users = [
        { id: OWNER, first_name: 'Ada', last_name: null, username: null },
        { id: SAM, first_name: 'Sam', last_name: null, username: null },
        { id: KIT, first_name: 'Kit', last_name: null, username: null },
      ];
      // Kit has connected Google; connecting shares nothing (D6).
      fake.tables.connected_accounts = [SAM, KIT].map((userId) => ({
        user_id: userId,
        provider: 'google',
        status: 'active',
        workspace_id: WORKSPACE,
        scopes: [CALENDAR],
        access_token: `token-${userId}`,
        refresh_token: null,
        expires_at: null,
      }));
    });

    const readsFor = (userId: string) =>
      accountReads().filter((read) =>
        read.filters.some(
          ([op, column, value]) => op === 'eq' && column === 'user_id' && value === userId
        )
      );

    it("reaches a sharer's own account with INK_INKLING_ACCOUNT_TOOLS unset, never a non-sharer's", async () => {
      const result = (await call(registered(), 'get_space_busy_times', inklingTurn)) as unknown as {
        success: boolean;
        unavailable: Array<{ name: string; reason: string }>;
        notSharing: string[];
      };
      expect(result.success).toBe(true);
      // Sam's token was handed out (the gate admitted the tool) and Google was
      // reached, which this file stubs out; Ada has no connection at all.
      expect(fake.provider).toHaveBeenCalledTimes(1);
      expect(result.unavailable).toEqual([
        { name: 'Ada', reason: 'they have no Google calendar connected' },
        { name: 'Sam', reason: 'their Google calendar could not be read just now' },
      ]);
      expect(result.notSharing).toEqual(['Kit']);
      expect(readsFor(SAM).length).toBeGreaterThan(0);
      expect(readsFor(KIT)).toEqual([]);
    });

    it("reads the calling SB's own space, whatever space the request names", async () => {
      const ELSEWHERE = '00000000-0000-4000-8000-0000000000c1';
      fake.tables.agent_identities.push({
        id: ELSEWHERE,
        agent_id: 'wick',
        user_id: OWNER,
        workspace_id: OTHER_WORKSPACE,
        metadata: { ...INKLING_METADATA },
      });
      fake.tables.workspace_members.push({
        workspace_id: OTHER_WORKSPACE,
        user_id: OWNER,
        role: 'owner',
        calendar_share: 'none',
      });
      const result = (await call(registered(), 'get_space_busy_times', {
        ...inklingTurn,
        workspaceId: WORKSPACE,
        sbId: ELSEWHERE,
        sbSlug: 'wick',
        ...tokenIdentityContext({ sbId: ELSEWHERE, sbSlug: 'wick' }),
      })) as unknown as { sharing: unknown[]; notSharing: string[] };
      expect(result.sharing).toEqual([]);
      expect(result.notSharing).toEqual(['Ada']);
      expect(accountReads()).toEqual([]);
    });

    it('refuses a caller that is no SB', async () => {
      const result = await call(registered(), 'get_space_busy_times', {
        userId: OWNER,
        email: 'owner@example.test',
        workspaceId: WORKSPACE,
      });
      expect(result).toMatchObject({
        success: false,
        error: "Only a space's SB can read its members' busy times",
      });
      expect(accountReads()).toEqual([]);
    });

    it('reads nothing of anyone once nobody has switched it on', async () => {
      for (const member of fake.tables.workspace_members) member.calendar_share = 'none';
      const result = (await call(registered(), 'get_space_busy_times', inklingTurn)) as unknown as {
        sharing: unknown[];
        notSharing: string[];
      };
      expect(result.sharing).toEqual([]);
      expect(result.notSharing).toEqual(['Ada', 'Sam', 'Kit']);
      expect(accountReads()).toEqual([]);
      expect(fake.provider).not.toHaveBeenCalled();
    });

    describe('create_space_event (Conor, Oct 16, option (a))', () => {
      const day = 86_400_000;
      const at = (offset: number) => new Date(Date.now() + offset).toISOString();
      const event = (organizer: string) => ({
        title: 'Dinner',
        start: at(2 * day),
        end: at(2 * day + 7_200_000),
        organizer,
        attendees: [],
        organizerConfirmed: true,
      });

      it("reaches the sharing organizer's own account with INK_INKLING_ACCOUNT_TOOLS unset", async () => {
        fake.tables.connected_accounts[0].scopes = [
          CALENDAR,
          'https://www.googleapis.com/auth/calendar.events',
        ];
        const result = await call(registered(), 'create_space_event', inklingTurn, event('Sam'));
        // The token was handed out and Google reached; this file stubs Google out.
        expect(result.error ?? '').not.toContain("can't use its owner's google account");
        expect(fake.provider).toHaveBeenCalledTimes(1);
        expect(readsFor(SAM).length).toBeGreaterThan(0);
      });

      it("refuses an organizer who hasn't switched sharing on, before any account is read", async () => {
        const result = await call(registered(), 'create_space_event', inklingTurn, event('Kit'));
        expect(result).toMatchObject({ success: false });
        expect(result.error).toContain(`Kit hasn't switched "share my busy times here" on`);
        expect(accountReads()).toEqual([]);
        expect(fake.provider).not.toHaveBeenCalled();
      });
    });
  });

  describe("an inkling can't stop being one through its own identity tool (Lumen, PR #793)", () => {
    const saveIdentity = (server: FakeMcpServer, context: object, args: object) =>
      call(server, 'save_identity', { ...context, workspaceSource: 'derived' }, args);

    it('refuses save_identity clearing metadata.client, and the next Google call still refuses', async () => {
      // The tools profile an inkling's turn runs under does offer save_identity.
      const policy = new ToolPolicyState('backend', { persist: false });
      applyProfile(policy, 'tools');
      expect(policy.canCallInkTool('save_identity').allowed).toBe(true);

      const server = registered();
      const saved = await saveIdentity(server, inklingTurn, {
        sbSlug: 'pip',
        name: 'Pip',
        role: 'Inkling',
        metadata: { client: null },
      });
      expect(saved).toMatchObject({ success: false });
      expect(saved.error).toContain("can't change whether an SB is an inkling");
      expect(fake.tables.agent_identities[0]).toMatchObject({
        version: 2,
        metadata: INKLING_METADATA,
      });

      const after = await call(server, 'list_email_labels', inklingTurn);
      expect(after.error).toContain("can't use its owner's google account");
      expect(accountReads()).toEqual([]);
      expect(fake.provider).not.toHaveBeenCalled();
    });

    it('leaves the execution tier and the owner-turn gate where they were (Lumen, PR #793)', async () => {
      // The same marker decides both. At 656d80af this save cleared it, the
      // classifier returned "other", the tier fell to `full` and the
      // owner-turn gate stopped refusing.
      const saved = await saveIdentity(registered(), inklingTurn, {
        sbSlug: 'pip',
        name: 'Pip',
        role: 'Inkling',
        metadata: { client: null },
      });

      const after = await classifyIdentityById(supabase, INKLING);
      expect(after).toMatchObject({ kind: 'inkling', id: INKLING });
      // SessionService hands an inkling to the tier resolver as its client.
      const client = after.kind === 'inkling' ? INKLING_CLIENT : null;
      expect(executionTierFor({ sbId: INKLING, client }, {})).toEqual({
        tier: 'tools',
        from: 'client',
      });
      expect(
        inklingTurnRefusal({ identity: after, userId: OWNER, ownerMessage: 'no' }, new Set())
      ).not.toBeNull();
      expect(saved.success).toBe(false);
    });

    it('refuses restore_identity to a version that was not an inkling', async () => {
      // A version an inkling could have written by clearing metadata.client
      // before this check existed.
      fake.tables.agent_identity_history = [
        {
          sb_id: INKLING,
          version: 1,
          name: 'Pip',
          role: 'Inkling',
          workspace_id: WORKSPACE,
          metadata: { client: null, ownerTest: true },
        },
      ];
      const restored = await call(
        registered(),
        'restore_identity',
        { ...inklingTurn, workspaceSource: 'derived' },
        { sbSlug: 'pip', version: 1 }
      );
      expect(restored.error).toContain("can't change whether an SB is an inkling");
      expect(fake.tables.agent_identities[0]).toMatchObject({
        version: 2,
        metadata: INKLING_METADATA,
      });
    });

    it('still saves an inkling that leaves metadata.client as it is', async () => {
      const saved = await saveIdentity(registered(), inklingTurn, {
        sbSlug: 'pip',
        name: 'Pip',
        role: 'Inkling',
        description: 'Still an inkling',
        metadata: { client: 'inkling-mobile', named: true },
      });
      expect(saved).toMatchObject({ success: true });
      expect(fake.tables.agent_identities[0]).toMatchObject({
        version: 3,
        description: 'Still an inkling',
        metadata: { ...INKLING_METADATA, named: true },
      });
    });

    it("refuses an ordinary SB's save_identity making itself an inkling", async () => {
      const saved = await saveIdentity(
        registered(),
        {
          userId: OWNER,
          email: 'owner@example.test',
          workspaceId: WORKSPACE,
          ...tokenIdentityContext({ sbId: ORDINARY_SB, sbSlug: 'myra' }),
        },
        { sbSlug: 'myra', name: 'Myra', role: 'Messenger', metadata: { client: 'inkling-mobile' } }
      );
      expect(saved.error).toContain("can't change whether an SB is an inkling");
      expect(fake.tables.agent_identities[1]).toMatchObject({ version: 1, metadata: {} });
    });

    it('refuses a first save that would make its new row an inkling', async () => {
      const saved = await saveIdentity(
        registered(),
        {
          userId: OWNER,
          email: 'owner@example.test',
          workspaceId: WORKSPACE,
          ...tokenIdentityContext({ sbSlug: 'quill' }),
        },
        { sbSlug: 'quill', name: 'Quill', role: 'Scribe', metadata: { client: 'inkling-mobile' } }
      );
      expect(saved.error).toContain("can't change whether an SB is an inkling");
      expect(fake.tables.agent_identities.map((row) => row.agent_id)).toEqual(['pip', 'myra']);
    });
  });

  it.each([false, true])(
    'refuses a slug-only inkling bearer that names another workspace it can reach (ordinary twin there: %s; Lumen, PR #793)',
    async (withTwin) => {
      if (withTwin) fake.tables.agent_identities.push(ordinaryTwin());
      // The production resolver accepts a header naming a workspace the caller can reach.
      const scope = await resolveWorkspaceContextForRequest({
        requestedWorkspaceId: OTHER_WORKSPACE,
        validateRequestedWorkspaceId: async (id) => id === OTHER_WORKSPACE,
        deriveWorkspaceIdFromAgent: async () => WORKSPACE,
      });
      expect(scope).toEqual({ workspaceId: OTHER_WORKSPACE, source: 'header' });

      const result = await call(registered(), 'list_email_labels', {
        userId: OWNER,
        email: 'owner@example.test',
        sbSlug: 'pip',
        ...tokenIdentityContext({ sbSlug: 'pip' }),
        workspaceId: scope!.workspaceId,
        workspaceSource: scope!.source,
      });
      expect(result.error).toContain("can't use its owner's google account");
      expect(accountReads()).toEqual([]);
      expect(fake.provider).not.toHaveBeenCalled();
    }
  );

  it("refuses an inkling's still-valid token after its identity is deleted with its space (Lumen, PR #793)", async () => {
    const token = signRunnerAccessToken({
      userId: OWNER,
      email: 'owner@example.test',
      sbSlug: 'pip',
      sbId: INKLING,
      sessionId: '00000000-0000-4000-8000-000000000088',
    });
    const verifier = Object.create(InkAuthProvider.prototype) as InkAuthProvider;
    const server = registered();
    const verified = verifier.verifyAccessTokenSignature(`Bearer ${token}`)!;
    expect(verified).toMatchObject({ userId: OWNER, sbId: INKLING, sbSlug: 'pip' });

    // A deleted space takes its identities with it (ON DELETE CASCADE); the
    // owner's account, and the token already issued, remain.
    fake.tables.agent_identities = fake.tables.agent_identities.filter((row) => row.id !== INKLING);
    const stillVerified = verifier.verifyAccessTokenSignature(`Bearer ${token}`)!;
    expect(stillVerified).toMatchObject({ userId: OWNER, sbId: INKLING });
    const scope = await resolveWorkspaceContextForRequest({
      requestedWorkspaceId: OTHER_WORKSPACE,
      validateRequestedWorkspaceId: async (id) => id === OTHER_WORKSPACE,
    });

    const result = await call(server, 'list_email_labels', {
      ...stillVerified,
      ...tokenIdentityContext(stillVerified),
      workspaceId: scope!.workspaceId,
      workspaceSource: scope!.source,
    });
    expect(result.error).toContain('the calling SB has no identity on this account');
    expect(accountReads()).toEqual([]);
    expect(fake.provider).not.toHaveBeenCalled();
  });

  it('keeps each registered handler in its own name while calls overlap (Lumen, PR #793)', async () => {
    const server = registered();
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    for (const name of ['probe_a', 'probe_b']) {
      server.registerTool(name, {}, (async () => {
        const before = currentToolName();
        if (++started === 2) release();
        await bothStarted;
        return { content: [{ text: JSON.stringify({ before, after: currentToolName() }) }] };
      }) as never);
    }
    const results = await Promise.all(
      ['probe_a', 'probe_b'].map(async (name) =>
        JSON.parse((await server.handlers.get(name)!({})).content[0].text)
      )
    );
    expect(results).toEqual([
      { before: 'probe_a', after: 'probe_a' },
      { before: 'probe_b', after: 'probe_b' },
    ]);
    expect(currentToolName()).toBeUndefined();
  });

  it('keeps the registration name across the transient-error retry (Lumen, PR #793)', async () => {
    const server = registered();
    const observed: Array<string | undefined> = [];
    server.registerTool('probe_retry', {}, (async () => {
      observed.push(currentToolName());
      if (observed.length === 1) throw new Error('connection terminated unexpectedly');
      return { content: [{ text: JSON.stringify({ success: true }) }] };
    }) as never);
    const result = await server.handlers.get('probe_retry')!({});
    expect(JSON.parse(result.content[0].text).success).toBe(true);
    expect(observed).toEqual(['probe_retry', 'probe_retry']);
    expect(currentToolName()).toBeUndefined();
  });

  it('names the tool for code below the handler, and nothing outside a call', () => {
    expect(runInToolCall('list_emails', () => currentToolName())).toBe('list_emails');
    expect(currentToolName()).toBeUndefined();
  });
});
