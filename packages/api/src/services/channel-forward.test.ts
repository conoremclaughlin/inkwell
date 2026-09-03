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
import {
  applyChannelForward,
  decideChannelForward,
  type ChannelForwardDecision,
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
    const released: Array<{ content: string; format: 'markdown' } | undefined> = [];
    return {
      calls,
      released,
      fx: {
        info: (m: string, meta: Record<string, unknown>) => calls.info.push([m, meta]),
        warn: (m: string, meta: Record<string, unknown>) => calls.warn.push([m, meta]),
        debug: (m: string, meta: Record<string, unknown>) => calls.debug.push([m, meta]),
        release: async (p?: { content: string; format: 'markdown' }) => {
          released.push(p);
        },
      },
    };
  }

  const ctx = {
    channel: 'telegram',
    conversationId: '726555973',
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

  it('stays quiet at debug when the agent answered explicitly', async () => {
    const { fx, released, calls } = spyEffects();
    await applyChannelForward({ action: 'explicit-response' }, ctx, fx);
    expect(calls.debug).toHaveLength(1);
    expect(calls.warn).toHaveLength(0);
    expect(released).toEqual([undefined]);
  });
});
