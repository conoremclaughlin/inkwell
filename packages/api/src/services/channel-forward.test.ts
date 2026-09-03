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
import { decideChannelForward } from './channel-forward';

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

  it('trims what it forwards', () => {
    expect(
      decideChannelForward({
        hadExplicitResponse: false,
        success: true,
        finalTextResponse: '  answer  ',
      })
    ).toEqual({ action: 'auto-forward', content: 'answer' });
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
