/**
 * Does the RUNNING SERVER route to the right SB?
 *
 * The cascade's own unit tests prove the module is correct. They cannot prove
 * the server calls it, or calls it with the arguments it needs — and a module
 * that production reaches with the wrong arguments is a green suite over a live
 * misroute. This runs the actual message handler from `server.ts`.
 *
 * The handler is extracted from the source by AST rather than imported, because
 * `server.ts` ends in an unconditional `startServer(...)`: importing it to reach
 * one arrow function would boot a real server on every suite run. Everything
 * below the handler is injected, so the only production code executing is the
 * handler itself, the cascade, and the reply resolver.
 *
 * Instrument and the three scenarios are Lumen's, from the PR #638 review;
 * kept here so the cases that found the bug stay run on every commit.
 */

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./resolve-mention', () => ({ resolveAgentFromMention: vi.fn() }));
vi.mock('./resolve-route', () => ({ resolveRouteSlug: vi.fn() }));

import { resolveInboundAgent } from './resolve-inbound-agent';
import { resolveAgentFromMention } from './resolve-mention';
import { resolveRouteSlug } from './resolve-route';

const DEFAULT_SLUG = 'myra';
const CHAT = '-100000000001';
const OTHER_CHAT = '-100000000002';

/** Pull the real `messageHandler` arrow out of server.ts without importing it. */
function extractMessageHandler(): string {
  const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
  let arrow = '';
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'messageHandler') {
      arrow = node.initializer!.getText(ast);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!arrow) {
    throw new Error('messageHandler not found in server.ts — this probe needs re-pointing');
  }
  return arrow;
}

const compiled = ts.transpileModule(`const handler = ${extractMessageHandler()};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

// `channelGateway` is injected as undefined: it ends the handler after
// session routing, before the channel-forwarding steps this probe does not model.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeHandler = (deps: Record<string, unknown>): any =>
  new Function(
    'deps',
    `const { sbSlug, dataComposer, logger, resolveInboundAgent, sessionService, channelGateway } = deps;
     ${compiled}
     return handler;`
  )(deps);

interface ActivityRow {
  [column: string]: unknown;
}

function attributedRow(overrides: ActivityRow = {}): ActivityRow {
  return {
    user_id: 'user-1',
    type: 'message_out',
    platform: 'telegram',
    platform_message_id: '4242',
    platform_chat_id: CHAT,
    agent_id: 'wren',
    sb_id: 'sb-wren',
    session_id: 'session-wren',
    payload: { authorship: 'session' },
    created_at: '2026-09-15T10:00:00Z',
    ...overrides,
  };
}

const OPEN_SESSION = { id: 'session-wren', user_id: 'user-1', ended_at: null };

function clientFor(rows: ActivityRow[], sessions: ActivityRow[] = [OPEN_SESSION]) {
  const tables: Record<string, ActivityRow[]> = { activity_stream: rows, sessions };
  return {
    from(table: string) {
      const predicates: Array<(row: ActivityRow) => boolean> = [];
      const matched = () => (tables[table] ?? []).filter((row) => predicates.every((p) => p(row)));
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          predicates.push((row) => row[column] === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          predicates.push((row) => values.includes(row[column]));
          return builder;
        },
        order: () => builder,
        limit(n: number) {
          return Promise.resolve({ data: matched().slice(0, n), error: null });
        },
        maybeSingle() {
          if (table !== 'sessions') throw new Error(`unexpected maybeSingle() on ${table}`);
          return Promise.resolve({ data: matched()[0] ?? null, error: null });
        },
        single() {
          if (table !== 'agent_identities') throw new Error(`unexpected single() on ${table}`);
          return Promise.resolve({ data: { session_scope: 'global' }, error: null });
        },
      };
      return builder;
    },
  };
}

/** Run the real handler and capture the SessionRequest it would have dispatched. */
async function route(options: {
  rows?: ActivityRow[];
  sessions?: ActivityRow[];
  mention?: { sbSlug: string; sbId: string } | null;
  channelRoute?: { sbSlug: string; sbId: string } | null;
  chatType?: string;
}) {
  vi.mocked(resolveAgentFromMention).mockResolvedValue(options.mention ?? null);
  vi.mocked(resolveRouteSlug).mockResolvedValue(
    options.channelRoute
      ? {
          ...options.channelRoute,
          routeId: 'route-1',
          studioHint: null,
          activeSessionId: null,
        }
      : null
  );

  // Stop the handler the moment it has decided, before any live session work.
  const stop = new Error('captured request');
  let captured: { sbSlug: string; metadata: Record<string, unknown> } | undefined;

  const handler = makeHandler({
    sbSlug: DEFAULT_SLUG,
    dataComposer: { getClient: () => clientFor(options.rows ?? [], options.sessions) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    resolveInboundAgent,
    sessionService: {
      handleMessage: async (request: typeof captured) => {
        captured = request;
        throw stop;
      },
    },
    channelGateway: undefined,
  });

  await expect(
    handler('telegram', CHAT, { id: 'sender-1', name: 'Sender' }, 'a reply', {
      userId: 'user-1',
      replyToMessageId: '4242',
      chatType: options.chatType ?? 'direct',
    })
  ).rejects.toBe(stop);

  return captured!;
}

describe('the production message handler', () => {
  it('does not answer a reply with an author from an unrelated chat', async () => {
    const result = await route({ rows: [attributedRow({ platform_chat_id: OTHER_CHAT })] });

    expect(result.sbSlug).toBe(DEFAULT_SLUG);
    expect(result.metadata.replyRouting).toEqual({
      resolved: false,
      reason: 'no_matching_message',
    });
  });

  it('keeps a mention of the default SB ahead of the reply author', async () => {
    const result = await route({
      rows: [attributedRow()],
      mention: { sbSlug: DEFAULT_SLUG, sbId: 'sb-myra' },
      chatType: 'group',
    });

    expect(result.sbSlug).toBe(DEFAULT_SLUG);
  });

  it('keeps a reply authored by the default SB ahead of a channel route', async () => {
    const result = await route({
      rows: [attributedRow({ agent_id: DEFAULT_SLUG, sb_id: 'sb-myra' })],
      channelRoute: { sbSlug: 'wren', sbId: 'sb-wren' },
    });

    expect(result.sbSlug).toBe(DEFAULT_SLUG);
    expect(result.metadata.replyRouting).toEqual({ resolved: true, session: 'authoring' });
  });

  it('still routes a reply to its author when nothing else matches', async () => {
    const result = await route({ rows: [attributedRow()] });

    expect(result.sbSlug).toBe('wren');
    expect(result.metadata.replyRouting).toEqual({ resolved: true, session: 'authoring' });
  });

  it('hands session routing the session that wrote the message', async () => {
    // The cascade can resolve the session and the handler can still drop it on
    // the way to handleMessage. Only this probe sees the request as dispatched.
    const result = await route({ rows: [attributedRow()] });

    expect(result.metadata.recipientSessionId).toBe('session-wren');
  });

  it('dispatches no anchor when the authoring session has ended', async () => {
    const result = await route({
      rows: [attributedRow()],
      sessions: [{ ...OPEN_SESSION, ended_at: '2026-09-20T12:00:00Z' }],
    });

    expect(result.sbSlug).toBe('wren');
    expect(result.metadata).not.toHaveProperty('recipientSessionId');
    expect(result.metadata.replyRouting).toEqual({ resolved: true, session: 'session_ended' });
  });

  it('says so when an anchored reply lands in a different session', async () => {
    // Authorization can drop the anchor (another contact or identity), and the
    // session can end between lookup and routing. Either way the delivery
    // succeeds, so without this line nothing records that the reply missed.
    const warn = vi.fn();
    const handler = makeHandler({
      sbSlug: DEFAULT_SLUG,
      dataComposer: { getClient: () => clientFor([attributedRow()]) },
      logger: { info() {}, warn, error() {}, debug() {} },
      resolveInboundAgent,
      sessionService: {
        handleMessage: async () => ({
          success: true,
          sessionId: 'session-elsewhere',
          responses: [],
        }),
      },
      channelGateway: undefined,
    });

    await handler('telegram', CHAT, { id: 'sender-1', name: 'Sender' }, 'a reply', {
      userId: 'user-1',
      replyToMessageId: '4242',
      chatType: 'direct',
    });

    expect(warn).toHaveBeenCalledWith(
      '[Route] Reply was anchored to its authoring session but landed elsewhere',
      expect.objectContaining({
        authoringSessionId: 'session-wren',
        routedSessionId: 'session-elsewhere',
      })
    );
  });

  it('stays quiet when the anchored reply lands where it was aimed', async () => {
    const warn = vi.fn();
    const handler = makeHandler({
      sbSlug: DEFAULT_SLUG,
      dataComposer: { getClient: () => clientFor([attributedRow()]) },
      logger: { info() {}, warn, error() {}, debug() {} },
      resolveInboundAgent,
      sessionService: {
        handleMessage: async () => ({ success: true, sessionId: 'session-wren', responses: [] }),
      },
      channelGateway: undefined,
    });

    await handler('telegram', CHAT, { id: 'sender-1', name: 'Sender' }, 'a reply', {
      userId: 'user-1',
      replyToMessageId: '4242',
      chatType: 'direct',
    });

    expect(warn).not.toHaveBeenCalled();
  });
});
