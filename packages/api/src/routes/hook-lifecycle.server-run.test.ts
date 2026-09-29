/**
 * A server run's `ink chat` child must not take the run's epoch.
 *
 * The server starts every turn by writing `lifecycle: 'running'` and a fresh
 * `turn_epoch` onto the session, and finishes it with a write fenced on that
 * epoch. When the backend is `ink chat`, the chat process opens and closes
 * each of its outer turns through the lifecycle route (repl/turn-signal.ts).
 * Its open was a prompt event with no `headless` field, so the route claimed
 * a fresh epoch for it, and the server's own finalize then matched zero rows.
 * On 2026-09-29 that was every ink-backed run: 32 `Spawning ink chat` lines
 * and 32 `Inline turn finalize fenced out by a newer owner` lines on ink
 * sessions, one session's `message_count` stuck at 4 after 29 runs, and the
 * run-boundary effects skipped each time.
 *
 * A second path rotated the epoch with no claim at all. The installed
 * `handle_session_running_write` mints a new epoch whenever a `running` write
 * lands on a row that is not `running` and carries no new epoch. A provider
 * child's headless prompt wrote `lifecycle: 'running'` unfenced, so any idle
 * write in the middle of a run was followed by a rotation. The measured idle
 * was the child's own `startup` SessionStart hook: on 2026-09-29 all 12
 * direct Claude Code spawns were fresh sessions and fired it, and all 11 that
 * finished were fenced out. The CLI no longer sends it from a spawn
 * (packages/cli/src/commands/hooks.server-run.test.ts); these tests pin the
 * route as the backstop for any other idle.
 *
 * The rule these tests pin: inside a server run, only the run moves the
 * epoch and the lifecycle. The chat learns the run's epoch from its spawn
 * env, declares itself headless, and every write it makes is fenced on that
 * epoch. The route is real, the chat's requests come from the real turn
 * signal, and the row applies the installed trigger's rotation rule.
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

vi.mock('../services/principals', () => ({
  workspaceOfSb: vi.fn(async () => null),
}));

vi.mock('../services/graph-executor.service', () => ({
  releaseGraphClaimsForSession: vi.fn(async () => undefined),
}));

import { createTurnSignal } from '../../../cli/src/repl/turn-signal.js';
import { sessionStartStateArgs } from '../../../cli/src/lib/session-start-state.js';

import { createHookLifecycleRouter } from './hook-lifecycle';
import { interruptActiveRuns } from '../services/sessions/interrupt-active-runs';
import { releaseGraphClaimsForSession } from '../services/graph-executor.service';
import { StudioLeaseService } from '../services/studio-lease.service';
import type { DataComposer } from '../data/composer';

const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000002';
const RUN_EPOCH = 'run-epoch-0';

interface SessionRow {
  cli_attached: boolean;
  cli_turn_at: string | null;
  cli_turn_stopped_at: string | null;
  lifecycle: string;
  turn_epoch: string | null;
  working_dir: string | null;
}
let row: SessionRow;
let claims = 0;
let rotations = 0;

/**
 * Every write, as the installed trigger sees it. A write that takes the row
 * INTO `running` without naming a new epoch gets a fresh one; a write on a
 * row already `running` leaves the epoch alone. Read from the live function
 * (pg_get_functiondef), not from the migration that first created it.
 */
function applyWrite(changes: Partial<SessionRow>) {
  const next = { ...row, ...changes };
  const entersRunning = next.lifecycle === 'running' && row.lifecycle !== 'running';
  if (
    entersRunning &&
    (changes.turn_epoch === undefined ||
      changes.turn_epoch === null ||
      changes.turn_epoch === row.turn_epoch)
  ) {
    next.turn_epoch = `rotated-${++rotations}`;
  }
  row = next;
}

const COLUMN: Record<string, keyof SessionRow | undefined> = {
  cliAttached: 'cli_attached',
  cliTurnAt: 'cli_turn_at',
  cliTurnStoppedAt: 'cli_turn_stopped_at',
  lifecycle: 'lifecycle',
  workingDir: 'working_dir',
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
      in: () => obj,
      limit: () => obj,
      order: () => obj,
      select: () => obj,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single: () => Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'none' } }),
      then<T>(resolve: (v: { data: unknown; error: null }) => T) {
        if (payload && table === 'sessions') {
          const fence = eqs.find(([col]) => col === 'turn_epoch');
          if (fence && fence[1] !== row.turn_epoch) {
            return Promise.resolve({ data: [], error: null }).then(resolve);
          }
          applyWrite(payload as Partial<SessionRow>);
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
        claims += 1;
        const epoch = `claimed-${claims}`;
        applyWrite({ turn_epoch: epoch, lifecycle: 'running', cli_turn_at: 'claim' });
        return Promise.resolve({ data: { outcome: 'claimed', epoch }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as never;
}

/** The server's pre-turn write (session-service): id-only, epoch named. */
function serverTakesTurn() {
  applyWrite({ lifecycle: 'running', turn_epoch: RUN_EPOCH });
}

/** The server's finalize (updateIfTurnEpoch): lands only on its own epoch. */
function serverFinalizes(): boolean {
  if (row.turn_epoch !== RUN_EPOCH) return false;
  applyWrite({ lifecycle: 'idle', cli_attached: false });
  return true;
}

/**
 * The shutdown sweep's view of the same row. Its update honours the two
 * predicates interrupt-active-runs.ts puts on it: lifecycle = 'running' and
 * turn_epoch in the run's epochs.
 */
function sweepClient() {
  return {
    from: () => ({
      select: () => {
        const read = {
          eq: () => read,
          maybeSingle: async () => ({
            data: {
              metadata: {},
              lifecycle: row.lifecycle,
              ended_at: null,
              turn_epoch: row.turn_epoch,
            },
            error: null,
          }),
        };
        return read;
      },
      update: (payload: Record<string, unknown>) => {
        let lifecycleIs: unknown;
        let epochIn: unknown[] | undefined;
        const write = {
          eq(col: string, val: unknown) {
            if (col === 'lifecycle') lifecycleIs = val;
            return write;
          },
          is: () => write,
          in(col: string, vals: unknown[]) {
            if (col === 'turn_epoch') epochIn = vals;
            return write;
          },
          select: async () => {
            const matches =
              (lifecycleIs === undefined || row.lifecycle === lifecycleIs) &&
              (epochIn === undefined || epochIn.includes(row.turn_epoch));
            if (!matches) return { data: [], error: null };
            if (typeof payload.lifecycle === 'string') applyWrite({ lifecycle: payload.lifecycle });
            return { data: [{ id: SESSION_ID }], error: null };
          },
        };
        return write;
      },
    }),
  };
}

/** The run as the server's registry holds it while the turn executes. */
const liveRun = () => ({
  sessionId: SESSION_ID,
  userId: 'user-1',
  sbSlug: 'wren',
  backend: 'claude',
  startedAt: Date.now(),
  turnEpoch: RUN_EPOCH,
});

describe('hook-lifecycle: a server run and the ink chat it spawned', () => {
  const updateSession = vi.fn(async (_id: string, updates: Record<string, unknown>) => {
    const changes: Partial<SessionRow> = {};
    for (const [key, value] of Object.entries(updates)) {
      const column = COLUMN[key];
      if (column) Object.assign(changes, { [column]: value });
    }
    applyWrite(changes);
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

  let releaseAtBoundary: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    updateSession.mockClear();
    getSession.mockClear();
    vi.mocked(releaseGraphClaimsForSession).mockClear();
    releaseAtBoundary = vi
      .spyOn(StudioLeaseService.prototype, 'releaseAtBoundary')
      .mockResolvedValue(false);
    vi.spyOn(StudioLeaseService.prototype, 'renewBySession').mockResolvedValue(undefined as never);
    claims = 0;
    rotations = 0;
    row = {
      cli_attached: false,
      cli_turn_at: null,
      cli_turn_stopped_at: null,
      lifecycle: 'idle',
      turn_epoch: 'previous-epoch',
      working_dir: null,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function post(body: Record<string, unknown>) {
    const resp = await fetch(`${baseUrl}/api/hooks/lifecycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ sessionId: SESSION_ID, ...body }),
    });
    expect(resp.status).toBe(200);
  }

  /** The chat's real turn signal, as a server spawn builds it. */
  function chatSignal(runTurnEpoch: string | undefined) {
    return createTurnSignal({
      getSessionId: () => SESSION_ID,
      sbSlug: 'myra',
      cliAttached: false,
      runTurnEpoch,
      getServerUrl: () => baseUrl,
      getToken: async () => 'test',
      workingDir: '/work/tree',
      retryDelayMs: 0,
    });
  }

  /**
   * A provider step: what the chat's claude child posts from its hooks. It
   * is headless and parent-owned, so it never claims, and it has no epoch
   * record, so its stop admits the record is missing.
   */
  async function providerStep() {
    await post({ lifecycle: 'running', event: 'prompt', headless: true });
    await post({ lifecycle: 'idle', event: 'stop', turnEpochMissing: true });
  }

  /** The boundary chain is fire-and-forget; let it run before asserting. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("keeps the run's epoch through two outer turns, so the run's finalize lands", async () => {
    serverTakesTurn();
    const chat = chatSignal(RUN_EPOCH);

    for (let turn = 0; turn < 2; turn += 1) {
      await expect(chat.open()).resolves.toBe(true);
      expect(row.turn_epoch).toBe(RUN_EPOCH);
      await providerStep();
      await expect(chat.close()).resolves.toBe(true);
      expect(row.turn_epoch).toBe(RUN_EPOCH);
      // The run owns the lifecycle: nothing inside it idles the row.
      expect(row.lifecycle).toBe('running');
    }
    await chat.detach();

    expect(claims).toBe(0);
    expect(rotations).toBe(0);
    expect(serverFinalizes()).toBe(true);
    expect(row.lifecycle).toBe('idle');
  });

  it("keeps the run's epoch when something idles the row mid-run and a provider step follows", async () => {
    serverTakesTurn();
    const chat = chatSignal(RUN_EPOCH);
    await chat.open();

    // An id-only idle through the same repository method: what the startup
    // hook of an older CLI still sends, or a model's update_session_state.
    await updateSession(SESSION_ID, { lifecycle: 'idle' });
    await providerStep();

    expect(rotations).toBe(0);
    expect(row.turn_epoch).toBe(RUN_EPOCH);
    await chat.close();
    expect(serverFinalizes()).toBe(true);
  });

  /**
   * A provider's startup hook: update_session_state with the arguments the
   * CLI builds, which the tool maps onto the repository update one to one.
   */
  async function providerStarts(headless: boolean) {
    const { lifecycle, workingDir } = sessionStartStateArgs({
      sessionId: SESSION_ID,
      sbSlug: 'wren',
      workingDir: '/work/tree',
      headless,
    });
    await updateSession(SESSION_ID, {
      ...(lifecycle !== undefined ? { lifecycle } : {}),
      workingDir,
    });
  }

  it("keeps a fresh spawn's run running under its epoch through startup and prompt, so a shutdown marks it", async () => {
    serverTakesTurn();

    await providerStarts(true);
    await post({ lifecycle: 'running', event: 'prompt', headless: true });

    expect(rotations).toBe(0);
    expect(row).toMatchObject({ lifecycle: 'running', turn_epoch: RUN_EPOCH });
    const [outcome] = await interruptActiveRuns(sweepClient(), [liveRun()]);
    expect(outcome).toMatchObject({ state: 'interrupted', marked: true });
    expect(row.lifecycle).toBe('interrupted');
  });

  it("control: a startup that writes idle leaves the run reading idle, and a shutdown can't mark it", async () => {
    serverTakesTurn();

    await providerStarts(false);
    await post({ lifecycle: 'running', event: 'prompt', headless: true });

    expect(row.lifecycle).toBe('idle');
    const [outcome] = await interruptActiveRuns(sweepClient(), [liveRun()]);
    expect(outcome.state).toBe('finalized-elsewhere');
    expect(row.lifecycle).toBe('idle');
  });

  /** A provider compacting mid-run, as its pre- and post-compact hooks post. */
  async function providerCompacts(headless: boolean) {
    const flag = headless ? { headless: true } : {};
    await post({ lifecycle: 'compacting', event: 'pre-compact', ...flag });
    await post({ lifecycle: 'idle', event: 'post-compact', ...flag });
  }

  it("keeps the run's lifecycle and epoch through a spawned provider's compaction", async () => {
    serverTakesTurn();

    await providerCompacts(true);
    expect(row.lifecycle).toBe('running');
    await providerStep();

    expect(rotations).toBe(0);
    expect(row).toMatchObject({ lifecycle: 'running', turn_epoch: RUN_EPOCH });
    expect(serverFinalizes()).toBe(true);
  });

  it('control: a compaction that does not declare itself headless still idles the row', async () => {
    serverTakesTurn();

    await providerCompacts(false);

    expect(row.lifecycle).toBe('idle');
  });

  it("marks the chat's own turn while it runs, fenced on the run's epoch", async () => {
    serverTakesTurn();
    const chat = chatSignal(RUN_EPOCH);

    await chat.open();
    expect(row.cli_turn_at).not.toBeNull();
    expect(row.working_dir).toBe('/work/tree');

    await chat.close();
    expect(row.cli_turn_at).toBeNull();
  });

  it("runs no boundary release at the chat's stop: the run's finalize is the boundary", async () => {
    serverTakesTurn();
    const chat = chatSignal(RUN_EPOCH);
    await chat.open();
    await chat.close();
    await settle();

    expect(releaseAtBoundary).not.toHaveBeenCalled();
    expect(releaseGraphClaimsForSession).not.toHaveBeenCalled();
  });

  it('control: a second owner still fences the run out, and the chat writes nothing over it', async () => {
    serverTakesTurn();
    const chat = chatSignal(RUN_EPOCH);
    await chat.open();

    // A person attaches mid-run: an interactive prompt claims the session.
    await post({ lifecycle: 'running', event: 'prompt' });
    await post({ cliAttached: true });
    const owner = { ...row };
    expect(owner.turn_epoch).not.toBe(RUN_EPOCH);

    await chat.close();
    await chat.open();
    await chat.detach();

    expect(row).toEqual(owner);
    expect(serverFinalizes()).toBe(false);
  });

  it('control: a locally started one-shot chat, with no server run, still claims its own turn', async () => {
    const chat = chatSignal(undefined);

    await expect(chat.open()).resolves.toBe(true);
    expect(claims).toBe(1);
    expect(row).toMatchObject({ lifecycle: 'running', turn_epoch: 'claimed-1' });

    await expect(chat.close()).resolves.toBe(true);
    expect(row.lifecycle).toBe('idle');
    await settle();
    expect(releaseAtBoundary).toHaveBeenCalledTimes(1);
  });
});
