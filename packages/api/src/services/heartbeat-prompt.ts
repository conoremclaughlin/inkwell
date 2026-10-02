/**
 * The prompt a heartbeat reminder wakes its SB with.
 *
 * Moved out of the server's deliver closure so it can be tested. An ordinary
 * firing gets exactly the text it always has. A firing inside quiet hours,
 * under the reminder's run-during-quiet-hours switch (task 2301cb3c), gets the
 * same header and a quiet-hours instruction in place of the "use
 * send_response" lines: under option B that instruction is the only thing
 * standing between an overnight run and a message on the user's phone.
 */

import type { DueReminder, HeartbeatDeliveryContext } from './heartbeat.js';
import { effectiveTimezone, localTimeOfDay } from './quiet-hours.js';

type PromptReminder = Pick<
  DueReminder,
  'title' | 'description' | 'delivery_channel' | 'delivery_target'
>;

export function buildHeartbeatReminderPrompt(
  reminder: PromptReminder,
  context?: HeartbeatDeliveryContext
): string {
  const header = `[HEARTBEAT REMINDER]
Title: ${reminder.title}
Description: ${reminder.description || 'No description'}
Delivery: ${reminder.delivery_channel} → ${reminder.delivery_target || 'default'}

---
IMPORTANT: This reminder was triggered by the heartbeat service.
Refer to your HEARTBEAT identity document for how to handle scheduled tasks.`;

  if (context?.quietHours) {
    const zone = effectiveTimezone(context.quietHours.timezone);
    const end = `${localTimeOfDay(new Date(context.quietHours.until), zone)} ${zone}`;
    return `${header}

QUIET HOURS are in effect until about ${end}. This reminder is set to run during them, for work you do on your own.
Do the work. Do NOT contact the user before ${end}: no send_response and no other message to them.
Leave anything they need to see where they will find it in the morning: a task, a memory, or the thread for this work.`;
  }

  return `${header}
If you need to message a user on Telegram, use send_response with:
- channel: "${reminder.delivery_channel}"
- conversationId: "${reminder.delivery_target}"

Do NOT just respond here — you MUST explicitly call send_response to reach external channels.`;
}
