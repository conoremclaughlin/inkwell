/**
 * The same headless Ink session options, whether passed as CLI flags or to
 * the in-process composition. Resolve once at the host boundary: selecting
 * the hosted runner must not drop an inkling's policy or provider restrictions.
 */
import type { ClaudeRunnerConfig } from './types.js';

export const DEFAULT_MAX_TURNS = 5;

export function clampMaxTurns(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_TURNS;
  return Math.min(25, Math.max(1, Math.round(value)));
}

export function inkSessionOptions(config: Readonly<ClaudeRunnerConfig>) {
  const inkling = Boolean(config.inklingToolPolicyPath);
  return Object.freeze({
    ...(config.inkProvider ? { backend: config.inkProvider } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
    maxTurns: clampMaxTurns(config.maxTurns),
    toolRouting: config.toolRouting ?? 'local',
    profile: inkling ? ('inkling' as const) : ('safe' as const),
    ...(inkling
      ? { requireProfile: 'inkling' as const, toolPolicyPath: config.inklingToolPolicyPath! }
      : {}),
    withholdProviderTools: inkling,
    away: true as const,
    messageLabel: config.channel || 'server',
  });
}

export type InkSessionOptions = ReturnType<typeof inkSessionOptions>;
