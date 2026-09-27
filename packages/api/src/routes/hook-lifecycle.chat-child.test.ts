/**
 * A provider child of `ink chat` must not clear its parent's turn marker.
 *
 * The chat process opens `cli_turn_at` with its turn signal and runs each
 * provider step as a child that inherits its INK_SESSION_ID. A headless
 * child used to re-assert `cliAttached:false` right after its prompt event,
 * and the lifecycle route treats that as a detach and clears the marker. A
 * locally started chat has no server run registered, so the marker was its
 * only protection, gone for the whole provider step (Lumen, PR #685 r2).
 * Lumen's probe, adapted: the child's env is the real adapter's plus the
 * owner marker backend-runner adds, and what its hook writes comes from the
 * hook's own decision (promptAttachmentWrite).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

vi.mock('../mcp/auth/ink-auth-provider', () => ({
  InkAuthProvider: class {
    verifyAccessToken(header?: string) {
      return header ? { userId: 'user-1' } : null;
    }
  },
}));

// The regrant's workspace is resolved by the server from the session's
// identity (spec inkmail-thread-scope §1; Lumen, #616): sb-uuid-1 lives in
// ws-1, anything else names no workspace.
vi.mock('../services/principals', () => ({
  workspaceOfSb: vi.fn(async (_client: unknown, sbId: string) =>
    sbId === 'sb-uuid-1' ? 'ws-1' : null
  ),
}));

vi.mock('../services/graph-executor.service', () => ({
  releaseGraphClaimsForSession: vi.fn(async () => undefined),
}));

import { ClaudeAdapter } from '../../../cli/src/backends/claude.js';
import { PARENT_OWNED_TURN_ENV, promptAttachmentWrite } from '../../../cli/src/lib/turn-owner.js';
import { decodeContextToken } from '@inklabs/shared';

import { createHookLifecycleRouter } from './hook-lifecycle';
import { StudioLeaseService } from '../services/studio-lease.service';
import { releaseGraphClaimsForSession } from '../services/graph-executor.service';
import type { DataComposer } from '../data/composer';

// Minimal fake supabase for the StudioLeaseService the route constructs —
// empty tables make lease renewals/releases clean no-ops. Direct table
// UPDATEs (the round-11 fenced stop CAS) are recorded with their filters and
// resolve with a matched row unless a test flips `fencedUpdateMatches`.
interface RecordedUpdate {
  table: string;
  payload: Record<string, unknown>;
  eqs: Array<[string, unknown]>;
}
const recordedUpdates: RecordedUpdate[] = [];
let fencedUpdateMatches = true;
let directUpdateError: { message: string } | null = null;

function makeFakeClient() {
  const chain = (table: string, mode: 'select' | 'update' | 'insert', payload?: unknown) => {
    const eqs: Array<[string, unknown]> = [];
    const obj = {
      eq(col: string, val: unknown) {
        eqs.push([col, val]);
        return obj;
      },
      is() {
        return obj;
      },
      or(expr: string) {
        eqs.push(['or', expr]);
        return obj;
      },
      not() {
        return obj;
      },
      limit() {
        return obj;
      },
      order() {
        return obj;
      },
      select() {
        return obj;
      },
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single: () => Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'none' } }),
      then<T>(resolve: (v: { data: unknown; error: null }) => T) {
        if (mode === 'update') {
          recordedUpdates.push({
            table,
            payload: (payload ?? {}) as Record<string, unknown>,
            eqs,
          });
          return Promise.resolve({
            data: directUpdateError ? null : fencedUpdateMatches ? [{ id: SESSION_ID }] : [],
            error: directUpdateError,
          }).then(resolve as never);
        }
        return Promise.resolve({ data: [] as never[], error: null }).then(resolve);
      },
    };
    return obj;
  };
  return {
    from: (table: string) => ({
      select: () => chain(table, 'select'),
      update: (payload: unknown) => chain(table, 'update', payload),
      insert: () => chain(table, 'insert'),
    }),
    rpc: (...args: unknown[]) => {
      rpcCalls.push(args);
      return Promise.resolve(rpcResult());
    },
  } as never;
}

/** Recorded rpc invocations across all fake clients (the route re-gets one per request). */
const rpcCalls: unknown[][] = [];
let rpcResult: () => { data: unknown; error: { message: string } | null } = () => ({
  data: { outcome: 'claimed', epoch: 'epoch-1' },
  error: null,
});

const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

describe('hook-lifecycle: a chat provider child and its parent turn marker', () => {
  const updateSession = vi.fn(async (_id: string, _updates: Record<string, unknown>) => ({
    id: SESSION_ID,
  }));
  const getSession = vi.fn(async () => ({
    id: SESSION_ID,
    userId: 'user-1',
    endedAt: null,
    status: 'active',
    lifecycle: 'idle',
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

  beforeEach(() => {
    updateSession.mockClear();
    getSession.mockClear();
    rpcCalls.length = 0;
    rpcResult = () => ({ data: { outcome: 'claimed', epoch: 'epoch-1' }, error: null });
    recordedUpdates.length = 0;
    fencedUpdateMatches = true;
    directUpdateError = null;
  });

  async function post(body: Record<string, unknown>) {
    const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ sessionId: SESSION_ID, ...body }),
    });
    expect(resp.status).toBe(200);
    return updateSession.mock.calls.at(-1)?.[1] as Record<string, unknown>;
  }

  /** The on-prompt hook's two requests, as a child with this env sends them. */
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

  const clearedMarker = () =>
    updateSession.mock.calls.some(([, updates]) => updates.cliTurnAt === null);

  it('a headless chat child leaves the parent turn marker open', async () => {
    // The parent chat opens the turn. No server run is registered for it.
    await post({ lifecycle: 'running', event: 'prompt' });
    const child = childEnv(false, PARENT_OWNED_TURN_ENV);
    try {
      await childPrompt(child.env);
      expect(clearedMarker()).toBe(false);
      expect(updateSession.mock.calls.at(-1)?.[1]).toHaveProperty('cliTurnAt', expect.any(String));
    } finally {
      child.cleanup();
    }
  });

  it('control: a server spawn still detaches, and the detach clears the marker', async () => {
    await post({ lifecycle: 'running', event: 'prompt' });
    const child = childEnv(false, {});
    try {
      await childPrompt(child.env);
      expect(updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
        cliAttached: false,
        cliTurnAt: null,
      });
    } finally {
      child.cleanup();
    }
  });

  it('an attached REPL child re-asserts attachment and keeps the marker', async () => {
    await post({ lifecycle: 'running', event: 'prompt' });
    const child = childEnv(true, PARENT_OWNED_TURN_ENV);
    try {
      await childPrompt(child.env);
      expect(clearedMarker()).toBe(false);
      expect(updateSession.mock.calls.at(-1)?.[1]).toMatchObject({ cliAttached: true });
    } finally {
      child.cleanup();
    }
  });
});
