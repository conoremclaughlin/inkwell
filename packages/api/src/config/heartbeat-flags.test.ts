import { describe, expect, it } from 'vitest';
import { getHeartbeatProcessingConfig } from './heartbeat-flags';

describe('getHeartbeatProcessingConfig', () => {
  it('defaults to enabled when heartbeat flags are unset', () => {
    const result = getHeartbeatProcessingConfig({});
    expect(result.enabled).toBe(true);
    expect(result.usedLegacyHeartbeatAlias).toBe(false);
    expect(result.conflictingHeartbeatServiceFlags).toBe(false);
  });

  it.each([
    { ENABLE_HEARTBEAT_SERVICE: 'false' },
    { ENABLE_HEARTBEAT_SERVICE: 'FALSE' },
    { ENABLE_HEARTBEAT_SERVICE: ' false ' },
    { ENABLE_HEARTBEAT_SERVICE: '0' },
    { ENABLE_REMINDERS: 'no' },
  ])('disables heartbeat processing for false-like flag values: %o', (envVars) => {
    const result = getHeartbeatProcessingConfig(envVars);
    expect(result.enabled).toBe(false);
  });

  it('supports legacy ENABLE_HEARTBEATS when ENABLE_HEARTBEAT_SERVICE is unset', () => {
    const result = getHeartbeatProcessingConfig({
      ENABLE_HEARTBEATS: 'off',
    });

    expect(result.enabled).toBe(false);
    expect(result.usedLegacyHeartbeatAlias).toBe(true);
  });

  it('prefers ENABLE_HEARTBEAT_SERVICE when both flags are set', () => {
    const result = getHeartbeatProcessingConfig({
      ENABLE_HEARTBEAT_SERVICE: 'true',
      ENABLE_HEARTBEATS: 'false',
    });

    expect(result.enabled).toBe(true);
    expect(result.conflictingHeartbeatServiceFlags).toBe(true);
  });

  it('stays enabled for true-like values', () => {
    const result = getHeartbeatProcessingConfig({
      ENABLE_HEARTBEAT_SERVICE: 'true',
      ENABLE_REMINDERS: 'yes',
    });
    expect(result.enabled).toBe(true);
  });
});
