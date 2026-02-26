export interface HeartbeatFlagValues {
  ENABLE_HEARTBEAT_SERVICE: string | undefined;
  ENABLE_HEARTBEATS: string | undefined;
  ENABLE_REMINDERS: string | undefined;
}

export interface HeartbeatProcessingConfig {
  enabled: boolean;
  flags: HeartbeatFlagValues;
  effectiveHeartbeatServiceFlag: string | undefined;
  usedLegacyHeartbeatAlias: boolean;
  conflictingHeartbeatServiceFlags: boolean;
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
    ENABLE_HEARTBEAT_SERVICE: envSource.ENABLE_HEARTBEAT_SERVICE,
    ENABLE_HEARTBEATS: envSource.ENABLE_HEARTBEATS,
    ENABLE_REMINDERS: envSource.ENABLE_REMINDERS,
  };

  const effectiveHeartbeatServiceFlag =
    flags.ENABLE_HEARTBEAT_SERVICE ?? flags.ENABLE_HEARTBEATS;
  const usedLegacyHeartbeatAlias =
    flags.ENABLE_HEARTBEAT_SERVICE === undefined && flags.ENABLE_HEARTBEATS !== undefined;
  const conflictingHeartbeatServiceFlags =
    flags.ENABLE_HEARTBEAT_SERVICE !== undefined &&
    flags.ENABLE_HEARTBEATS !== undefined &&
    normalize(flags.ENABLE_HEARTBEAT_SERVICE) !== normalize(flags.ENABLE_HEARTBEATS);

  return {
    flags,
    effectiveHeartbeatServiceFlag,
    usedLegacyHeartbeatAlias,
    conflictingHeartbeatServiceFlags,
    enabled:
      !isDisabled(effectiveHeartbeatServiceFlag) && !isDisabled(flags.ENABLE_REMINDERS),
  };
}
