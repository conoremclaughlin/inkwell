import { describe, expect, it } from 'vitest';
import { getHeartbeatProcessingConfig } from './heartbeat-flags';

describe('getHeartbeatProcessingConfig', () => {
  it('defaults to enabled when heartbeat flags are unset', () => {
    const result = getHeartbeatProcessingConfig({});
    expect(result.enabled).toBe(true);
  });

  it.each([
    { ENABLE_HEARTBEATS: 'false' },
    { ENABLE_HEARTBEATS: 'FALSE' },
    { ENABLE_HEARTBEATS: ' false ' },
    { ENABLE_HEARTBEATS: '0' },
    { ENABLE_REMINDERS: 'no' },
  ])('disables heartbeat processing for false-like flag values: %o', (envVars) => {
    const result = getHeartbeatProcessingConfig(envVars);
    expect(result.enabled).toBe(false);
  });

  it('stays enabled for true-like values', () => {
    const result = getHeartbeatProcessingConfig({
      ENABLE_HEARTBEATS: 'true',
      ENABLE_REMINDERS: 'yes',
    });
    expect(result.enabled).toBe(true);
  });
});
