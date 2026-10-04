/**
 * An inkling whose turn was stopped without confirming that its processes
 * had gone is fenced: no new turn is admitted for it until that group is
 * observed gone. A replacement turn must not run beside work the stopped one
 * may still be doing (Lumen, inkling:thread:app-build 42298771).
 *
 * Each unconfirmed stop is its own entry, so a second one for the same
 * inkling (it can run in two conversations at once) never replaces the
 * first. An entry is released by one observation only, made at admission
 * against that entry's own group: its number probes ESRCH, so no process
 * holds it. A process a member forked inherits the group, so that covers
 * descendants a snapshot of members could miss (Lumen eeb45589, accepted in
 * scope 4c53e199). A live probe, EPERM or any other error, or an entry with
 * no valid group number, keeps it held. The probe is signal 0: nothing is
 * delivered, and nothing here ever signals a recorded group.
 *
 * Its limits, stated rather than assumed safe: the fence lives in this
 * server process, and a restart loses it without that being evidence of
 * cleanup; a process that left the group (its own session) was never
 * covered; and a group number taken by an unrelated group keeps the entry
 * held. The model is one host's process groups as this server can see them.
 */

import type { RunnerResult } from '../sessions/types';
import { isGroupId, probeGroup } from '../sessions/stop-process';

type Unconfirmed = NonNullable<RunnerResult['stopUnconfirmed']>;

/** Per inkling: its unconfirmed stops, by the order they were recorded. */
const fences = new Map<string, Map<number, Unconfirmed>>();
let nextEntry = 1;

/** Record an unconfirmed stop for `sbId`. Every stop is an entry of its own. */
export function fenceInkling(sbId: string, stop: Unconfirmed): void {
  const entries = fences.get(sbId) ?? new Map<number, Unconfirmed>();
  entries.set(nextEntry++, stop);
  fences.set(sbId, entries);
}

/**
 * Whether `sbId` is still fenced. Each entry is looked at again first, and
 * released only when its own group probes ESRCH; the inkling stays fenced
 * while any entry remains.
 */
export function inklingFenceHolds(sbId: string): boolean {
  const entries = fences.get(sbId);
  if (!entries) return false;
  for (const [entry, stop] of entries) {
    if (isGroupId(stop.pgid) && probeGroup(stop.pgid) === 'empty') entries.delete(entry);
  }
  if (entries.size > 0) return true;
  fences.delete(sbId);
  return false;
}

/** For tests: forget every fence. */
export function clearInklingFences(): void {
  fences.clear();
}
