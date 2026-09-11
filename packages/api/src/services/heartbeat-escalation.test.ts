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

const AUTH_ERROR = 'Backend claude is not authenticated (not logged in)';

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

      await onFailure(makeReminder(), AUTH_ERROR, 1);

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
        1
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
        1
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

      await expect(onFailure(makeReminder(), AUTH_ERROR, 1)).resolves.toBeUndefined();
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

      await onFailure(makeReminder(), AUTH_ERROR, 1);
      expect(sendToChannel).toHaveBeenCalledTimes(1);
    });

    it('goes quiet on continuing failures while still recording them', async () => {
      const { client, insert } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      for (const consecutive of [2, 3, 4, 5, 6, 7, 8]) {
        await onFailure(makeReminder(), AUTH_ERROR, consecutive);
      }

      // Myra's twelve hours: eight failures, one alert (sent on beat 1), and
      // eight durable inbox rows.
      expect(sendToChannel).not.toHaveBeenCalled();
      expect(insert).toHaveBeenCalledTimes(7);
    });

    it('sends exactly one recovery notice carrying the outage length', async () => {
      const { client } = makeClient();
      const { onRecovery } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      await onRecovery(makeReminder(), 8);

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

      await expect(onRecovery(makeReminder(), 3)).resolves.toBeUndefined();
    });
  });

  describe('the inbox write is checked', () => {
    // PostgREST resolves with `{ error }` rather than throwing. Discarding it
    // reproduced the silence bug one level up, inside its own fix: a 403
    // logged as a successful escalation.
    it('throws when the inbox insert resolves with an error', async () => {
      const { client } = makeClient({
        insertResult: { error: { message: 'permission denied for table agent_inbox' } },
      });
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      await expect(onFailure(makeReminder(), AUTH_ERROR, 1)).rejects.toThrow(/permission denied/);
    });

    it('does not report an alert as sent when the inbox write failed', async () => {
      const { client } = makeClient({
        insertResult: { error: { message: 'HTTP 403' } },
      });
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      await expect(onFailure(makeReminder(), AUTH_ERROR, 1)).rejects.toThrow();
      // It failed before reaching the channel — processHeartbeat's guarded
      // wrapper logs it rather than the escalation claiming success.
      expect(sendToChannel).not.toHaveBeenCalled();
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

      await onFailure(makeReminder(), AUTH_ERROR, 1);

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

      await onFailure(makeReminder({ sb_id: null }), AUTH_ERROR, 1);

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

      await onFailure(makeReminder(), AUTH_ERROR, 1);
      expect(insert).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 'high' }));

      await onFailure(makeReminder(), AUTH_ERROR, 3);
      expect(insert).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 'urgent' }));
    });

    it('carries the real error, not a placeholder', async () => {
      const { client, insert } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultAgentId: 'myra',
      });

      await onFailure(makeReminder(), AUTH_ERROR, 2);

      const row = insert.mock.calls[0][0] as { content: string; subject: string };
      expect(row.content).toContain(AUTH_ERROR);
      expect(row.content).not.toContain('Delivery callback returned false');
      expect(row.subject).toContain('2x');
    });
  });
});
