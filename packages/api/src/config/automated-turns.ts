/**
 * How a server-spawned Claude turn is permitted (spec
 * automated-turn-permissions §3.1), decided by this server's configuration
 * and never by anything a turn can set.
 *
 * - `standard` (the default): a linked-worktree studio gets its profile at
 *   launch; the root studio and a spawn with no studio run on the
 *   checkout's own settings. What every server did before this setting.
 * - `yolo`: every automated Claude turn gets the automated rules at launch
 *   (`automatedLaunchRules`): no prompts for the everyday tools, with the
 *   ironclad denies kept. Conor, 2026-10-06: "I also just want the ability
 *   to set Inkwell to yolo mode for all automated turns."
 *
 * Read from `INK_AUTOMATED_TURNS` when asked, as execution-tier.ts is, so a
 * test can pass its own source. A value that doesn't parse runs `standard`:
 * the narrower choice, and `problem` says so without echoing the value.
 * Blank or whitespace alone is unset. Turning it on is the operator's call;
 * changing it takes a restart.
 */

type EnvSource = Record<string, string | undefined>;

export const AUTOMATED_TURN_MODES = ['standard', 'yolo'] as const;
export type AutomatedTurnMode = (typeof AUTOMATED_TURN_MODES)[number];

export interface AutomatedTurnDecision {
  mode: AutomatedTurnMode;
  from: 'deployment' | 'default' | 'malformed';
  problem?: string;
}

export function automatedTurnMode(env: EnvSource = process.env): AutomatedTurnDecision {
  const raw = env.INK_AUTOMATED_TURNS?.trim().toLowerCase();
  if (!raw) return { mode: 'standard', from: 'default' };
  if ((AUTOMATED_TURN_MODES as readonly string[]).includes(raw)) {
    return { mode: raw as AutomatedTurnMode, from: 'deployment' };
  }
  return {
    mode: 'standard',
    from: 'malformed',
    problem: `INK_AUTOMATED_TURNS is not one of ${AUTOMATED_TURN_MODES.join(', ')}`,
  };
}
