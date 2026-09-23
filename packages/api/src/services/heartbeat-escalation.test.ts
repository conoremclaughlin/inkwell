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
import { backoffForAttempt } from './heartbeat-notification-store.js';
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

interface FakeRow {
  status: string;
  attempts: number;
  failedBeats: number;
  nextAttemptAt: number | null;
  episodeClosedAt: string | null;
}

/**
 * In-memory stand-in for the notification store.
 *
 * Deliberately a real implementation of the interface rather than a mocked
 * query builder. A builder mock answers every question the same way — which is
 * exactly how the streak bug (`order('created_at')` on a table with no such
 * column) survived sixty-one passing tests. This one can actually be wrong, so
 * a test against it can actually fail.
 *
 * It mirrors the real store's rules, including the two that round four turned
 * on: a notice is gated by `nextAttemptAt` backoff rather than retired by an
 * attempt cap, and an owed all-clear is found from the OUTAGE row's open
 * episode rather than from a pending recovery row.
 */
function makeFakeStore(seed: Record<string, Partial<FakeRow>> = {}) {
  const rows = new Map<string, FakeRow>(
    Object.entries(seed).map(([k, v]) => [
      k,
      {
        status: 'pending',
        attempts: 0,
        failedBeats: 0,
        nextAttemptAt: null,
        episodeClosedAt: null,
        ...v,
      },
    ])
  );
  const keyOf = (k: { reminderId: string; kind: string; episodeKey: string }) =>
    `${k.reminderId}|${k.kind}|${k.episodeKey}`;

  const store = {
    rows,
    openEpisode: vi.fn(async (reminderId: string) => {
      for (const [k, row] of rows) {
        const [rid, kind, episodeKey] = k.split('|');
        if (rid === reminderId && kind === 'outage' && !row.episodeClosedAt) return episodeKey;
      }
      return `minted-${reminderId}-${rows.size}`;
    }),
    claimNotice: vi.fn(async (key: never) => {
      const k = keyOf(key);
      let row = rows.get(k);
      if (!row) {
        row = {
          status: 'pending',
          attempts: 0,
          failedBeats: (key as never as { failedBeats?: number }).failedBeats ?? 0,
          nextAttemptAt: null,
          episodeClosedAt: null,
        };
        rows.set(k, row);
      }
      const record = { id: k, status: row.status as never, attempts: row.attempts };
      if (row.status === 'delivered') return { shouldSend: false, record };
      if (row.nextAttemptAt !== null && row.nextAttemptAt > Date.now()) {
        return { shouldSend: false, record };
      }
      return { shouldSend: true, record };
    }),
    settleNotice: vi.fn(async (key: never, outcome: { delivered: boolean; error?: string }) => {
      const k = keyOf(key);
      const row = rows.get(k) ?? {
        status: 'pending',
        attempts: 0,
        failedBeats: 0,
        nextAttemptAt: null,
        episodeClosedAt: null,
      };
      row.attempts += 1;
      row.status = outcome.delivered ? 'delivered' : 'pending';
      // Backoff, never retirement: eligibility survives any number of failures.
      row.nextAttemptAt = outcome.delivered ? null : Date.now() + backoffForAttempt(row.attempts);
      rows.set(k, row);
    }),
    markCoveredBySibling: vi.fn(async (key: never) => {
      const k = keyOf(key);
      const row = rows.get(k) ?? {
        status: 'pending',
        attempts: 0,
        failedBeats: 0,
        nextAttemptAt: null,
        episodeClosedAt: null,
      };
      row.status = 'delivered';
      row.nextAttemptAt = null;
      rows.set(k, row);
      if ((key as never as { kind: string }).kind === 'recovery') {
        await store.closeEpisode(key);
      }
    }),
    closeEpisode: vi.fn(async (key: never) => {
      const outageKey = `${(key as never as { reminderId: string }).reminderId}|outage|${(key as never as { episodeKey: string }).episodeKey}`;
      const row = rows.get(outageKey);
      if (row) row.episodeClosedAt = new Date().toISOString();
    }),
    findOwedRecovery: vi.fn(async (reminderId: string) => {
      for (const [k, row] of rows) {
        const [rid, kind, episodeKey] = k.split('|');
        if (rid !== reminderId || kind !== 'outage') continue;
        if (row.status !== 'delivered' || row.episodeClosedAt) continue;

        const recovery = rows.get(`${reminderId}|recovery|${episodeKey}`);
        if (recovery?.status === 'delivered') continue;
        if (recovery?.nextAttemptAt !== undefined && recovery?.nextAttemptAt !== null) {
          if (recovery.nextAttemptAt > Date.now()) continue;
        }
        return {
          episodeKey,
          destination: null,
          failedBeats: recovery?.failedBeats ?? row.failedBeats,
          attempts: recovery?.attempts ?? 0,
        };
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
function makeClient(
  opts: {
    insertResult?: { error: { message: string } | null };
    /**
     * sb_id -> slug. The double RESOLVES THE FILTER rather than answering every
     * lookup the same way: a fake that returns one slug for every `sb_id` cannot
     * tell two owners apart, so a test asserting that two same-titled beats
     * produce distinguishable alerts would pass against code that never looked
     * at the owner at all. Defaults preserve the previous single-identity
     * behaviour for the tests that do not care.
     */
    identities?: Record<string, string>;
  } = {}
) {
  const insert = vi.fn().mockResolvedValue(opts.insertResult ?? { error: null });
  const identities = opts.identities ?? { 'sb-myra-uuid': 'myra' };
  const identitySingle = vi.fn();

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'agent_identities') {
      return {
        select: () => ({
          eq: (_column: string, value: string) => ({
            single: () => {
              identitySingle(value);
              const slug = identities[value];
              return Promise.resolve(
                slug
                  ? { data: { agent_id: slug }, error: null }
                  : { data: null, error: { message: `no identity for ${value}` } }
              );
            },
          }),
        }),
      };
    }
    return { insert };
  });

  return { client: { from } as never, insert, from, identitySingle };
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
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
      });

      await expect(
        onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION)
      ).resolves.toEqual({ alerted: false });
      expect(insert).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Myra, on `debug:myra-heartbeat-failures`, 2026-09-22: the alerting
   * worked — a beat failed, it was caught, Conor was told — and what landed on
   * his phone was the ink startup banner as raw escape sequences, a
   * `session_meta` blob, and no cause, under a heading telling him his monitor
   * had stopped.
   *
   * The root cause is fixed upstream in ink-runner (it now sends a sanitised
   * tail). These cover the seam instead: every backend funnels through here and
   * they compose failure text differently — Claude and Gemini still reject with
   * their whole raw stderr — so an alert must be readable regardless of which
   * one produced the string.
   *
   * The fixture is invented; only its shape is copied from the real payload.
   */
  describe('the alert is readable by the human who receives it', () => {
    const BANNER_CELL = '\u001b[38;2;10;10;26m\u001b[48;2;10;10;26m▄\u001b[49m\u001b[39m';
    const NOISY_FAILURE =
      '\u001b[32mApplied "Safe" profile (All tools allowed except comms and file writes.)\u001b[39m\n' +
      '\u001b[2mIdentity context loaded: ~21,793 tokens injected into prompt\u001b[22m\n' +
      '{"type":"session_meta","transcriptPath":"/tmp/example.test/repl/session.jsonl"}\n' +
      BANNER_CELL.repeat(60) +
      '\nError: backend refused the turn (no credentials)';

    async function alertContentFor(error: string): Promise<string> {
      const { client } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'myra',
      });
      await onFailure(makeReminder(), error, 1, FIRST_FOR_DESTINATION);
      return sendToChannel.mock.calls[0][0].content as string;
    }

    it('strips the terminal escape sequences before they reach the channel', async () => {
      // Control: the fixture really does carry what we are claiming to remove.
      // Without this the assertion below would pass on an empty string.
      expect(NOISY_FAILURE).toMatch(/\u001b/);

      const content = await alertContentFor(NOISY_FAILURE);
      expect(content).not.toMatch(/\u001b/);
    });

    it('leads with the cause rather than the startup preamble', async () => {
      const content = await alertContentFor(NOISY_FAILURE);

      expect(content).toContain('backend refused the turn');
      expect(content).not.toContain('Applied "Safe" profile');
      expect(content).not.toContain('session_meta');
    });

    it('keeps the alert short enough to read on a phone', async () => {
      const content = await alertContentFor(NOISY_FAILURE);

      // The real one ran to a screenful. The heading and closing sentence are
      // ~200 chars, so this bounds the quoted excerpt, not the message.
      expect(content.length).toBeLessThan(600);
      expect(NOISY_FAILURE.length).toBeGreaterThan(600);
    });

    it('says so explicitly when the backend gave no diagnostic at all', async () => {
      const content = await alertContentFor('');
      expect(content).toContain('(no diagnostic output)');
    });

    // The durable copy is read by a human too, and on the dashboard.
    it('sanitises the inbox copy as well as the channel alert', async () => {
      const { client, insert } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'myra',
      });

      await onFailure(makeReminder(), NOISY_FAILURE, 1, FIRST_FOR_DESTINATION);

      const row = insert.mock.calls[0][0] as { content: string };
      expect(row.content).not.toMatch(/\u001b/);
      expect(row.content).toContain('backend refused the turn');
    });

    // Classification reads the FULL text, deliberately not the trimmed excerpt.
    // `owner_conflict` needs the refusal sentence AND the thread-store context,
    // and those arrive at the head of a long Codex stderr dump — the excerpt
    // keeps the tail, so classifying off it would silently stop matching.
    it('still classifies on the full text, not on the trimmed excerpt', async () => {
      const codexRefusal =
        'failed to initialize thread persistence: thread-store conflict\n' +
        'thread thr_01 already has an active writer\n' +
        `${'filler line\n'.repeat(200)}` +
        'stream closed';

      const content = await alertContentFor(codexRefusal);
      expect(content).toContain('owner_conflict');
    });
  });

  /**
   * Classifying before OUR trim is necessary and is not sufficient, which is
   * the correction Lumen's second review of PR #662 made.
   *
   * By the time a failure reaches this hook it has already been bounded: a
   * runner composed it for a log field and a DB column several layers up. The
   * text below is what a 2000-character diagnostic excerpt leaves of a 3.5KB
   * Node failure — warnings at the head, frames at the tail, `Error: fetch
   * failed` gone with the elided middle. No ordering at this seam can recover
   * it, because it is not in the string. Only a verdict formed before the trim
   * can, and that is what the escalation context now carries.
   */
  describe('a category the excerpt can no longer support', () => {
    const TRIMMED_TO_DEATH = [
      'ink chat exited with code 1: (node:123) Warning: Example optional feature is experimental',
      '(Use node --trace-warnings to show where the warning was created)',
      '…',
      '    at step29 (/tmp/example.test/node_modules/example-backend/dist/runtime/transport/request-handler.js:100:20)',
    ].join('\n');

    const NETWORK_VERDICT = {
      category: 'network' as const,
      summary: 'Error: fetch failed',
      retryable: true,
    };

    async function alertFor(
      error: string,
      context: typeof FIRST_FOR_DESTINATION & { classification?: typeof NETWORK_VERDICT }
    ): Promise<string> {
      const { client } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'myra',
      });
      await onFailure(makeReminder(), error, 1, context);
      return sendToChannel.mock.calls[0][0].content as string;
    }

    /**
     * The control, and the whole reason the carried value is needed: this seam
     * cannot do better than `unknown` on this text, however early it classifies.
     */
    it('reads unknown off the excerpt, because there is nothing left to match', async () => {
      const content = await alertFor(TRIMMED_TO_DEATH, FIRST_FOR_DESTINATION);

      expect(content).toContain('unknown:');
      expect(content).not.toContain('retryable');
    });

    it('reports the carried verdict instead of re-reading the excerpt', async () => {
      const content = await alertFor(TRIMMED_TO_DEATH, {
        ...FIRST_FOR_DESTINATION,
        classification: NETWORK_VERDICT,
      });

      expect(content).toContain('network (retryable):');
    });

    // The durable copy is the one the dashboard reads, and it must not carry a
    // different category from the message that went to a phone.
    it('uses the carried verdict for the inbox copy too', async () => {
      const { client, insert } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'myra',
      });

      await onFailure(makeReminder(), TRIMMED_TO_DEATH, 1, {
        ...FIRST_FOR_DESTINATION,
        classification: NETWORK_VERDICT,
      });

      const row = insert.mock.calls[0][0] as { content: string };
      expect(row.content).toContain('Category: network (retryable: true)');
    });

    /**
     * Bounded claim: the carried value decides the CATEGORY, never the text.
     * A human still reads the excerpt, elision and all — what was dropped is
     * dropped, and this is not a claim to have recovered it.
     */
    it('changes the verdict without changing a byte of what a human reads', async () => {
      const carried = await alertFor(TRIMMED_TO_DEATH, {
        ...FIRST_FOR_DESTINATION,
        classification: NETWORK_VERDICT,
      });
      sendToChannel.mockClear();
      const derived = await alertFor(TRIMMED_TO_DEATH, FIRST_FOR_DESTINATION);

      expect(carried.replace('network (retryable):', 'unknown:')).toBe(derived);
    });
  });

  describe('one outage is two messages, not two per beat', () => {
    it('alerts on the first failure only', async () => {
      const { client } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
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
        defaultSlug: 'fallback-agent',
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
        defaultSlug: 'fallback-agent',
      });

      await onFailure(makeReminder({ sb_id: null }), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);

      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({ recipient_agent_id: 'fallback-agent' })
      );
    });

    /**
     * The regression for 2026-09-23. Several `scheduled_reminders` rows shared
     * one title across two different owners, and the alert quoted the title
     * alone — so the SB who received one read it as her own beat and published a
     * timeline explaining why a reminder she owned had run at a time it never
     * ran at. It was not her beat.
     *
     * The discriminating input is two reminders that differ ONLY in the fields
     * the alert used to drop. A fixture varying the title as well would pass
     * against the old code.
     */
    it('distinguishes two same-titled beats owned by different SBs', async () => {
      const { client } = makeClient({
        identities: { 'sb-myra-uuid': 'myra', 'sb-wren-uuid': 'wren' },
      });
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'myra',
      });

      const hers = makeReminder({
        id: 'rem-hers',
        title: 'Morning sweep',
        sb_id: 'sb-myra-uuid',
        cron_expression: '20 4 * * *',
      });
      const mine = makeReminder({
        id: 'rem-mine',
        title: 'Morning sweep',
        sb_id: 'sb-wren-uuid',
        cron_expression: '5 3 * * *',
      });

      await onFailure(hers, AUTH_ERROR, 1, FIRST_FOR_DESTINATION);
      await onFailure(mine, AUTH_ERROR, 1, FIRST_FOR_DESTINATION);

      const [first, second] = sendToChannel.mock.calls.map((call) => call[0].content as string);

      // Each alert names its own owner and slot...
      expect(first).toContain('myra');
      expect(first).toContain('20 4 * * *');
      expect(second).toContain('wren');
      expect(second).toContain('5 3 * * *');

      // ...and does not claim the other's. This is the half that fails against
      // a title-only alert: both messages were byte-identical, so a reader had
      // no way to tell which beat had stopped.
      expect(first).not.toContain('wren');
      expect(second).not.toContain('myra');
      expect(first).not.toBe(second);
    });

    // The all-clear has to name the same beat the alarm did, or the ambiguity
    // just moves to the message telling someone they are covered again.
    it('names the owner and slot on the recovery notice too', async () => {
      const { client } = makeClient({ identities: { 'sb-wren-uuid': 'wren' } });
      const { onRecovery } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'myra',
      });

      await onRecovery(
        makeReminder({
          title: 'Morning sweep',
          sb_id: 'sb-wren-uuid',
          cron_expression: '5 3 * * *',
        }),
        3,
        FIRST_FOR_DESTINATION
      );

      const content = sendToChannel.mock.calls[0][0].content as string;
      expect(content).toContain('Morning sweep');
      expect(content).toContain('wren');
      expect(content).toContain('5 3 * * *');
    });

    /**
     * Control for the degrade path. An owner we cannot look up must not render
     * as `(null)` on someone's phone, and must not cost the notice — the slot
     * still qualifies it, and a beat with no cron at all falls back to the bare
     * title rather than an empty bracket.
     */
    it('drops an unresolvable owner from the label instead of printing a hole', async () => {
      const { client } = makeClient({ identities: {} });
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'myra',
      });

      await onFailure(
        makeReminder({ title: 'Morning sweep', sb_id: 'sb-unknown' }),
        AUTH_ERROR,
        1,
        FIRST_FOR_DESTINATION
      );

      const content = sendToChannel.mock.calls[0][0].content as string;
      expect(content).toContain('Morning sweep');
      expect(content).toContain('0 * * * *');
      expect(content).not.toContain('null');
      expect(content).not.toContain('undefined');
      expect(content).not.toContain('()');
    });

    it('falls back to the bare title when a beat has neither owner nor slot', async () => {
      const { client } = makeClient({ identities: {} });
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'myra',
      });

      await onFailure(
        makeReminder({ title: 'Morning sweep', sb_id: 'sb-unknown', cron_expression: null }),
        AUTH_ERROR,
        1,
        FIRST_FOR_DESTINATION
      );

      const content = sendToChannel.mock.calls[0][0].content as string;
      expect(content).toContain('"Morning sweep"');
      expect(content).not.toContain('()');
    });

    it('escalates priority once an outage is established', async () => {
      const { client, insert } = makeClient();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
        store,
      });

      // A streak of 9 with no notice ever delivered — the state Myra's twelve
      // hours actually left behind. The old guard read `consecutive > 1` and
      // said nothing at all.
      const result = await onFailure(makeReminder(), AUTH_ERROR, 9, FIRST_FOR_DESTINATION);

      expect(result).toEqual({ alerted: true });
      expect(sendToChannel).toHaveBeenCalledTimes(1);
    });

    // Round four replaced an attempt CAP with a frequency bound. The cap said:
    // after three failed sends, stop trying to tell the human their monitor is
    // down and write a log line instead. Under a no-silence contract that is the
    // bug, not the safeguard — a channel outage longer than three beats became
    // exactly the silence this table exists to prevent.
    it('backs off a notice that will not send, without ever retiring it', async () => {
      const { client } = makeClient();
      const store = makeFakeStore();
      sendToChannel.mockRejectedValue(new Error('telegram gone for good'));
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'myra',
        store,
      });

      // Six beats arriving back to back. The first attempt fires, and so does
      // the second — the first retry is deliberately immediate, because the
      // common channel failure is a momentary blip and the message is urgent.
      // From the third on, the backoff holds them.
      for (const consecutive of [1, 2, 3, 4, 5, 6]) {
        await onFailure(makeReminder(), AUTH_ERROR, consecutive, FIRST_FOR_DESTINATION);
      }
      expect(sendToChannel).toHaveBeenCalledTimes(2);

      const row = store.rows.get(`rem-001|outage|${FIRST_FOR_DESTINATION.episodeKey}`);
      expect(row?.status).toBe('pending');
      expect(row?.nextAttemptAt).toBeGreaterThan(Date.now());
    });

    it('is still owed after far more failures than the old cap allowed', async () => {
      const { client } = makeClient();
      const store = makeFakeStore();
      sendToChannel.mockRejectedValue(new Error('telegram gone for good'));
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'myra',
        store,
      });

      // Ten beats, each arriving after its predecessor's backoff has elapsed.
      const key = `rem-001|outage|${FIRST_FOR_DESTINATION.episodeKey}`;
      for (let beat = 1; beat <= 10; beat++) {
        const row = store.rows.get(key);
        if (row) row.nextAttemptAt = Date.now() - 1;
        await onFailure(makeReminder(), AUTH_ERROR, beat, FIRST_FOR_DESTINATION);
      }

      // The old cap would have stopped at three. Eligibility is forever; only
      // the frequency is bounded.
      expect(sendToChannel).toHaveBeenCalledTimes(10);
      expect(store.rows.get(key)?.status).toBe('pending');

      // And when the channel finally comes back, the notice still lands.
      sendToChannel.mockResolvedValueOnce(undefined);
      const row = store.rows.get(key);
      if (row) row.nextAttemptAt = Date.now() - 1;
      const result = await onFailure(makeReminder(), AUTH_ERROR, 11, FIRST_FOR_DESTINATION);
      expect(result).toEqual({ alerted: true });
      expect(store.rows.get(key)?.status).toBe('delivered');
    });

    it('lengthens the wait as attempts accumulate, and caps it', async () => {
      // The schedule itself, asserted directly: monotonic, and flat at the
      // ceiling so a permanently dead channel costs a trickle rather than a
      // retry per beat.
      const waits = [1, 2, 3, 4, 5, 6, 20].map((n) => backoffForAttempt(n));
      for (let i = 1; i < waits.length; i++) {
        expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1]);
      }
      expect(backoffForAttempt(1)).toBe(0);
      expect(backoffForAttempt(20)).toBe(backoffForAttempt(5));
      expect(backoffForAttempt(20)).toBeGreaterThan(0);
    });

    it('retries an all-clear whose send failed', async () => {
      const { client } = makeClient();
      const store = makeFakeStore();
      sendToChannel.mockRejectedValueOnce(new Error('telegram unreachable'));
      const { onRecovery } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
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
        defaultSlug: 'myra',
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
      // accrues a row for a notice that could never be delivered.
      expect(store.claimNotice).not.toHaveBeenCalled();
    });
  });

  /**
   * Round four. Lumen's counterexample to the invariant I had asked him to
   * attack: "every read degrades to 'we have not told them yet' and every write
   * to a warning, so a broken store costs duplicates and never silence."
   *
   * He found the path where it costs silence instead, and it is the one that
   * matters — a store failure at the exact moment an all-clear is owed.
   */
  describe('an owed all-clear survives the store that should have recorded it', () => {
    it('still sends the all-clear when its own notice row was never written', async () => {
      const { client } = makeClient();
      const store = makeFakeStore();
      const { onFailure, onRecovery } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'myra',
        store,
      });

      // The outage is announced and lands. The human now holds a failure notice
      // and is owed a resolution.
      await onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);
      expect(sendToChannel).toHaveBeenCalledTimes(1);

      // The recovery beat: the store cannot write the recovery row at all, and
      // the channel is down too. This is the triple failure Lumen described.
      sendToChannel.mockRejectedValueOnce(new Error('telegram unreachable'));
      store.claimNotice.mockImplementationOnce(async () => ({ shouldSend: true, record: null }));
      store.settleNotice.mockImplementationOnce(async () => {});

      const failed = await onRecovery(makeReminder(), 1, FIRST_FOR_DESTINATION);
      expect(failed).toEqual({ alerted: false });

      // There is no recovery row. A sweep that looked for a pending recovery
      // would find nothing and conclude nothing is owed — which is the silence.
      expect(store.rows.has(`rem-001|recovery|${FIRST_FOR_DESTINATION.episodeKey}`)).toBe(false);

      // The debt is on the OUTAGE row instead, whose episode is still open.
      const owed = await store.findOwedRecovery('rem-001');
      expect(owed?.episodeKey).toBe(FIRST_FOR_DESTINATION.episodeKey);

      // So a later healthy beat finds it and the all-clear finally lands.
      const retried = await onRecovery(makeReminder(), 1, FIRST_FOR_DESTINATION);
      expect(retried).toEqual({ alerted: true });
    });

    it('stops owing the all-clear once it has actually been delivered', async () => {
      const { client } = makeClient();
      const store = makeFakeStore();
      const { onFailure, onRecovery } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'myra',
        store,
      });

      await onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);
      await onRecovery(makeReminder(), 1, FIRST_FOR_DESTINATION);

      // Positive control for the test above: a delivered all-clear closes the
      // episode, so the sweep stops finding it. Without this, the fix for
      // silence would ship an all-clear on every healthy beat forever.
      expect(await store.findOwedRecovery('rem-001')).toBeNull();
      expect(store.closeEpisode).toHaveBeenCalled();
    });

    it('keeps owing the all-clear when only the send failed', async () => {
      const { client } = makeClient();
      const store = makeFakeStore();
      const { onFailure, onRecovery } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'myra',
        store,
      });

      await onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);
      sendToChannel.mockRejectedValueOnce(new Error('telegram unreachable'));
      await onRecovery(makeReminder(), 1, FIRST_FOR_DESTINATION);

      // An attempt is not an outcome — the episode stays open.
      expect(store.closeEpisode).not.toHaveBeenCalled();
      expect((await store.findOwedRecovery('rem-001'))?.episodeKey).toBe(
        FIRST_FOR_DESTINATION.episodeKey
      );
    });
  });

  describe('the inbox copy cannot cancel the channel alert', () => {
    // Round four, finding 3. The INSERT was guarded, but the identity lookup
    // that addresses it was not — and it is just as much a part of the inbox
    // dependency. A throw there aborted onFailure before the channel send: the
    // durable copy taking down the useful one, which is the coupling the
    // two-destination split exists to prevent.
    it('alerts the channel when resolving the failed agent throws', async () => {
      const insert = vi.fn().mockResolvedValue({ error: null });
      const from = vi.fn().mockImplementation((table: string) => {
        if (table === 'agent_identities') {
          return {
            select: () => ({
              eq: () => ({
                single: vi.fn().mockRejectedValue(new Error('identity lookup exploded')),
              }),
            }),
          };
        }
        return { insert };
      });

      const store = makeFakeStore();
      const { onFailure } = createHeartbeatEscalation({
        client: { from } as never,
        sendToChannel,
        defaultSlug: 'myra',
        store,
      });

      const result = await onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);

      expect(result).toEqual({ alerted: true });
      expect(sendToChannel).toHaveBeenCalledTimes(1);
    });

    it('alerts the channel when resolving the failed agent returns an error', async () => {
      const insert = vi.fn().mockResolvedValue({ error: null });
      const from = vi.fn().mockImplementation((table: string) => {
        if (table === 'agent_identities') {
          return {
            select: () => ({
              eq: () => ({
                single: vi
                  .fn()
                  .mockResolvedValue({ data: null, error: { message: 'permission denied' } }),
              }),
            }),
          };
        }
        return { insert };
      });

      const store = makeFakeStore();
      const { onFailure } = createHeartbeatEscalation({
        client: { from } as never,
        sendToChannel,
        // DISTINCT from the agent this reminder belongs to. If the default were
        // also 'myra' this test could not tell a correct address from a guess.
        defaultSlug: 'unrelated-sb',
        store,
      });

      const result = await onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);

      expect(result).toEqual({ alerted: true });
      expect(sendToChannel).toHaveBeenCalledTimes(1);
      // Round five, finding 3. The beat NAMES an owner; we just could not look
      // it up. Filing it under the default would put "Your scheduled heartbeat
      // did not run" in an uninvolved SB's inbox — telling them a beat of
      // theirs is down when it is not, while the real owner still hears
      // nothing. Skipping the copy loses a record; guessing invents one.
      expect(insert).not.toHaveBeenCalled();
    });

    it('skips the inbox copy when an explicit owner resolves to nothing', async () => {
      // The lookup SUCCEEDS and simply returns no agent_id — a dangling sb_id.
      // Same rule: an owner we cannot name is not the default owner.
      const insert = vi.fn().mockResolvedValue({ error: null });
      const from = vi.fn().mockImplementation((table: string) => {
        if (table === 'agent_identities') {
          return {
            select: () => ({
              eq: () => ({ single: vi.fn().mockResolvedValue({ data: {}, error: null }) }),
            }),
          };
        }
        return { insert };
      });

      const store = makeFakeStore();
      const { onFailure } = createHeartbeatEscalation({
        client: { from } as never,
        sendToChannel,
        defaultSlug: 'unrelated-sb',
        store,
      });

      const result = await onFailure(makeReminder(), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);

      expect(result).toEqual({ alerted: true });
      expect(sendToChannel).toHaveBeenCalledTimes(1);
      expect(insert).not.toHaveBeenCalled();
    });

    it('still uses the default agent for a beat that genuinely has no owner', async () => {
      // The control that keeps the fix from becoming "never use the default".
      // A null sb_id is not a failed lookup — there is no owner to misaddress.
      const { client, insert } = makeClient();
      const store = makeFakeStore();
      const { onFailure } = createHeartbeatEscalation({
        client,
        sendToChannel,
        defaultSlug: 'unrelated-sb',
        store,
      });

      await onFailure(makeReminder({ sb_id: null }), AUTH_ERROR, 1, FIRST_FOR_DESTINATION);

      expect(insert).toHaveBeenCalledTimes(1);
      expect(insert.mock.calls[0][0].recipient_agent_id).toBe('unrelated-sb');
    });
  });

  it('keeps the error line in the alert when the stack under it is longer than the budget', async () => {
    const { client } = makeClient();
    const { onFailure } = createHeartbeatEscalation({ client, sendToChannel, defaultSlug: 'myra' });

    // Lumen's fixture, review of PR #662: an ordinary Node failure names its
    // cause on the FIRST line. An unconditional tail sent Conor ten stack
    // frames and no sentence — the mirror of the head-slice bug this PR
    // replaced. Asserted on the real channel payload, not on the excerpt.
    const frames = Array.from(
      { length: 10 },
      (_, i) =>
        `    at step${i} (/tmp/example.test/node_modules/example-backend/dist/runtime/transport/request-handler.js:100:20)`
    );

    await onFailure(
      makeReminder(),
      `Error: fetch failed\n${frames.join('\n')}`,
      1,
      FIRST_FOR_DESTINATION
    );

    const content = sendToChannel.mock.calls[0][0].content;
    expect(content).toContain('fetch failed');
    // The tail is still there — this keeps both ends, it does not swap which
    // end gets lost.
    expect(content).toContain('at step9');
  });
});
