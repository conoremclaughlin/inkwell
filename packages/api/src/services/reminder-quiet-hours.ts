/**
 * Which reminders may run during the user's quiet hours.
 *
 * Conor, 2026-10-02 ("Yes, do want that"): a reminder can opt in to running
 * overnight, for work an SB does on its own (option B; task 2301cb3c, spec
 * ink://specs/addressed-reminders §8). Every other reminder is still held until
 * the window ends, exactly as before.
 *
 * The scheduler and the tool that sets the switch both ask this module, so the
 * refusal a caller sees and the behaviour the scheduler applies cannot drift.
 */

import type { Json } from '../data/supabase/types.js';

/**
 * Strategy watchdogs are refused the switch in B.
 *
 * A watchdog fires through StrategyService.triggerWatchdog, which builds its
 * own prompt and never reaches the generic heartbeat prompt. That prompt is
 * where the do-not-contact instruction goes, and it is B's only safeguard
 * against an SB messaging the user at 3 AM. A switch-on watchdog would run
 * overnight without it. Watchdogs gain overnight runs when they become
 * addressed reminders (task c52fccfd), whose prompt carries the instruction.
 */
export const WATCHDOG_QUIET_HOURS_REFUSAL =
  'runDuringQuietHours cannot be set on a strategy watchdog reminder. Its prompt comes from the ' +
  'strategy service, which does not carry the quiet-hours instruction, so it would run overnight ' +
  'without being told not to contact the user. Watchdogs get overnight runs when they become ' +
  'addressed reminders (task c52fccfd).';

export function isStrategyWatchdog(metadata: Json | null | undefined): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  return (metadata as Record<string, unknown>).strategyWatchdog === true;
}

/**
 * Whether the scheduler may fire this reminder inside quiet hours.
 *
 * The watchdog exclusion is applied here as well as at the tool, so a flag set
 * on a watchdog row by some other path is still held.
 */
export function mayRunDuringQuietHours(reminder: {
  run_during_quiet_hours?: boolean | null;
  metadata?: Json | null;
}): boolean {
  return reminder.run_during_quiet_hours === true && !isStrategyWatchdog(reminder.metadata);
}
