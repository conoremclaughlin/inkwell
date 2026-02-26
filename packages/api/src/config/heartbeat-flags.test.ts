import { describe, expect, it } from 'vitest';
import { getHeartbeatProcessingConfig } from './heartbeat-flags';

describe('getHeartbeatProcessingConfig', () => {
  it('defaults to enabled when heartbeat flags are unset', () => {
    const result = getHeartbeatProcessingConfig({});
    expect(result.enabled).toBe(true);
  });

  it.each([
    { ENABLE_HEARTBEAT_SERVICE: 'false' },
    { ENABLE_HEARTBEAT_SERVICE: 'FALSE' },
    { ENABLE_HEARTBEAT_SERVICE: ' false ' },
    { ENABLE_HEARTBEAT_SERVICE: '0' },
    { ENABLE_HEARTBEATS: 'off' },
    { ENABLE_REMINDERS: 'no' },
  ])('disables heartbeat processing for false-like flag values: %o', (envVars) => {
    const result = getHeartbeatProcessingConfig(envVars);
    expect(result.enabled).toBe(false);
  });

  it('stays enabled for true-like values', () => {
    const result = getHeartbeatProcessingConfig({
      ENABLE_HEARTBEAT_SERVICE: 'true',
      ENABLE_HEARTBEATS: '1',
      ENABLE_REMINDERS: 'yes',
    });
    expect(result.enabled).toBe(true);
  });
});
