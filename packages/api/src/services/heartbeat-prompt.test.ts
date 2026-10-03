import { describe, expect, it } from 'vitest';
import { buildHeartbeatReminderPrompt } from './heartbeat-prompt.js';

const REMINDER = {
  title: 'Overnight check',
  description: 'Look at the build queue',
  delivery_channel: 'telegram',
  delivery_target: '123456789',
};

/**
 * The text server.ts sent before the prompt moved into this module, copied
 * verbatim. An ordinary firing must keep sending exactly this.
 */
const LEGACY = `[HEARTBEAT REMINDER]
Title: Overnight check
Description: Look at the build queue
Delivery: telegram → 123456789

---
IMPORTANT: This reminder was triggered by the heartbeat service.
Refer to your HEARTBEAT identity document for how to handle scheduled tasks.
If you need to message a user on Telegram, use send_response with:
- channel: "telegram"
- conversationId: "123456789"

Do NOT just respond here — you MUST explicitly call send_response to reach external channels.`;

describe('buildHeartbeatReminderPrompt', () => {
  it('an ordinary firing gets the legacy text byte for byte', () => {
    expect(buildHeartbeatReminderPrompt(REMINDER)).toBe(LEGACY);
    expect(buildHeartbeatReminderPrompt(REMINDER, {})).toBe(LEGACY);
  });

  it('a quiet-hours firing is told when quiet hours end and not to contact the user', () => {
    const prompt = buildHeartbeatReminderPrompt(REMINDER, {
      quietHours: { until: '2026-09-02T15:00:00.000Z', timezone: 'America/Los_Angeles' },
    });

    expect(prompt).toContain('QUIET HOURS are in effect until about 08:00 America/Los_Angeles');
    expect(prompt).toContain('Do NOT contact the user before 08:00 America/Los_Angeles');
    // The send_response instructions are gone, not merely outweighed.
    expect(prompt).not.toContain('use send_response with');
    expect(prompt).not.toContain('conversationId');
    // Same header as an ordinary firing.
    expect(prompt.startsWith('[HEARTBEAT REMINDER]\nTitle: Overnight check')).toBe(true);
  });
});
