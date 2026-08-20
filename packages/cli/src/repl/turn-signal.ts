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
 * by the sweep while a REPL turn was still running in the worktree — the
 * exact premature-release direction the presence/mid-turn split exists to
 * rule out.
 *
 * The server route (`/api/hooks/lifecycle`) stays the single writer:
 *   - `open()`  → `event: 'prompt'`  — sets `cli_turn_at`, renews the lease
 *   - `close()` → `event: 'stop'`    — clears it and runs the lease boundary,
 *     which is what completes a release the turn itself requested
 *
 * Failure posture matches the backend lifecycle hooks (`hooks.ts`): posts are
 * non-fatal and never break the turn. A missed `prompt` degrades to the
 * pre-signal behavior for that one turn; a missed `stop` leaves the marker
 * open until the next turn's stop or an explicit detach (`cliAttached:
 * false`) — the marker deliberately has no wall-time expiry, so errors decay
 * toward HOLDING a lease, never toward releasing one early.
 */

export interface TurnSignalDeps {
  /** Live ref — the PCP session can attach/rotate after construction. */
  getSessionId: () => string | undefined;
  agentId: string;
  /** Resolved per post so config changes and lazy imports stay cheap. */
  getServerUrl: () => Promise<string> | string;
  getToken: (serverUrl: string) => Promise<string | null | undefined>;
  workingDir: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onDebug?: (event: string, detail: Record<string, unknown>) => void;
}

export interface TurnSignal {
  /** Turn is starting: post `prompt` (marker set, lease renewed). */
  open(): Promise<void>;
  /** Turn is over — every exit path: post `stop` (marker cleared, boundary). */
  close(): Promise<void>;
}

export function createTurnSignal(deps: TurnSignalDeps): TurnSignal {
  const post = async (event: 'prompt' | 'stop'): Promise<void> => {
    const sessionId = deps.getSessionId();
    if (!sessionId) return;
    try {
      const serverUrl = (await deps.getServerUrl()).replace(/\/+$/, '');
      const token = await deps.getToken(serverUrl);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const fetchImpl = deps.fetchImpl ?? fetch;
      const resp = await fetchImpl(`${serverUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sessionId,
          lifecycle: event === 'prompt' ? 'running' : 'idle',
          event,
          agentId: deps.agentId,
          workingDir: deps.workingDir,
        }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
      });
      if (!resp.ok) {
        deps.onDebug?.('turn_signal_post_failed', { event, sessionId, status: resp.status });
      }
    } catch (error) {
      deps.onDebug?.('turn_signal_post_error', { event, sessionId, error: String(error) });
    }
  };

  return {
    open: () => post('prompt'),
    close: () => post('stop'),
  };
}
