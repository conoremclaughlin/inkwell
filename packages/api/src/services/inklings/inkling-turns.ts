/**
 * The inkling turns running in this server process, so an owner can cancel
 * one (POST /api/admin/inklings/:id/cancel). processMessage tracks each
 * inkling turn from just before its spawn until the runner returns; the
 * runner stops the process (and its process group) when the signal aborts.
 * In-process only: a turn started by another server process is not here.
 */

const live = new Map<string, Set<AbortController>>();

/** Track one turn for `sbId`. Call `done()` when the runner has returned. */
export function trackInklingTurn(sbId: string): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const turns = live.get(sbId) ?? new Set<AbortController>();
  turns.add(controller);
  live.set(sbId, turns);
  return {
    signal: controller.signal,
    done: () => {
      turns.delete(controller);
      if (turns.size === 0 && live.get(sbId) === turns) live.delete(sbId);
    },
  };
}

/** Abort every live turn for `sbId`. Returns how many were running. */
export function cancelInklingTurns(sbId: string): number {
  const turns = live.get(sbId);
  if (!turns) return 0;
  for (const controller of turns) controller.abort();
  return turns.size;
}

/** How many turns are live for `sbId` (for tests and logs). */
export function liveInklingTurns(sbId: string): number {
  return live.get(sbId)?.size ?? 0;
}
