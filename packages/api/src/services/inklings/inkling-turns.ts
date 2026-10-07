/**
 * The inkling turns running in this server process, so an owner can cancel
 * one (POST /api/admin/inklings/:id/cancel) and the app can show whether an
 * inkling is working (GET /api/admin/inklings, `activity`). processMessage
 * tracks each inkling turn from just before its spawn until the runner
 * returns; the runner stops the process (and its process group) when the
 * signal aborts.
 *
 * In-process only, for Stop and activity alike: a turn started by another
 * server process is not here, so this process cancels nothing of it and
 * reports its inkling idle.
 */

interface LiveTurn {
  controller: AbortController;
  /** When the turn was tracked, as an ISO timestamp. */
  startedAt: string;
}

const live = new Map<string, Set<LiveTurn>>();

/**
 * What an inkling is doing, as far as this process knows:
 * - `working`: at least one live turn that nobody has stopped;
 * - `stopping`: live turns, every one stopped (Stop acknowledged, the
 *   runner not yet returned);
 * - `idle`: no live turn.
 * `since` is the oldest start among the turns behind the state, or null
 * when idle. A turn started after a Stop, while the stopped one winds down,
 * is working since its own start, not the stopped turn's.
 */
export interface InklingTurnActivity {
  state: 'idle' | 'working' | 'stopping';
  since: string | null;
}

/** Track one turn for `sbId`. Call `done()` when the runner has returned. */
export function trackInklingTurn(sbId: string): { signal: AbortSignal; done: () => void } {
  const turn: LiveTurn = {
    controller: new AbortController(),
    startedAt: new Date().toISOString(),
  };
  const turns = live.get(sbId) ?? new Set<LiveTurn>();
  turns.add(turn);
  live.set(sbId, turns);
  return {
    signal: turn.controller.signal,
    done: () => {
      turns.delete(turn);
      if (turns.size === 0 && live.get(sbId) === turns) live.delete(sbId);
    },
  };
}

/** Abort every live turn for `sbId`. Returns how many were running. */
export function cancelInklingTurns(sbId: string): number {
  const turns = live.get(sbId);
  if (!turns) return 0;
  // Counted first: a runner may return, and release its turn, inside abort().
  const running = turns.size;
  for (const turn of turns) turn.controller.abort();
  return running;
}

/** How many turns are live for `sbId` (for tests and logs). */
export function liveInklingTurns(sbId: string): number {
  return live.get(sbId)?.size ?? 0;
}

/** Whether `sbId` is working, stopping or idle in this process, and since when. */
export function inklingTurnActivity(sbId: string): InklingTurnActivity {
  const turns = [...(live.get(sbId) ?? [])];
  if (turns.length === 0) return { state: 'idle', since: null };
  const running = turns.filter((turn) => !turn.controller.signal.aborted);
  const behind = running.length > 0 ? running : turns;
  // Fixed-width ISO strings sort as the instants they name. The oldest is
  // found, not assumed from insertion order: the clock can step back.
  const since = behind.reduce(
    (oldest, turn) => (turn.startedAt < oldest ? turn.startedAt : oldest),
    behind[0].startedAt
  );
  return { state: running.length > 0 ? 'working' : 'stopping', since };
}
