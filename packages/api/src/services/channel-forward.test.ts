/**
 * The turn that delivered nothing and said it had.
 *
 * Myra relied on the documented auto-forward for research Conor was waiting on.
 * get_activity showed his message_in, three agent_complete turns after it, and
 * ZERO message_out. The only log line for that path said "Explicit
 * send_response detected" — at debug, which is not persisted — while carrying
 * `hadExplicitResponse: false` in its own payload.
 */

import { describe, it, expect } from 'vitest';
import { LOCAL_TOOL_CALL_PLACEHOLDER } from '@inklabs/shared';
import {
  applyChannelForward,
  attributeResponses,
  createTurnReplyForwarder,
  decideChannelForward,
  decideTurnReply,
  hasDeliveryEvidence,
  type ChannelForwardDecision,
  type ChannelForwardPayload,
} from './channel-forward';

describe('decideChannelForward', () => {
  it('forwards the final text when nothing else delivered it', () => {
    expect(
      decideChannelForward({
        hadExplicitResponse: false,
        success: true,
        finalTextResponse: 'here is the research',
      })
    ).toEqual({ action: 'auto-forward', content: 'here is the research' });
  });

  it('stands aside when the agent answered explicitly', () => {
    expect(
      decideChannelForward({
        hadExplicitResponse: true,
        success: true,
        finalTextResponse: 'text as well',
      })
    ).toEqual({ action: 'explicit-response' });
  });

  /**
   * The two cases that were being reported as "explicit send_response
   * detected". Both mean the user got nothing, and they need different
   * follow-up: a failed run is a fault, an empty one is an agent that finished
   * without saying anything.
   */
  it('names a failed run as undelivered rather than as an explicit response', () => {
    expect(
      decideChannelForward({
        hadExplicitResponse: false,
        success: false,
        finalTextResponse: 'partial work',
      })
    ).toEqual({ action: 'nothing-delivered', reason: 'run-failed' });
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace only', '   \n\t '],
  ])('names a %s final text as undelivered', (_label, text) => {
    expect(
      decideChannelForward({
        hadExplicitResponse: false,
        success: true,
        finalTextResponse: text as string | null | undefined,
      })
    ).toEqual({ action: 'nothing-delivered', reason: 'no-final-text' });
  });

  /**
   * Whitespace would satisfy a bare truthiness check and deliver nothing a
   * reader can use — the failure wearing a success badge.
   */
  it('does not count whitespace as a reply', () => {
    const d = decideChannelForward({
      hadExplicitResponse: false,
      success: true,
      finalTextResponse: '\n  \n',
    });
    expect(d.action).not.toBe('auto-forward');
  });

  /**
   * Trim DETECTS blankness; it must not be what gets sent. Leading indentation
   * is load-bearing in Markdown — a fenced block, a nested list — so the
   * forwarded value has to be byte-identical to what the agent produced
   * (Lumen, PR #580).
   */
  it('forwards the original text, whitespace and all', () => {
    const markdown = '  - nested item\n\n    ```\n    code\n    ```\n';
    expect(
      decideChannelForward({
        hadExplicitResponse: false,
        success: true,
        finalTextResponse: markdown,
      })
    ).toEqual({ action: 'auto-forward', content: markdown });
  });

  /**
   * An explicit response wins even on a failed run: the agent already sent
   * something, so claiming nothing was delivered would be its own false alarm.
   */
  it('prefers the explicit answer over a failure verdict', () => {
    expect(decideChannelForward({ hadExplicitResponse: true, success: false })).toEqual({
      action: 'explicit-response',
    });
  });

  /**
   * An ink turn that ended on tool calls stores this placeholder as its text,
   * and an ink run's final text is its last turn's. Forwarded, the user got a
   * line about a transcript they cannot see.
   */
  it.each([
    ['bare', LOCAL_TOOL_CALL_PLACEHOLDER],
    ['padded', `\n${LOCAL_TOOL_CALL_PLACEHOLDER}  `],
  ])('treats the %s tool-call placeholder as no final text', (_label, text) => {
    expect(
      decideChannelForward({ hadExplicitResponse: false, success: true, finalTextResponse: text })
    ).toEqual({ action: 'nothing-delivered', reason: 'no-final-text' });
  });
});

/**
 * The SERVER boundary.
 *
 * The decision tests above stay green even if server.ts reverts to the old
 * single branch or downgrades the warning to debug (Lumen, PR #580) — so the
 * step that logs and releases lives in a function a test can reach, and these
 * assert the part that actually protects the user: the LEVEL.
 */
describe('applyChannelForward', () => {
  function spyEffects() {
    const calls = { info: [] as unknown[][], warn: [] as unknown[][], debug: [] as unknown[][] };
    const released: Array<ChannelForwardPayload | undefined> = [];
    return {
      calls,
      released,
      fx: {
        info: (m: string, meta: Record<string, unknown>) => calls.info.push([m, meta]),
        warn: (m: string, meta: Record<string, unknown>) => calls.warn.push([m, meta]),
        debug: (m: string, meta: Record<string, unknown>) => calls.debug.push([m, meta]),
        release: async (p?: ChannelForwardPayload) => {
          released.push(p);
        },
      },
    };
  }

  const ctx = {
    channel: 'telegram',
    conversationId: '100200300',
    hadExplicitResponse: false,
    runSucceeded: true,
    finalTextLength: 0,
  };

  it('releases WITH the content when auto-forwarding', async () => {
    const { fx, released, calls } = spyEffects();
    await applyChannelForward({ action: 'auto-forward', content: 'the answer' }, ctx, fx);
    expect(released).toEqual([{ content: 'the answer', format: 'markdown' }]);
    expect(calls.info).toHaveLength(1);
    expect(calls.warn).toHaveLength(0);
  });

  it("carries the turn's session on the auto-forward payload", async () => {
    // An auto-forwarded reply is a message_out row like any other; without the
    // session it is the anonymous row #596 set out to remove, on another path.
    const { fx, released } = spyEffects();
    await applyChannelForward(
      { action: 'auto-forward', content: 'the answer' },
      { ...ctx, sessionId: 'session-of-the-turn' },
      fx
    );
    expect(released).toEqual([
      { content: 'the answer', format: 'markdown', sessionId: 'session-of-the-turn' },
    ]);
  });

  /**
   * The assertion that matters. `nothing-delivered` at debug is invisible —
   * debug is not persisted to ~/.ink/logs — which is how a turn that reached
   * nobody left no trace at all.
   */
  it.each([['run-failed'], ['no-final-text']])(
    'WARNS (never debug) when nothing was delivered: %s',
    async (reason) => {
      const { fx, released, calls } = spyEffects();
      await applyChannelForward(
        { action: 'nothing-delivered', reason } as ChannelForwardDecision,
        ctx,
        fx
      );
      expect(calls.warn).toHaveLength(1);
      expect(calls.warn[0]![0]).toContain('Nothing delivered');
      expect((calls.warn[0]![1] as { reason: string }).reason).toBe(reason);
      expect(calls.debug).toHaveLength(0);
      // Released, but with nothing to send.
      expect(released).toEqual([undefined]);
    }
  );

  /**
   * A skip is a decision not to deliver the run's text. At debug it was not
   * persisted, so when the skip was wrong (task 0eb376e5) nothing showed it.
   */
  it('logs the explicit-response skip at info, with the text it held back', async () => {
    const { fx, released, calls } = spyEffects();
    await applyChannelForward(
      { action: 'explicit-response' },
      { ...ctx, hadExplicitResponse: true, finalTextLength: 42 },
      fx
    );
    expect(calls.info).toHaveLength(1);
    expect(calls.info[0]![1]).toMatchObject({ hadExplicitResponse: true, finalTextLength: 42 });
    expect(calls.debug).toHaveLength(0);
    expect(calls.warn).toHaveLength(0);
    expect(released).toEqual([undefined]);
  });
});

/**
 * A spawned ink chat runs several outer turns, and the whole-run rule above
 * lost replies two ways (task 0eb376e5, Myra's Telegram run of 2026-10-03):
 * only the last turn's text was considered, and a send_response in any turn
 * suppressed every turn's text. Her reply was turn 1's text; turn 2 called
 * send_response; turn 3 ended on a tool call. The whole-run rule saw a marker
 * and forwarded nothing.
 */
describe('decideTurnReply', () => {
  it('forwards a turn that wrote text and sent nothing', () => {
    expect(decideTurnReply({ hadExplicitResponse: false, text: 'the reply' })).toEqual({
      action: 'forward',
      content: 'the reply',
    });
  });

  it("keeps a turn's text back when that turn delivered through send_response", () => {
    expect(decideTurnReply({ hadExplicitResponse: true, text: 'Sent it.' })).toEqual({
      action: 'explicit-response',
    });
  });

  it.each([
    ['null', null],
    ['blank', '  \n'],
    ['the tool-call placeholder', LOCAL_TOOL_CALL_PLACEHOLDER],
  ])('has nothing to forward for %s text', (_label, text) => {
    expect(decideTurnReply({ hadExplicitResponse: false, text })).toEqual({ action: 'no-text' });
  });
});

describe('createTurnReplyForwarder', () => {
  function harness(options: { send?: (p: ChannelForwardPayload) => Promise<void> } = {}) {
    // The conversation's explicit-send marker, as consumeExplicitResponse
    // reads it: read and cleared in one step.
    let marker = false;
    const sent: ChannelForwardPayload[] = [];
    const log = { info: [] as unknown[][], warn: [] as unknown[][], error: [] as unknown[][] };
    let releases = 0;
    const forwarder = createTurnReplyForwarder(
      { channel: 'telegram', conversationId: '100200300' },
      {
        consumeExplicitResponse: () => {
          const had = marker;
          marker = false;
          return had;
        },
        send: async (payload) => {
          if (options.send) await options.send(payload);
          sent.push(payload);
        },
        info: (m, meta) => log.info.push([m, meta]),
        warn: (m, meta) => log.warn.push([m, meta]),
        error: (m, meta) => log.error.push([m, meta]),
        release: async () => {
          releases += 1;
        },
      }
    );
    return {
      forwarder,
      sent,
      log,
      releases: () => releases,
      sendResponse: () => {
        marker = true;
      },
      markerStanding: () => marker,
    };
  }

  const turn = (n: number, text: string | null, label = n === 1 ? 'telegram' : 'continuation') => ({
    turn: n,
    label,
    text,
    sessionId: 'session-of-the-run',
  });

  it("delivers Myra's turn-1 reply, and nothing the send_response turn wrote", async () => {
    const h = harness();
    await h.forwarder.onTurnReply(turn(1, 'Here is the answer you asked for.'));
    h.sendResponse(); // turn 2 called send_response
    await h.forwarder.onTurnReply(turn(2, 'The reply went out by send_response.'));
    await h.forwarder.onTurnReply(turn(3, null)); // ended on signal_status
    await h.forwarder.finish({ success: true });

    expect(h.sent).toEqual([
      {
        content: 'Here is the answer you asked for.',
        format: 'markdown',
        sessionId: 'session-of-the-run',
      },
    ]);
    expect(h.forwarder.turnsSeen).toBe(3);
    expect(h.releases()).toBe(1);
    expect(h.log.warn).toHaveLength(0);
    expect(h.log.info.at(-1)).toEqual([
      'Run replies settled',
      expect.objectContaining({ forwardedTurns: [1], explicitTurns: [2], turnsSeen: 3 }),
    ]);
    // The rule this replaces, on the same run: the last text, and a marker.
    expect(
      decideChannelForward({ hadExplicitResponse: true, success: true, finalTextResponse: null })
    ).toEqual({ action: 'explicit-response' });
  });

  it('forwards every turn that wrote a reply without sending one, in order', async () => {
    const h = harness();
    await h.forwarder.onTurnReply(turn(1, 'first'));
    await h.forwarder.onTurnReply(turn(2, 'second'));
    await h.forwarder.finish({ success: true });
    expect(h.sent.map((p) => p.content)).toEqual(['first', 'second']);
  });

  /**
   * The marker names a conversation, not a turn. Read late, turn 1 would take
   * a send that turn 2 made as its own and keep its reply back.
   */
  it("reads the marker when a turn's reply arrives, before any await", async () => {
    let releaseFirstSend!: () => void;
    const firstSendHeld = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    const h = harness({
      send: async (p) => {
        if (p.content === 'turn one') await firstSendHeld;
      },
    });
    const first = h.forwarder.onTurnReply(turn(1, 'turn one'));
    h.sendResponse(); // turn 2's send lands while turn 1's reply is still going out
    const second = h.forwarder.onTurnReply(turn(2, 'turn two text'));
    releaseFirstSend();
    await Promise.all([first, second]);
    await h.forwarder.finish({ success: true });

    expect(h.sent.map((p) => p.content)).toEqual(['turn one']);
    expect(h.log.info.at(-1)![1]).toMatchObject({ forwardedTurns: [1], explicitTurns: [2] });
  });

  it('keeps replies in turn order when an earlier send is slow', async () => {
    let releaseFirstSend!: () => void;
    const firstSendHeld = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    const started: string[] = [];
    const h = harness({
      send: async (p) => {
        started.push(p.content);
        if (p.content === 'first') await firstSendHeld;
      },
    });
    void h.forwarder.onTurnReply(turn(1, 'first'));
    void h.forwarder.onTurnReply(turn(2, 'second'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(['first']);
    const finished = h.forwarder.finish({ success: true });
    expect(h.releases()).toBe(0);
    releaseFirstSend();
    await finished;
    expect(h.sent.map((p) => p.content)).toEqual(['first', 'second']);
    expect(h.releases()).toBe(1);
  });

  it('forwards the original text, whitespace and all', async () => {
    const markdown = '  - nested item\n\n    ```\n    code\n    ```\n';
    const h = harness();
    await h.forwarder.onTurnReply(turn(1, markdown));
    expect(h.sent[0]!.content).toBe(markdown);
  });

  it.each([
    ['no-final-text', true],
    ['run-failed', false],
  ] as const)('warns when the run delivered nothing (%s)', async (reason, success) => {
    const h = harness();
    await h.forwarder.onTurnReply(turn(1, null));
    await h.forwarder.onTurnReply(turn(2, '   '));
    await h.forwarder.finish({ success });
    expect(h.sent).toEqual([]);
    expect(h.log.warn).toEqual([
      ['Nothing delivered to the user for this run', expect.objectContaining({ reason })],
    ]);
    expect(h.releases()).toBe(1);
  });

  it('reports a failed send as a turn that reached nobody, and warns if it was the only one', async () => {
    const h = harness({
      send: async () => {
        throw new Error('telegram 502');
      },
    });
    await h.forwarder.onTurnReply(turn(1, 'the reply'));
    await h.forwarder.finish({ success: true });
    expect(h.log.error).toEqual([
      [
        'Failed to forward turn reply; this turn reached nobody',
        expect.objectContaining({ turn: 1, error: 'telegram 502' }),
      ],
    ]);
    expect(h.log.warn).toEqual([
      [
        'Nothing delivered to the user for this run',
        expect.objectContaining({ reason: 'send-failed' }),
      ],
    ]);
  });

  /**
   * A run can crash mid-turn after its send_response went out, and so never
   * report that turn. The send still reached the user, and its marker must not
   * outlive the run to be read by the next one.
   */
  it('counts a send after the last reported turn, and clears its marker', async () => {
    const h = harness();
    await h.forwarder.onTurnReply(turn(1, null));
    h.sendResponse();
    await h.forwarder.finish({ success: false });
    expect(h.log.warn).toHaveLength(0);
    expect(h.log.info.at(-1)![1]).toMatchObject({ lateExplicit: true });
    expect(h.markerStanding()).toBe(false);
  });
});

/**
 * A resolved transport call is not a delivered message (Lumen, PR #580 r2).
 *
 * The schema accepts `content: z.string()` with no minimum, so a blank body
 * with no media resolves happily and sends nothing; a media-only send can come
 * back with `mediaSent: 0`, every attachment failed, and still resolve. Both
 * used to mark the conversation answered, which suppressed the fallback AND the
 * nothing-delivered warning — the most complete failure available was the one
 * least likely to be reported.
 */
describe('hasDeliveryEvidence', () => {
  it('accepts nonblank text as proof on its own', () => {
    expect(hasDeliveryEvidence({ content: 'the answer', mediaRequested: 0 })).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['newlines', '\n\n'],
  ])('rejects %s text with no media', (_label, content) => {
    expect(hasDeliveryEvidence({ content, mediaRequested: 0 })).toBe(false);
  });

  it('rejects a media-only send where every attachment failed', () => {
    // The Slack case: callback resolved, mediaSent 0.
    expect(hasDeliveryEvidence({ content: '', mediaRequested: 3, mediaSent: 0 })).toBe(false);
  });

  it('accepts a media-only send when the gateway counted deliveries', () => {
    expect(hasDeliveryEvidence({ content: '', mediaRequested: 3, mediaSent: 2 })).toBe(true);
  });

  /**
   * The HTTP transport reports no per-item counters, so an accepted request is
   * the only evidence there is. Weaker than a count, kept deliberately rather
   * than failing every media-only send through that path.
   */
  it('falls back to "media was requested" when no counter exists', () => {
    expect(hasDeliveryEvidence({ content: '', mediaRequested: 1 })).toBe(true);
    expect(hasDeliveryEvidence({ content: '', mediaRequested: 0 })).toBe(false);
  });

  it('counts text even when media all failed', () => {
    expect(hasDeliveryEvidence({ content: 'here', mediaRequested: 2, mediaSent: 0 })).toBe(true);
  });
});

describe('attributeResponses', () => {
  const reply = { channel: 'telegram', conversationId: '1', content: 'hi' };

  it("stamps the turn's session on responses that carry none", () => {
    expect(attributeResponses([reply, { ...reply, content: 'again' }], 'turn-session')).toEqual([
      { ...reply, sessionId: 'turn-session' },
      { ...reply, content: 'again', sessionId: 'turn-session' },
    ]);
  });

  it('never overrides a session a response already carries', () => {
    // A stamped response came through a boundary that validated its session;
    // this function validated nothing and must not second-guess it.
    const stamped = { ...reply, sessionId: 'validated-at-the-tool' };
    expect(attributeResponses([stamped], 'turn-session')).toEqual([stamped]);
  });

  it('leaves responses untouched when the turn has no session', () => {
    const responses = [reply];
    expect(attributeResponses(responses, undefined)).toBe(responses);
    expect(responses[0]).not.toHaveProperty('sessionId');
  });
});
