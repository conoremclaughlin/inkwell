export interface HeartbeatFlagValues {
  ENABLE_HEARTBEATS: string | undefined;
  ENABLE_REMINDERS: string | undefined;
}

export interface HeartbeatProcessingConfig {
  enabled: boolean;
  flags: HeartbeatFlagValues;
}

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no']);

function normalize(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim().toLowerCase();
}

function isDisabled(value: string | undefined): boolean {
  const normalized = normalize(value);
  if (normalized === undefined) return false;
  return DISABLED_VALUES.has(normalized);
}

export function getHeartbeatProcessingConfig(
  envSource: NodeJS.ProcessEnv = process.env
): HeartbeatProcessingConfig {
  const flags: HeartbeatFlagValues = {
    ENABLE_HEARTBEATS: envSource.ENABLE_HEARTBEATS,
    ENABLE_REMINDERS: envSource.ENABLE_REMINDERS,
  };

  return {
    flags,
    enabled: !isDisabled(flags.ENABLE_HEARTBEATS) && !isDisabled(flags.ENABLE_REMINDERS),
  };
}
