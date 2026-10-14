/** Pure persistence/wake boundary checks. No database, process, network or real composer. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wake = vi.hoisted(() =>
  vi.fn(async (_args: unknown, _composer: unknown) => ({ success: true }))
);
vi.mock('../mcp/tools/inbox-handlers.js', () => ({ handleSendToInbox: wake }));
vi.mock('../data/composer.js', () => ({ getDataComposer: vi.fn(async () => ({ fake: true })) }));
vi.mock('../utils/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import {
  resolveApprovalRequests,
  type ApprovalResolutionAction,
  type ApprovalResolutionRequest,
} from './resolve-approval-requests';

const NOW = '2026-10-13T18:00:00.000Z';
const LATER = '2026-10-13T18:10:00.000Z';
const command = 'remove-fixture-only'; // Never passed to any executor.

function request(overrides: Partial<ApprovalResolutionRequest> = {}): ApprovalResolutionRequest {
  return {
    id: 'request-a',
    tool: 'Bash',
    args: command,
    cwd: '/fixture/a',
    requesting_agent_id: 'fixture-sb',
    session_id: 'session-a',
    scope_key: 'scope-a',
    expires_at: LATER,
    ...overrides,
  };
}

interface Row {
  id: string;
  user_id: string;
  status: string;
  expires_at: string;
}
interface Filter {
  column: string;
  value: unknown;
  op: 'eq' | 'gt';
}
interface Write {
  table: string;
  filters: Filter[];
  payload: Record<string, unknown>;
  selection?: string;
}

/** Apply predicates at select-time, like the one conditional DB write, not at read-time. */
function database(initial: Row[], response?: { data: unknown; error: unknown }) {
  const rows = initial.map((row) => ({ ...row }));
  const writes: Write[] = [];
  const from = vi.fn((table: string) => ({
    update(payload: Record<string, unknown>) {
      const write: Write = { table, filters: [], payload };
      writes.push(write);
      const chain = {
        eq(column: string, value: unknown) {
          write.filters.push({ op: 'eq', column, value });
          return chain;
        },
        gt(column: string, value: unknown) {
          write.filters.push({ op: 'gt', column, value });
          return chain;
        },
        async select(selection: string) {
          write.selection = selection;
          if (response) return response;
          const matching = rows.filter((row) =>
            write.filters.every(({ column, value, op }) => {
              const stored = row[column as keyof Row];
              return op === 'eq'
                ? stored === value
                : Date.parse(stored) > Date.parse(String(value));
            })
          );
          for (const row of matching) Object.assign(row, payload);
          return { data: matching.map(({ id }) => ({ id })), error: null };
        },
      };
      return chain;
    },
  }));
  return { client: { from } as unknown as SupabaseClient, rows, writes };
}
function pending(overrides: Partial<Row> = {}): Row {
  return {
    id: 'request-a',
    user_id: 'owner-a',
    status: 'pending',
    expires_at: LATER,
    ...overrides,
  };
}
function resolve(
  db: ReturnType<typeof database>,
  action: ApprovalResolutionAction = 'grant',
  requests = [request()],
  selection: 'targeted' | 'bulk' = 'targeted'
) {
  return resolveApprovalRequests(db.client, {
    userId: 'owner-a',
    grantedBy: 'platform:fixture',
    action,
    selection,
    requests,
  });
}

beforeEach(() => {
  vi.useRealTimers();
  // new Date() is what the writer uses; fake only Date, not async scheduling.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  wake.mockReset();
  wake.mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('resolveApprovalRequests', () => {
  it('uses one guarded write and wakes the signed requester only after winning', async () => {
    const db = database([pending()]);
    expect(await resolve(db)).toEqual([
      { id: 'request-a', tool: 'Bash', action: 'grant', sbSlug: 'fixture-sb' },
    ]);
    expect(db.writes).toEqual([
      {
        table: 'approval_requests',
        selection: 'id',
        filters: [
          { op: 'eq', column: 'id', value: 'request-a' },
          { op: 'eq', column: 'status', value: 'pending' },
          { op: 'eq', column: 'user_id', value: 'owner-a' },
          { op: 'gt', column: 'expires_at', value: NOW },
        ],
        payload: {
          status: 'granted',
          action: 'grant',
          granted_tools: [`Bash(${command})`],
          granted_by: 'platform:fixture',
          resolved_at: NOW,
        },
      },
    ]);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-a',
        recipientSlug: 'fixture-sb',
        recipientSessionId: 'session-a',
        messageType: 'session_resume',
        metadata: { source: 'approval_interceptor', approvalRequestId: 'request-a' },
        content: expect.stringContaining('/fixture/a'),
      }),
      { fake: true }
    );
    expect(db.rows[0].status).toBe('granted');
    expect(db.writes[0].payload).not.toHaveProperty('consumed_at');
  });

  it.each([
    { id: 'other-request' },
    { user_id: 'owner-b' },
    { status: 'denied' },
    { status: 'granted' },
    { expires_at: NOW },
    { expires_at: '2026-10-13T17:59:00.000Z' },
  ])('cannot change or wake a row outside the write predicates: %j', async (other) => {
    const row = pending(other);
    const db = database([row]);
    expect(await resolve(db)).toEqual([]);
    expect(db.rows).toEqual([row]);
    expect(wake).not.toHaveBeenCalled();
  });

  it('reports only one winner for overlapping approval and denial', async () => {
    const db = database([pending()]);
    const answers = await Promise.all([resolve(db), resolve(db, 'deny')]);
    expect(answers.map((answer) => answer.length)).toEqual([1, 0]);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(db.rows[0].status).toBe('granted');
  });

  it('a denial winner prevents a later grant and never wakes', async () => {
    const db = database([pending()]);
    const answers = await Promise.all([resolve(db, 'deny'), resolve(db)]);
    expect(answers.map((answer) => answer.length)).toEqual([1, 0]);
    expect(db.writes[0].payload).toMatchObject({
      status: 'denied',
      action: 'deny',
      granted_tools: null,
    });
    expect(db.rows[0].status).toBe('denied');
    expect(wake).not.toHaveBeenCalled();
  });

  it('a targeted decision cannot disguise multiple ids or duplicate one id', async () => {
    const db = database([pending()]);
    await expect(resolve(db, 'grant', [request(), request()])).rejects.toThrow('exactly one');
    expect(db.writes).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });

  it.each([null, undefined, [], [{ id: 'request-a' }, { id: 'extra' }], { id: 'request-a' }])(
    'no exact affected-row receipt means no report/wake/retry: %j',
    async (data) => {
      const db = database([pending()], { data, error: null });
      expect(await resolve(db)).toEqual([]);
      expect(db.writes).toHaveLength(1);
      expect(wake).not.toHaveBeenCalled();
    }
  );

  it('an error alongside row data is not a successful resolution', async () => {
    const db = database([pending()], {
      data: [{ id: 'request-a' }],
      error: { message: 'fixture failure' },
    });
    expect(await resolve(db)).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
    expect(db.writes).toHaveLength(1);
  });

  it('a failed wake never undoes or resubmits a confirmed decision', async () => {
    const db = database([pending()]);
    wake.mockRejectedValueOnce(new Error('fixture wake failed'));
    expect(await resolve(db)).toHaveLength(1);
    expect(db.rows[0].status).toBe('granted');
    expect(db.writes).toHaveLength(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it.each(['grant', 'grant-session', 'grant-agent', 'grant-studio', 'allow', 'deny'] as const)(
    'preserves ordinary request action %s without a one-use wake',
    async (action) => {
      const db = database([pending()]);
      expect(await resolve(db, action, [request({ scope_key: null })])).toEqual([
        { id: 'request-a', tool: 'Bash', action, sbSlug: 'fixture-sb' },
      ]);
      expect(wake).not.toHaveBeenCalled();
    }
  );

  it.each(['grant-session', 'grant-agent', 'grant-studio', 'allow'] as const)(
    'a scoped action %s cannot grant one-use consent even when labelled targeted',
    async (action) => {
      const db = database([pending()]);
      expect(await resolve(db, action)).toEqual([]);
      expect(db.writes).toEqual([]);
      expect(wake).not.toHaveBeenCalled();
    }
  );

  it('a bulk approval cannot grant a lone one-use request', async () => {
    const db = database([pending()]);
    expect(await resolve(db, 'grant', [request()], 'bulk')).toEqual([]);
    expect(db.writes).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });

  it('bulk approval keeps ordinary rows but drops one-use rows', async () => {
    const db = database([pending(), pending({ id: 'ordinary' })]);
    expect(
      await resolve(db, 'grant', [request(), request({ id: 'ordinary', scope_key: null })], 'bulk')
    ).toEqual([{ id: 'ordinary', tool: 'Bash', action: 'grant', sbSlug: 'fixture-sb' }]);
    expect(db.rows[0].status).toBe('pending');
    expect(wake).not.toHaveBeenCalled();
  });

  it('bulk denial still restricts one-use and ordinary requests without waking', async () => {
    const db = database([pending(), pending({ id: 'ordinary' })]);
    expect(
      await resolve(db, 'deny', [request(), request({ id: 'ordinary', scope_key: null })], 'bulk')
    ).toHaveLength(2);
    expect(db.rows.map(({ status }) => status)).toEqual(['denied', 'denied']);
    expect(wake).not.toHaveBeenCalled();
  });

  it('missing or unknown selection cannot turn into targeted consent', async () => {
    const db = database([pending()]);
    await expect(resolve(db, 'grant', [request()], 'unknown' as 'targeted')).rejects.toThrow(
      'Unsupported approval selection'
    );
    expect(db.writes).toEqual([]);
  });

  it('a granted request without a session does not guess a wake destination', async () => {
    const db = database([pending()]);
    expect(await resolve(db, 'grant', [request({ session_id: null })])).toHaveLength(1);
    expect(wake).not.toHaveBeenCalled();
  });

  it('an unknown internal decision cannot become a grant', async () => {
    const db = database([pending()]);
    await expect(resolve(db, 'approve-everything' as ApprovalResolutionAction)).rejects.toThrow(
      'Unsupported approval decision'
    );
    expect(db.writes).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });
});
