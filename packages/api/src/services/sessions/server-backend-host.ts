/**
 * The BackendHost of the API server: one per admitted run, for a server that
 * serves many sessions (spec:live-agent-surfaces, P2c).
 *
 * Everything comes in explicitly. The CLI host answers from its own process
 * (cli-host.ts), because it is the session it serves; this server is not, so
 * nothing here reads its env, cwd or home. The caller resolves the paths, the
 * MCP URL and the base env, and hands over the dependencies that reach the
 * filesystem or the network. A provider's own auth or config home that the
 * caller selects is not session isolation, and nothing here claims it.
 *
 * Not wired into SessionService: selecting this host is P2d, behind
 * INK_RUNTIME_IN_PROCESS.
 */

import { isAbsolute } from 'path';
import { STOP_GIVE_UP_MS, STOP_GRACE_MS } from '@inklabs/shared';
import {
  startBackendTurn,
  type BackendHost,
  type BackendRunRequest,
  type BackendTurnHandle,
} from '@inklabs/shared/providers';
import {
  attachRunChild,
  getActiveRun,
  isGenerationAdmitted,
  otherGenerationOwnsChild,
  type ChildOwnership,
} from './active-runs.js';

/**
 * Added to a minted credential's lifetime for clock skew between this server
 * and whoever verifies the token, on top of the child's own settlement grace.
 */
export const MINT_SKEW_MS = 60_000;

/** The fixed reasons a hosted spawn's credentials are refused. */
export const SERVER_HOST_REFUSALS = {
  deadlinePassed: "the run's deadline has passed; no credential is minted for a new spawn",
  invalidCeiling: 'a spawn asked for credentials without a finite, positive ceiling',
  missingCredential:
    'no Inkwell credential could be minted for this hosted spawn, so it was not started',
  notAdmitted:
    "the run's generation is no longer the one admitted for its session, or intake has closed; nothing is minted or started for it",
  wrongSession: 'a hosted turn must name the session its generation was admitted for',
  olderChildUnconfirmed:
    'another generation of this session still owns a child whose exit is not confirmed; nothing is minted or started beside it',
} as const;

/**
 * Why `admission` may not start work now, or undefined when it may. In this
 * process only: the durable cross-process gate is still missing (P2d), so a
 * writer elsewhere is not seen here.
 */
function refusalFor(admission: { sessionId: string; turnEpoch: string }): string | undefined {
  if (!isGenerationAdmitted(admission.sessionId, admission.turnEpoch)) {
    return SERVER_HOST_REFUSALS.notAdmitted;
  }
  if (otherGenerationOwnsChild(admission.sessionId, admission.turnEpoch)) {
    return SERVER_HOST_REFUSALS.olderChildUnconfirmed;
  }
  return undefined;
}

/**
 * A refusal from the host's sessionEnv. The runner asks for credentials
 * before it spawns and spawns nothing when the ask throws (BackendHost.
 * sessionEnv), so a turn that rejects with one of these provably started no
 * child. Any other rejection says nothing about the child.
 */
export class HostedSpawnRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedSpawnRefusal';
  }
}

export interface ServerBackendHostInput {
  /**
   * The admitted generation this host serves: the run registerActiveRun took
   * for the session, by its epoch. Its registration time starts the run's one
   * deadline, so no spawn of the run, continuation or summarizer, restarts it.
   */
  admission: { sessionId: string; turnEpoch: string };
  /** The run's whole budget, from admission. */
  budgetMs: number;
  /** The base env every child inherits from, captured by the caller. */
  baseEnv: Readonly<Record<string, string | undefined>>;
  paths: { inkFiles: string; studiosRoot: string; tempDir: string };
  /** This session's Inkwell MCP server, as the caller reaches it. */
  inkwellMcpUrl: string;
  /**
   * A session credential that lasts `ttlSeconds`. Anything but a non-empty
   * string fails the spawn: a hosted spawn never falls back to the owner's
   * authorization.
   */
  mintAccessToken(input: { ttlSeconds: number }): string | undefined | Promise<string | undefined>;
  /** The secret the child verifies and mints delegation tokens with, if any. */
  delegationSecret?: string;
  resolveBinary(name: string): Promise<string>;
  claudeSupportsPartialMessages(): Promise<boolean>;
  skillMcpServers: BackendHost['skillMcpServers'];
  warn(message: string): void;
  /** This process's clock. Tests replace it. */
  now?: () => number;
}

function requireFinitePositive(value: number, what: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${what} must be a finite, positive number of milliseconds`);
  }
}

/**
 * The host for one admitted run. Throws unless the generation named is the
 * one admitted for its session now, and unless every input is usable.
 *
 * Admission at creation is not standing authority: a takeover or a shutdown
 * can end it at any time. The host asks again before and after each mint,
 * and once more right before each spawn (admitSpawn), so an old host mints
 * nothing and starts nothing (Lumen, #701 873209b4).
 *
 * Each of those asks also refuses while another generation of the session
 * still owns a child whose exit is not confirmed: a takeover never runs work
 * beside a child that may still be writing (Lumen, #701 d84b473b).
 */
export function createServerBackendHost(input: ServerBackendHostInput): BackendHost {
  const { admission } = input;
  const run = getActiveRun(admission.sessionId);
  if (!run) throw new Error(SERVER_HOST_REFUSALS.notAdmitted);
  const refusedAtCreation = refusalFor(admission);
  if (refusedAtCreation) throw new Error(refusedAtCreation);
  requireFinitePositive(input.budgetMs, 'the run budget');
  if (!Number.isFinite(run.startedAt)) {
    throw new RangeError('the admitted run has no usable start time');
  }
  for (const [name, path] of Object.entries(input.paths)) {
    if (!isAbsolute(path)) throw new Error(`the ${name} path must be absolute`);
  }
  try {
    new URL(input.inkwellMcpUrl);
  } catch {
    throw new Error('the Inkwell MCP URL cannot be read');
  }

  const now = input.now ?? Date.now;
  // registerActiveRun stamps startedAt with this process's Date.now(), which
  // is the clock deadlineAt is compared with (BackendHost.deadlineAt).
  const deadlineAt = run.startedAt + input.budgetMs;
  const baseEnv: Readonly<Record<string, string | undefined>> = Object.freeze({
    ...input.baseEnv,
  });
  const paths = Object.freeze({ ...input.paths });

  return {
    paths,
    deadlineAt,
    // A hosted spawn names its own session; a missing id means absent.
    ambientSession: () => ({}),
    claudeSupportsPartialMessages: () => input.claudeSupportsPartialMessages(),
    skillMcpServers: (cwd) => input.skillMcpServers(cwd),
    async sessionEnv({ hardTimeoutMs }) {
      if (
        typeof hardTimeoutMs !== 'number' ||
        !Number.isFinite(hardTimeoutMs) ||
        hardTimeoutMs <= 0
      ) {
        throw new HostedSpawnRefusal(SERVER_HOST_REFUSALS.invalidCeiling);
      }
      // The runner already clamps the ceiling to the deadline; the lifetime
      // is measured from the deadline here too, so no ceiling a caller passes
      // can stretch a credential past the run.
      const remainingMs = deadlineAt - now();
      if (remainingMs <= 0) throw new HostedSpawnRefusal(SERVER_HOST_REFUSALS.deadlinePassed);
      const refused = refusalFor(admission);
      if (refused) throw new HostedSpawnRefusal(refused);
      const lifetimeMs =
        Math.min(hardTimeoutMs, remainingMs) + STOP_GRACE_MS + STOP_GIVE_UP_MS + MINT_SKEW_MS;
      const token = await input.mintAccessToken({ ttlSeconds: Math.ceil(lifetimeMs / 1000) });
      // Asked again after the await: admission lost during the mint means the
      // credential exists but is handed to nothing.
      const refusedAfterMint = refusalFor(admission);
      if (refusedAfterMint) throw new HostedSpawnRefusal(refusedAfterMint);
      if (typeof token !== 'string' || token.length === 0) {
        throw new HostedSpawnRefusal(SERVER_HOST_REFUSALS.missingCredential);
      }
      return {
        INK_ACCESS_TOKEN: token,
        ...(input.delegationSecret ? { INK_DELEGATION_SECRET: input.delegationSecret } : {}),
      };
    },
    baseEnv: async () => baseEnv,
    inkwellMcpUrl: input.inkwellMcpUrl,
    resolveBinary: (name) => input.resolveBinary(name),
    warn: (message) => input.warn(message),
    admitSpawn: () => refusalFor(admission) === undefined,
  };
}

export interface HostedBackendTurn {
  handle: BackendTurnHandle;
  /** The turn's place under its generation, held from before it started. */
  ownership: ChildOwnership;
}

/**
 * Start a turn for an admitted run, owned from before it can spawn: the one
 * public launch for the server host. Synchronous from the admission check to
 * the start, so no takeover or shutdown can fall between them.
 *
 * Throws, with nothing started and nothing owned, unless the generation is
 * admitted now and the request names its session. Once started, the turn is
 * given back only on a confirmed exit. A turn that settles without one
 * (childExited false, or a rejection) stays owned, so a drain still stops it
 * and reports it unconfirmed. Losing admission later does not drop it: the
 * host then mints and spawns nothing for it (admitSpawn), and the refusal
 * itself is a confirmed exit, since no child started.
 */
export function startHostedBackendTurn(
  hostInput: ServerBackendHostInput,
  request: Omit<BackendRunRequest, 'host'>
): HostedBackendTurn {
  const { sessionId, turnEpoch } = hostInput.admission;
  if (request.inkSessionId !== sessionId) throw new Error(SERVER_HOST_REFUSALS.wrongSession);
  const host = createServerBackendHost(hostInput);

  let handle: BackendTurnHandle | undefined;
  let confirm!: (value: { childExited: boolean }) => void;
  let fail!: (error: unknown) => void;
  const settled = new Promise<{ childExited: boolean }>((resolve, reject) => {
    confirm = resolve;
    fail = reject;
  });
  // Handled here so a rejection waiting for a reader never crashes the
  // process; stopOwnedChildren still sees it reject.
  settled.catch(() => undefined);

  const ownership = attachRunChild(sessionId, turnEpoch, {
    abort: () => handle?.abort(),
    settled,
  });
  if (!ownership) {
    throw new Error(refusalFor(hostInput.admission) ?? SERVER_HOST_REFUSALS.notAdmitted);
  }

  try {
    handle = startBackendTurn({ ...request, host });
  } catch (error) {
    // Nothing started: the reservation is given back.
    ownership.release();
    throw error;
  }
  handle.result.then(
    (result) => {
      confirm({ childExited: result.childExited });
      if (result.childExited) ownership.release();
    },
    (error: unknown) => {
      if (error instanceof HostedSpawnRefusal) {
        // The host withheld the credentials, so no child ever started.
        confirm({ childExited: true });
        ownership.release();
        return;
      }
      fail(error);
    }
  );
  return { handle, ownership };
}
