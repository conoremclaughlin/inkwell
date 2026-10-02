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
import type { BackendHost, BackendTurnHandle } from '@inklabs/shared/providers';
import { attachRunChild, getActiveRun, type ChildOwnership } from './active-runs.js';

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
} as const;

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
 */
export function createServerBackendHost(input: ServerBackendHostInput): BackendHost {
  const { admission } = input;
  const run = getActiveRun(admission.sessionId);
  if (!run || run.turnEpoch === undefined || run.turnEpoch !== admission.turnEpoch) {
    throw new Error('a server backend host serves only the generation admitted for its session');
  }
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
      if (!Number.isFinite(hardTimeoutMs) || hardTimeoutMs <= 0) {
        throw new RangeError(SERVER_HOST_REFUSALS.invalidCeiling);
      }
      // The runner already clamps the ceiling to the deadline; the lifetime
      // is measured from the deadline here too, so no ceiling a caller passes
      // can stretch a credential past the run.
      const remainingMs = deadlineAt - now();
      if (remainingMs <= 0) throw new Error(SERVER_HOST_REFUSALS.deadlinePassed);
      const lifetimeMs =
        Math.min(hardTimeoutMs, remainingMs) + STOP_GRACE_MS + STOP_GIVE_UP_MS + MINT_SKEW_MS;
      const token = await input.mintAccessToken({ ttlSeconds: Math.ceil(lifetimeMs / 1000) });
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error(SERVER_HOST_REFUSALS.missingCredential);
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
  };
}

/**
 * Put a started turn's child under its admitted generation, and give it back
 * only once its exit is confirmed. A turn that settles without a confirmed
 * exit (childExited false, or a rejection) stays owned, so shutdown still
 * stops it and reports it as unconfirmed. When the generation is no longer
 * the admitted one, or intake has closed, the turn is aborted at once and
 * nothing is owned.
 */
export function ownBackendTurn(
  admission: { sessionId: string; turnEpoch: string },
  handle: BackendTurnHandle
): ChildOwnership | undefined {
  const settled = handle.result.then((result) => ({ childExited: result.childExited }));
  // Handled here so a rejection waiting for a reader never crashes the
  // process; stopOwnedChildren still sees it reject.
  settled.catch(() => undefined);
  const ownership = attachRunChild(admission.sessionId, admission.turnEpoch, {
    abort: () => handle.abort(),
    settled,
  });
  if (!ownership) {
    handle.abort();
    return undefined;
  }
  handle.result.then(
    (result) => {
      if (result.childExited) ownership.release();
    },
    () => undefined
  );
  return ownership;
}
