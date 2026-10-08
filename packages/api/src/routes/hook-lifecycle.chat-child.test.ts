/**
 * A provider child of `ink chat` must not clear its parent's turn marker,
 * and a headless chat must still leave its session routed to spawn.
 *
 * The chat process opens `cli_turn_at` with its turn signal and runs each
 * provider step as a child that inherits its INK_SESSION_ID. A headless
 * child used to re-assert `cliAttached:false` right after its prompt event,
 * and the lifecycle route treats that as a detach and clears the marker. A
 * locally started chat has no server run registered, so the marker was its
 * only protection, gone for the whole provider step (Lumen, PR #685 r2).
 *
 * The child now writes no attachment, which also stopped it clearing a
 * `cli_attached:true` left by a crashed interactive process. Every prompt
 * refreshes `updated_at`, so delivery kept reading that flag as a live inline
 * consumer while nothing consumed (Lumen, PR #685 r3). The headless owner
 * declares the false itself, in the request that opens its turn.
 *
 * Lumen's probes, adapted. The route is real, and so is everything posted to
 * it: the owner's requests come from the real turn signal, the child's env
 * from the real adapter plus the owner marker backend-runner adds, and the
 * child's attachment write from the hook's own decision
 * (promptAttachmentWrite). Persistence is one fake session row that each
 * write updates in the order it lands, and delivery is the production
 * decideDelivery reading that row.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

vi.mock('../mcp/auth/ink-auth-provider', () => ({
  InkAuthProvider: class {
    verifyAccessToken(header?: string) {
      return header ? { ok: true, token: { userId: 'user-1' } } : { ok: false, status: 401 };
    }
  },
}));

vi.mock('../services/principals', () => ({
  workspaceOfSb: vi.fn(async () => null),
}));

vi.mock('../services/graph-executor.service', () => ({
  releaseGraphClaimsForSession: vi.fn(async () => undefined),
}));

import { ClaudeAdapter } from '../../../cli/src/backends/claude.js';
import { PARENT_OWNED_TURN_ENV, promptAttachmentWrite } from '../../../cli/src/lib/turn-owner.js';
import { createTurnSignal } from '../../../cli/src/repl/turn-signal.js';
import { decodeContextToken } from '@inklabs/shared';

import { createHookLifecycleRouter } from './hook-lifecycle';
import { decideDelivery } from '../services/sessions/trigger-delivery';
import type { DataComposer } from '../data/composer';

const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

/** The persisted session row, as the route's writes leave it. */
interface SessionRow {
  cli_attached: boolean;
  cli_turn_at: string | null;
  lifecycle: string;
  turn_epoch: string | null;
  updated_at: string;
}
let row: SessionRow;
let epochs = 0;

/** Every applied write touches updated_at, as the table's trigger does. */
function applyToRow(changes: Partial<SessionRow>) {
  row = { ...row, ...changes, updated_at: new Date().toISOString() };
}

/** Column names for the camelCase updates the repository translates. */
const COLUMN: Record<string, keyof SessionRow | undefined> = {
  cliAttached: 'cli_attached',
  cliTurnAt: 'cli_turn_at',
  lifecycle: 'lifecycle',
};

function makeFakeClient() {
  const chain = (table: string, payload?: Record<string, unknown>) => {
    const eqs: Array<[string, unknown]> = [];
    const obj = {
      eq(col: string, val: unknown) {
        eqs.push([col, val]);
        return obj;
      },
      is: () => obj,
      or: () => obj,
      not: () => obj,
      limit: () => obj,
      order: () => obj,
      select: () => obj,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single: () => Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'none' } }),
      then<T>(resolve: (v: { data: unknown; error: null }) => T) {
        if (payload && table === 'sessions') {
          // The fenced writes (a claim's ride-along, a modern stop) match
          // only while the row still carries the epoch they name.
          const fence = eqs.find(([col]) => col === 'turn_epoch');
          if (fence && fence[1] !== row.turn_epoch) {
            return Promise.resolve({ data: [], error: null }).then(resolve);
          }
          applyToRow(payload as Partial<SessionRow>);
          return Promise.resolve({ data: [{ id: SESSION_ID }], error: null }).then(resolve);
        }
        return Promise.resolve({ data: [] as never[], error: null }).then(resolve);
      },
    };
    return obj;
  };
  return {
    from: (table: string) => ({
      select: () => chain(table),
      update: (payload: Record<string, unknown>) => chain(table, payload),
      insert: () => chain(table),
    }),
    rpc: (name: string) => {
      if (name === 'claim_turn_epoch') {
        // One statement in production: a fresh epoch, lifecycle running and
        // the turn marker together.
        const epoch = `epoch-${++epochs}`;
        applyToRow({
          turn_epoch: epoch,
          lifecycle: 'running',
          cli_turn_at: new Date().toISOString(),
        });
        return Promise.resolve({ data: { outcome: 'claimed', epoch }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as never;
}

describe('hook-lifecycle: an ink chat turn, its provider child, and delivery', () => {
  const updateSession = vi.fn(async (_id: string, updates: Record<string, unknown>) => {
    const changes: Partial<SessionRow> = {};
    for (const [key, value] of Object.entries(updates)) {
      const column = COLUMN[key];
      if (column) Object.assign(changes, { [column]: value });
    }
    applyToRow(changes);
    return { id: SESSION_ID };
  });
  const getSession = vi.fn(async () => ({
    id: SESSION_ID,
    userId: 'user-1',
    endedAt: null,
    status: 'active',
    lifecycle: row.lifecycle,
  }));

  const dataComposer = {
    getClient: () => makeFakeClient(),
    repositories: { memory: { getSession, updateSession } },
  } as unknown as DataComposer;

  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/hooks', createHookLifecycleRouter(dataComposer));
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  /** A session between turns, with or without a leftover attachment. */
  function seedRow(cliAttached: boolean) {
    row = {
      cli_attached: cliAttached,
      cli_turn_at: null,
      lifecycle: 'idle',
      turn_epoch: 'epoch-0',
      updated_at: new Date().toISOString(),
    };
  }

  beforeEach(() => {
    updateSession.mockClear();
    getSession.mockClear();
    epochs = 0;
    seedRow(false);
  });

  async function post(body: Record<string, unknown>) {
    const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ sessionId: SESSION_ID, ...body }),
    });
    expect(resp.status).toBe(200);
  }

  /** The owning `ink chat` process opens its turn: the real turn signal. */
  async function ownerOpens(cliAttached: boolean) {
    const signal = createTurnSignal({
      getSessionId: () => SESSION_ID,
      sbSlug: 'lumen',
      cliAttached,
      getServerUrl: () => baseUrl,
      getToken: async () => 'test',
      workingDir: '/work/tree',
      retryDelayMs: 0,
    });
    await expect(signal.open()).resolves.toBe(true);
  }

  /** The on-prompt hook's requests, as a child with this env sends them. */
  async function childPrompt(env: Record<string, string | undefined>) {
    const headless = decodeContextToken(env.INK_CONTEXT)!.cliAttached === false;
    await post({ lifecycle: 'running', event: 'prompt', headless });
    const write = promptAttachmentWrite(headless, env);
    if (write !== null) await post({ cliAttached: write });
  }

  function childEnv(cliAttached: boolean, owner: Record<string, string>) {
    const prepared = new ClaudeAdapter().prepare({
      sbSlug: 'lumen',
      inkSessionId: SESSION_ID,
      prompt: 'hello',
      promptParts: ['hello'],
      passthroughArgs: [],
      cliAttached,
    });
    return { env: { ...prepared.env, ...owner }, cleanup: prepared.cleanup };
  }

  /** What an ordinary (unforced) trigger does with this row right now. */
  const delivery = () =>
    decideDelivery({
      forceSpawn: false,
      pollRow: null,
      attachedRow: { cli_attached: row.cli_attached, updated_at: row.updated_at },
    }).mode;

  it('a headless chat child leaves the parent turn marker open', async () => {
    // No server run is registered for a locally started chat.
    await ownerOpens(false);
    const child = childEnv(false, PARENT_OWNED_TURN_ENV);
    try {
      await childPrompt(child.env);
      expect(updateSession.mock.calls.some(([, u]) => u.cliTurnAt === null)).toBe(false);
      expect(row.cli_turn_at).not.toBeNull();
      expect(delivery()).toBe('spawn');
    } finally {
      child.cleanup();
    }
  });

  it('a headless owner clears an attachment a crashed interactive process left, and keeps its marker', async () => {
    // The previous interactive process exited without detaching. A local
    // --message run, or a server spawn, now takes the session.
    seedRow(true);
    expect(delivery()).toBe('inline');

    await ownerOpens(false);
    // Protected from the open on, not only once the child's prompt lands.
    expect(row.cli_turn_at).not.toBeNull();
    expect(delivery()).toBe('spawn');

    const child = childEnv(false, PARENT_OWNED_TURN_ENV);
    try {
      await childPrompt(child.env);
      expect(row.cli_turn_at).not.toBeNull();
      expect(row.lifecycle).toBe('running');
      expect(delivery()).toBe('spawn');
    } finally {
      child.cleanup();
    }
  });

  it('control: an interactive owner on the same row stays an inline consumer', async () => {
    seedRow(true);
    await ownerOpens(true);
    const child = childEnv(true, PARENT_OWNED_TURN_ENV);
    try {
      await childPrompt(child.env);
      expect(row.cli_attached).toBe(true);
      expect(row.cli_turn_at).not.toBeNull();
      expect(delivery()).toBe('inline');
    } finally {
      child.cleanup();
    }
  });

  it('control: a server spawn still detaches, and the detach clears the marker', async () => {
    await post({ lifecycle: 'running', event: 'prompt' });
    const child = childEnv(false, {});
    try {
      await childPrompt(child.env);
      expect(row).toMatchObject({ cli_attached: false, cli_turn_at: null });
    } finally {
      child.cleanup();
    }
  });

  it('an attached REPL child re-asserts attachment and keeps the marker', async () => {
    await ownerOpens(true);
    const child = childEnv(true, PARENT_OWNED_TURN_ENV);
    try {
      await childPrompt(child.env);
      expect(updateSession.mock.calls.some(([, u]) => u.cliTurnAt === null)).toBe(false);
      expect(row).toMatchObject({ cli_attached: true, cli_turn_at: expect.any(String) });
    } finally {
      child.cleanup();
    }
  });
});
