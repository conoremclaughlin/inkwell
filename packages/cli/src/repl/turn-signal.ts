/**
 * Turn signal — the REPL's ownership of the hook-owned CLI turn marker.
 *
 * `sessions.cli_turn_at` is the single durable proof that a CLI process is
 * INSIDE a turn. `StudioLeaseService.isSessionMidTurn` reads exactly two
 * signals: the API process's in-process run registry (server-spawned runners
 * only) and this marker. An interactive `ink chat` REPL is neither — it runs
 * turns in its own process and, before this module, never posted the
 * `prompt`/`stop` lifecycle events that own the marker. Consequence (PR #506
 * P1, Lumen): a `pendingRelease` stamped on the session's lease was completed
 * by the sweep while a REPL turn was still running in the worktree.
 *
 * The server route (`/api/hooks/lifecycle`) stays the single writer:
 *   - `open()`   → `event: 'prompt'` — sets `cli_turn_at`, renews the lease
 *   - `close()`  → `event: 'stop'`   — clears it and runs the lease boundary,
 *     which is what completes a release the turn itself requested
 *   - `detach()` → `cliAttached: false` — process-proof that this process
 *     left; clears the marker. The exit-path fallback for a missed stop.
 *
 * Failure semantics are DIRECTIONAL, not symmetric (round-two P1):
 *   - A missed `prompt` fails toward PREMATURE RELEASE — the turn would run
 *     unproven, and a healthy sweep clears any pendingRelease under the live
 *     process. So `open()` retries, then reports `false` — including when no
 *     PCP session is attached at all — and the caller MUST fail closed for
 *     studio-backed work via `turnGateDecision`: no acknowledged marker, no
 *     turn.
 *   - A missed `stop` fails toward HOLDING — the unbounded marker stays open.
 *     `close()` retries; the next turn's stop or the REPL exit `detach()`
 *     (cleanup path in chat.ts) reconciles it. A hard crash (SIGKILL) leaves
 *     the marker for process-proof recovery — a new attach or explicit
 *     detach — per the trigger-studio-routing v14 contract; there is
 *     deliberately no wall-time expiry.
 */

export interface TurnSignalDeps {
  /** Live ref — the PCP session can attach/rotate after construction. */
  getSessionId: () => string | undefined;
  /** Live ref — the worktree studio this REPL runs in, for the lease fence. */
  getStudioId?: () => string | undefined;
  agentId: string;
  /** Resolved per post so config changes and lazy imports stay cheap. */
  getServerUrl: () => Promise<string> | string;
  getToken: (serverUrl: string) => Promise<string | null | undefined>;
  workingDir: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Delay between the two post attempts; tests set 0. */
  retryDelayMs?: number;
  onDebug?: (event: string, detail: Record<string, unknown>) => void;
}

export interface TurnSignal {
  /**
   * Turn is starting. Resolves `true` when protection is established
   * (marker write acknowledged AND the studio lease held); `false` when it
   * could not be confirmed — including when no PCP session is attached. The
   * caller decides via `turnGateDecision` whether the turn may run.
   */
  open(): Promise<boolean>;
  /** Turn is over — every exit path. Resolves `true` on acknowledged stop. */
  close(): Promise<boolean>;
  /** Process is leaving — REPL cleanup path. Clears the marker server-side. */
  detach(): Promise<boolean>;
}

export type TurnGate = { allow: true } | { allow: false; reason: string };

/**
 * The fail-closed policy, as one visible unit — the exact predicate chain the
 * turn queue evaluates before running a backend (round-three P1: a session
 * that failed to start must not slip past the gate).
 *
 * Studio-backed means a REAL worktree studio (UUID). `main` (the root repo)
 * and studioless runs stay best-effort: the root repo is never torn down or
 * rescued out from under a process, and refusing turns there would brick the
 * common degraded case (server hiccup at launch) with nothing to protect.
 */
export function turnGateDecision(
  sessionId: string | undefined,
  opened: boolean,
  studioId: string | undefined
): TurnGate {
  const studioBacked = Boolean(studioId) && studioId !== 'main';
  if (!studioBacked) return { allow: true };
  if (!sessionId) {
    return {
      allow: false,
      reason:
        'no PCP session is attached, so this worktree’s lease cannot be protected. Restart `ink chat` (or check the server) and resend.',
    };
  }
  if (!opened) {
    return {
      allow: false,
      reason:
        'the server did not acknowledge turn ownership, so this worktree’s lease is unprotected. Check server connectivity (`ink doctor`) and resend.',
    };
  }
  return { allow: true };
}

type PostBody = Record<string, unknown>;

export function createTurnSignal(deps: TurnSignalDeps): TurnSignal {
  const attemptPost = async (
    body: PostBody,
    interpret: (resp: Response) => Promise<boolean>
  ): Promise<boolean> => {
    const serverUrl = (await deps.getServerUrl()).replace(/\/+$/, '');
    const token = await deps.getToken(serverUrl);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const resp = await fetchImpl(`${serverUrl}/api/hooks/lifecycle`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
    });
    return interpret(resp);
  };

  const acked = async (resp: Response): Promise<boolean> => resp.ok;

  // The prompt fence (round four): a 2xx alone is not protection — the
  // server reports whether THIS studio's lease is still held by this session
  // after its synchronous renewal. `studioLeaseHeld: false` means a release
  // won the race (or the lease is foreign/gone): the turn must not start.
  // An absent field (stop events, main, studioless, older servers) does not
  // veto. An unparseable body fails closed.
  const ackedAndHeld = async (resp: Response): Promise<boolean> => {
    if (!resp.ok) return false;
    try {
      const body = (await resp.json()) as { studioLeaseHeld?: boolean };
      return body.studioLeaseHeld !== false;
    } catch {
      return false;
    }
  };

  // Two attempts total: one retry absorbs transient blips (the disk-full
  // incident's ENOSPC spawn failures, a mid-restart server) without letting a
  // dead server stall the REPL for long.
  const post = async (
    label: string,
    body: PostBody,
    interpret: (resp: Response) => Promise<boolean> = acked
  ): Promise<boolean> => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (await attemptPost(body, interpret)) return true;
        deps.onDebug?.('turn_signal_post_failed', { label, attempt, ...body });
      } catch (error) {
        deps.onDebug?.('turn_signal_post_error', { label, attempt, error: String(error) });
      }
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 250));
      }
    }
    return false;
  };

  const lifecycleBody = (event: 'prompt' | 'stop', sessionId: string): PostBody => ({
    sessionId,
    lifecycle: event === 'prompt' ? 'running' : 'idle',
    event,
    agentId: deps.agentId,
    workingDir: deps.workingDir,
  });

  return {
    async open() {
      const sessionId = deps.getSessionId();
      // No session = UNACKNOWLEDGED, not vacuously safe (round-three P1): a
      // failed start_session can leave the REPL running in a managed
      // worktree, and that turn must not slip past the fail-closed gate.
      // turnGateDecision decides whether the missing proof matters.
      if (!sessionId) return false;
      const studioId = deps.getStudioId?.();
      const body: PostBody = {
        ...lifecycleBody('prompt', sessionId),
        ...(studioId ? { studioId } : {}),
      };
      return post('open', body, ackedAndHeld);
    },
    async close() {
      const sessionId = deps.getSessionId();
      if (!sessionId) return true;
      return post('close', lifecycleBody('stop', sessionId));
    },
    async detach() {
      const sessionId = deps.getSessionId();
      if (!sessionId) return true;
      // cliAttached:false is the route's process-proof detach — it clears the
      // marker without needing a lifecycle value.
      return post('detach', { sessionId, cliAttached: false, agentId: deps.agentId });
    },
  };
}
