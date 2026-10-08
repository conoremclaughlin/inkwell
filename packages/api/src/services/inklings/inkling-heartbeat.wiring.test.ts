import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/**
 * Source-level pin of the one place a due reminder reaches an inkling: the
 * scheduler's delivery callback in server.ts, which builds no request of its
 * own for an inkling's heartbeat and hands it to deliverInklingHeartbeat
 * (inkling-heartbeat.test.ts proves that half). Without the branch, the beat
 * would take the generic path, with no conversation and no admission, and
 * every one would be refused at the gate.
 */
const server = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');

describe("the scheduler's delivery callback", () => {
  const callback = server.indexOf('const deliverReminderViaSession = async (');
  const generic = server.indexOf("channel: 'heartbeat',", callback);

  it('exists once, with its generic heartbeat request after it', () => {
    expect(callback).toBeGreaterThan(-1);
    expect(server.indexOf('const deliverReminderViaSession = async (', callback + 1)).toBe(-1);
    expect(generic).toBeGreaterThan(callback);
  });

  it("hands an inkling's heartbeat to its own delivery, with the firing's context, before the generic path", () => {
    const body = server.slice(callback, generic);
    expect(body).toMatch(
      /if \(isInklingHeartbeatReminder\(reminder\)\) \{[\s\S]*?return deliverInklingHeartbeat\(\s*\{\s*supabase: dataComposer\.getClient\(\),\s*handleMessage: \(request\) => sessionService!\.handleMessage\(request\),\s*\},\s*reminder,\s*deliveryContext\s*\);\s*\}/
    );
  });
});
