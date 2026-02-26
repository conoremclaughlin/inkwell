export interface HeartbeatFlagValues {
  ENABLE_HEARTBEAT_SERVICE: string | undefined;
  ENABLE_HEARTBEATS: string | undefined;
  ENABLE_REMINDERS: string | undefined;
}

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no']);

function isDisabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return DISABLED_VALUES.has(value.trim().toLowerCase());
}

export function getHeartbeatProcessingConfig(envSource: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  flags: HeartbeatFlagValues;
} {
  const flags: HeartbeatFlagValues = {
    ENABLE_HEARTBEAT_SERVICE: envSource.ENABLE_HEARTBEAT_SERVICE,
    ENABLE_HEARTBEATS: envSource.ENABLE_HEARTBEATS,
    ENABLE_REMINDERS: envSource.ENABLE_REMINDERS,
  };

  return {
    flags,
    enabled:
      !isDisabled(flags.ENABLE_HEARTBEAT_SERVICE) &&
      !isDisabled(flags.ENABLE_HEARTBEATS) &&
      !isDisabled(flags.ENABLE_REMINDERS),
  };
}
