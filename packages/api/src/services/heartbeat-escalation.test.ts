/**
 * Tests for the heartbeat escalation implementation.
 *
 * These exist because the first round of #606 tested a MOCKED hook — they
 * proved `onFailure` was called, which is a fact about processHeartbeat, not
 * about whether a notice reaches anyone. Lumen's review found two real defects
 * living in the untested implementation: a discarded PostgREST error reporting
 * success, and no path to the human at all. Both are covered here, against the
 * real `createHeartbeatEscalation`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHeartbeatEscalation } from './heartbeat-escalation.js';
import type { DueReminder } from './heartbeat.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** The escalation context of the first beat to reach a destination in a run. */
const FIRST_FOR_DESTINATION = {
  destinationAlreadyAlerted: false,
  episodeKey: '2026-09-09T00:00:00.000Z',
  destination: 'sb-myra-uuid|telegram|123456789',
};

const AUTH_ERROR = 'Backend claude is not authenticated (not logged in)';

/**
 * In-memory stand-in for the notification store.
 *
 * Deliberately a real implementation of the interface rather than a mocked
 * query builder. A builder mock answers every question the same way — which is
 * exactly how the streak bug (`order('created_at')` on a table with no such
 * column) survived sixty-one passing tests. This one can actually be wrong, so
 * a test against it can actually fail.
 */
function makeFakeStore(seed: Record<string, { status: string; attempts: number }> = {}) {
  const rows = new Map<string, { status: string; attempts: number; failedBeats: number }>(
    Object.entries(seed).map(([k, v]) => [k, { ...v, failedBeats: 0 }])
  );
  const keyOf = (k: { reminderId: string; kind: string; episodeKey: string }) =>
    `${k.reminderId}|${k.kind}|${k.episodeKey}`;

  const store = {
    rows,
    claimNotice: vi.fn(async (key: never) => {
      const k = keyOf(key);
      let row = rows.get(k);
      if (!row) {
        row = {
          status: 'pending',
          attempts: 0,
          failedBeats: (key as never as { failedBeats?: number }).failedBeats ?? 0,
        };
        rows.set(k, row);
      }
      const record = { id: k, status: row.status as never, attempts: row.attempts };
      if (row.status === 'delivered' || row.status === 'exhausted' || row.attempts >= 3) {
        return { shouldSend: false, record };
      }
      return { shouldSend: true, record };
    }),
    settleNotice: vi.fn(async (key: never, outcome: { delivered: boolean; error?: string }) => {
      const k = keyOf(key);
      const row = rows.get(k) ?? { status: 'pending', attempts: 0, failedBeats: 0 };
      row.attempts += 1;
      row.status = outcome.delivered ? 'delivered' : row.attempts >= 3 ? 'exhausted' : 'pending';
      rows.set(k, row);
    }),
    markCoveredBySibling: vi.fn(async (key: never) => {
      const k = keyOf(key);
      const row = rows.get(k) ?? { status: 'pending', attempts: 0, failedBeats: 0 };
      row.status = 'delivered';
      rows.set(k, row);
    }),
    findRetryableRecovery: vi.fn(async (reminderId: string) => {
      for (const [k, row] of rows) {
        const [rid, kind, episodeKey] = k.split('|');
        if (
          rid === reminderId &&
          kind === 'recovery' &&
          row.status === 'pending' &&
          row.attempts < 3
        ) {
          return {
            id: k,
            status: row.status as never,
            attempts: row.attempts,
            episodeKey,
            destination: null,
            failedBeats: row.failedBeats,
          };
        }
      }
      return null;
    }),
  };
  return store;
}

function makeReminder(overrides: Partial<DueReminder> = {}): DueReminder {
  return {
    id: 'rem-001',
    user_id: 'user-1',
    title: 'Check emails',
    description: 'Check for important emails',
    delivery_channel: 'telegram',
    delivery_target: '123456789',
    sb_id: 'sb-myra-uuid',
    cron_expression: '0 * * * *',
    next_run_at: new Date().toISOString(),
    run_count: 0,
    max_runs: null,
    studio_hint: null,
    metadata: null,
    ...overrides,
  };
}

/**
 * Minimal Supabase double. `insertResult` is what the `agent_inbox` insert
 * RESOLVES with — PostgREST reports failures this way rather than throwing,
 * which is the entire point of one of these tests.
 */
function makeClient(opts: { insertResult?: { error: { message: string } | null } } = {}) {
  const insert = vi.fn().mockResolvedValue(opts.insertResult ?? { error: null });
  const identitySingle = vi.fn().mockResolvedValue({ data: { agent_id: 'myra' }, error: null });

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'agent_identities') {
      return {
        select: () => ({ eq: () => ({ single: identitySingle }) }),
      };
    }
    return { insert };
  });

  return { client: { from } as never, insert, from };
}

describe('heartbeat escalation', () => {
  let sendToChannel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sendToChannel = vi.fn().mockResolvedValue(undefined);
  });

  describe('the human actually hears about it', () => {
    // The P1. The failure being reported is "this SB could not start", and
    // reading an inbox requires the SB to start. An inbox-only notice is the
    // identical outcome to doing nothing, with more rows in a table.
    it('sends an outage alert over the channel, not only to the inbox', async () => {
      const { client, insert } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      await onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);

      expect(insert).toHaveBeenCalledTimes(1);
      expect(sendToChannel).toHaveBeenCalledTimes(1);
      const sent = sendToChannel.mock.calls[0][0];
      expect(sent.channel).toBe('telegram');
      expect(sent.conversationId).toBe('123456789');
      expect(sent.content).toContain('Check emails');
      expect(sent.content).toContain(AUTH_ERROR);
    });

    // The destination is the reminder's OWN configured channel — the one it
    // was going to deliver to anyway. No new notification surface is invented.
    it('alerts on the channel the reminder was configured to deliver to', async () => {
      const { client } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      await onFailure(
        makeReminder({ delivery_channel: 'discord', delivery_target: 'chan-42' }),
        AUTH_ERROR,
        1,
        FIRST_FOR_DESTINATION
      );

      expect(sendToChannel.mock.calls[0][0]).toMatchObject({
        channel: 'discord',
        conversationId: 'chan-42',
      });
    });

    it('does not alert over the internal heartbeat pseudo-channel', async () => {
      const { client, insert } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      await onFailure(
        makeReminder({ delivery_channel: 'heartbeat', delivery_target: null }),
        AUTH_ERROR,
        1,
        FIRST_FOR_DESTINATION
      );

      // A notice sent there would land right back in the broken path. The
      // durable inbox copy still happens.
      expect(sendToChannel).not.toHaveBeenCalled();
      expect(insert).toHaveBeenCalledTimes(1);
    });

    it('still writes the inbox copy when the channel send throws', async () => {
      const { client, insert } = makeClient();
      sendToChannel.mockRejectedValue(new Error('telegram unreachable'));
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      await expect(
        onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION)
      ).resolves.toEqual({ alerted: false });
      expect(insert).toHaveBeenCalledTimes(1);
    });
  });

  describe('one outage is two messages, not two per beat', () => {
    it('alerts on the first failure only', async () => {
      const { client } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      await onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);
      expect(sendToChannel).toHaveBeenCalledTimes(1);
    });

    it('goes quiet on continuing failures once the alert has been DELIVERED', async () => {
      const { client, insert } = makeClient();
      const store = makeFakeStore();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
        store,
      });

      // Beat 1 alerts and the send succeeds. Beats 2..8 stay quiet because a
      // notice for this episode was DELIVERED — not because the streak is >1,
      // which is what the first version keyed off and which says nothing about
      // whether anyone was told.
      for (const consecutive of [1, 2, 3, 4, 5, 6, 7, 8]) {
        await onFailure(makeReminder(), AUTH_ERROR, consecutive, FIRST_FOR_DESTINATION);
      }

      // Myra's twelve hours: eight failures, one alert, eight durable rows.
      expect(sendToChannel).toHaveBeenCalledTimes(1);
      expect(insert).toHaveBeenCalledTimes(8);
    });

    it('sends exactly one recovery notice carrying the outage length', async () => {
      const { client } = makeClient();
      const { onRecovery } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      await onRecovery(makeReminder(), 8, FIRST_FOR_DESTINATION);

      expect(sendToChannel).toHaveBeenCalledTimes(1);
      const sent = sendToChannel.mock.calls[0][0];
      expect(sent.content).toContain('Check emails');
      expect(sent.content).toContain('8');
      expect(sent.channel).toBe('telegram');
    });

    it('does not throw when the recovery notice cannot be delivered', async () => {
      const { client } = makeClient();
      sendToChannel.mockRejectedValue(new Error('telegram unreachable'));
      const { onRecovery } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      await expect(onRecovery(makeReminder(), 3, FIRST_FOR_DESTINATION)).resolves.toEqual({
        alerted: false,
      });
    });
  });

  describe('the two destinations are independent', () => {
    // PostgREST resolves with `{ error }` rather than throwing. Discarding it
    // reproduced the silence bug one level up: a 403 logged as a successful
    // escalation. But THROWING on it was the opposite overcorrection — it
    // exited before the channel attempt, so the durable copy (which cannot
    // reach a human on its own) could cancel the one that can.
    it('still alerts the channel when the inbox insert resolves with an error', async () => {
      const { client } = makeClient({
        insertResult: { error: { message: 'permission denied for table agent_inbox' } },
      });
      const store = makeFakeStore();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
        store,
      });

      const result = await onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);

      // The inbox failing is exactly when the channel matters most.
      expect(sendToChannel).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ alerted: true });
    });

    it('does not throw when the inbox write fails', async () => {
      const { client } = makeClient({
        insertResult: { error: { message: 'HTTP 403' } },
      });
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
        store: makeFakeStore(),
      });

      await expect(
        onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION)
      ).resolves.toEqual({ alerted: true });
    });

    it('still writes the durable copy when the channel send fails', async () => {
      const { client, insert } = makeClient();
      sendToChannel.mockRejectedValue(new Error('telegram unreachable'));
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
        store: makeFakeStore(),
      });

      const result = await onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);

      expect(insert).toHaveBeenCalledTimes(1);
      // Attempted is not delivered. This is what stops the destination being
      // claimed and the sibling beat being silenced for nothing.
      expect(result).toEqual({ alerted: false });
    });
  });

  describe('addressing', () => {
    it('files the notice under the agent whose beat failed', async () => {
      const { client, insert } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'fallback-agent',
      });

      await onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);

      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({ recipient_agent_id: 'myra', recipient_user_id: 'user-1' })
      );
    });

    it('falls back to the server agent when the reminder has no sb_id', async () => {
      const { client, insert } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'fallback-agent',
      });

      await onFailure(makeReminder({ sb_id: null }), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);

      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({ recipient_agent_id: 'fallback-agent' })
      );
    });

    it('escalates priority once an outage is established', async () => {
      const { client, insert } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      await onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);
      expect(insert).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 'high' }));

      await onFailure(makeReminder(), AUTH_ERROR, 3, FIRST_FOR_DESTINATION);
      expect(insert).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 'urgent' }));
    });

    it('carries the real error, not a placeholder', async () => {
      const { client, insert } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      await onFailure(makeReminder(), AUTH_ERROR, 2, FIRST_FOR_DESTINATION);

      const row = insert.mock.calls[0][0] as { content: string; subject: string };
      expect(row.content).toContain(AUTH_ERROR);
      expect(row.content).not.toContain('Delivery callback returned false');
      expect(row.subject).toContain('2x');
    });
  });

  /**
   * The second half of Myra's finding. `heartbeat.ts` decides WHICH beat owns
   * the destination this run; these assert what the escalation does once told.
   */
  describe('sibling beats sharing one destination', () => {
    const ALREADY_ALERTED = {
      destinationAlreadyAlerted: true,
      episodeKey: '2026-09-09T00:00:00.000Z',
      destination: 'sb-myra-uuid|telegram|123456789',
    };

    it('writes the inbox row but sends no second outage alert', async () => {
      const { client, insert } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      await onFailure(makeReminder(), AUTH_ERROR, 1, ALREADY_ALERTED);

      // Durable record kept: this beat did stop, and its own failure is worth
      // finding later. Only the duplicate Telegram message is dropped.
      expect(insert).toHaveBeenCalledTimes(1);
      expect(sendToChannel).not.toHaveBeenCalled();
    });

    it('sends no second all-clear either', async () => {
      const { client } = makeClient();
      const { onRecovery } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      await onRecovery(makeReminder(), 8, ALREADY_ALERTED);

      // Otherwise the beats that alarmed in pairs also clear in pairs, and the
      // fix for duplicate alarms ships duplicate all-clears.
      expect(sendToChannel).not.toHaveBeenCalled();
    });

    it('still alerts when this beat is the first to the destination', async () => {
      const { client } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      await onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);

      // The guard must not be able to silence the alert that matters — this is
      // the case the whole module exists for.
      expect(sendToChannel).toHaveBeenCalledTimes(1);
    });

    // Round three's P1, from the other side. If a sibling's alert covered this
    // destination, THIS episode has to be recorded as covered too — otherwise
    // the suppressed beat finds its own notice unsent and alerts on its next
    // tick, which is the duplicate arriving one beat late.
    it('records the episode as covered so the silenced sibling stays silent later', async () => {
      const { client } = makeClient();
      const store = makeFakeStore();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
        store,
      });

      await onFailure(makeReminder(), AUTH_ERROR, 1, ALREADY_ALERTED);
      expect(store.markCoveredBySibling).toHaveBeenCalledTimes(1);

      // Next beat of the same outage, now first to the destination: still quiet.
      await onFailure(makeReminder(), AUTH_ERROR, 2, FIRST_FOR_DESTINATION);
      expect(sendToChannel).not.toHaveBeenCalled();
    });
  });

  /**
   * Lumen's round-two and round-three P1s, which are one defect seen twice:
   * suppression keyed off an ATTEMPT rather than an OUTCOME. Each of these is
   * red against the `consecutive > 1` implementation.
   */
  describe('silence is earned by delivery, not by having tried', () => {
    it('RETRIES on the next beat when the first alert failed to send', async () => {
      const { client } = makeClient();
      const store = makeFakeStore();
      sendToChannel.mockRejectedValueOnce(new Error('telegram unreachable'));
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
        store,
      });

      // Beat 1: the send rejects. Under `consecutive > 1` this failure was
      // already in reminder_history, so every later beat went quiet forever.
      const first = await onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);
      expect(first).toEqual({ alerted: false });

      // Beat 2: the notice is still undelivered, so it must go out again.
      const second = await onFailure(makeReminder(), AUTH_ERROR, 2, FIRST_FOR_DESTINATION);
      expect(second).toEqual({ alerted: true });
      expect(sendToChannel).toHaveBeenCalledTimes(2);
    });

    it('announces an outage that was already underway before this deploy', async () => {
      const { client } = makeClient();
      const store = makeFakeStore();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
        store,
      });

      // A streak of 9 with no notice ever delivered — the state Myra's twelve
      // hours actually left behind. The old guard read `consecutive > 1` and
      // said nothing at all.
      const result = await onFailure(makeReminder(), AUTH_ERROR, 9, FIRST_FOR_DESTINATION);

      expect(result).toEqual({ alerted: true });
      expect(sendToChannel).toHaveBeenCalledTimes(1);
    });

    it('stops retrying after the bounded number of attempts', async () => {
      const { client } = makeClient();
      const store = makeFakeStore();
      sendToChannel.mockRejectedValue(new Error('telegram gone for good'));
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
        store,
      });

      for (const consecutive of [1, 2, 3, 4, 5, 6]) {
        await onFailure(makeReminder(), AUTH_ERROR, consecutive, FIRST_FOR_DESTINATION);
      }

      // Three attempts, then the notice is exhausted and we stop — a dead
      // channel becomes one logged give-up, not an unbounded retry loop.
      expect(sendToChannel).toHaveBeenCalledTimes(3);
    });

    it('retries an all-clear whose send failed', async () => {
      const { client } = makeClient();
      const store = makeFakeStore();
      sendToChannel.mockRejectedValueOnce(new Error('telegram unreachable'));
      const { onRecovery } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
        store,
      });

      const first = await onRecovery(makeReminder(), 8, FIRST_FOR_DESTINATION);
      expect(first).toEqual({ alerted: false });

      // The pending recovery notice is still owed. `processHeartbeat` sweeps for
      // it on a later healthy beat and calls back in on the same episode key.
      const retried = await onRecovery(makeReminder(), 8, FIRST_FOR_DESTINATION);
      expect(retried).toEqual({ alerted: true });
      expect(sendToChannel).toHaveBeenCalledTimes(2);
    });

    it('stays quiet once the all-clear has actually landed', async () => {
      const { client } = makeClient();
      const store = makeFakeStore();
      const { onRecovery } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
        store,
      });

      await onRecovery(makeReminder(), 8, FIRST_FOR_DESTINATION);
      await onRecovery(makeReminder(), 8, FIRST_FOR_DESTINATION);

      // Positive control for the retry above: delivery, and only delivery,
      // buys silence.
      expect(sendToChannel).toHaveBeenCalledTimes(1);
    });

    it('never creates an acknowledgement row for a beat with no external destination', async () => {
      const { client } = makeClient();
      const store = makeFakeStore();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
        store,
      });

      const result = await onFailure(
        makeReminder({ delivery_channel: 'heartbeat' }),
        AUTH_ERROR,
        1,
        FIRST_FOR_DESTINATION
      );

      expect(result).toEqual({ alerted: false });
      expect(sendToChannel).not.toHaveBeenCalled();
      // Nothing to satisfy, so nothing to record — otherwise every such beat
      // accrues a row that can only ever be marked exhausted.
      expect(store.claimNotice).not.toHaveBeenCalled();
    });
  });
});
