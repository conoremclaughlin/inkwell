import { describe, it, expect } from 'vitest';
import {
  LOCAL_TOOL_CALL_PLACEHOLDER,
  parseTurnReplyEvent,
  userFacingReplyText,
} from './turn-reply.js';

describe('userFacingReplyText', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', ' \n\t '],
    ['the tool-call placeholder', LOCAL_TOOL_CALL_PLACEHOLDER],
    ['the padded placeholder', `  ${LOCAL_TOOL_CALL_PLACEHOLDER}\n`],
  ])('is null for %s', (_label, text) => {
    expect(userFacingReplyText(text)).toBeNull();
  });

  it('returns a reply untrimmed: leading indentation is Markdown', () => {
    const markdown = '  - nested\n';
    expect(userFacingReplyText(markdown)).toBe(markdown);
  });

  it('keeps a reply that merely mentions the placeholder', () => {
    const text = `Saw ${LOCAL_TOOL_CALL_PLACEHOLDER} in the log.`;
    expect(userFacingReplyText(text)).toBe(text);
  });
});

describe('parseTurnReplyEvent', () => {
  const event = {
    type: 'turn_reply',
    token: 'run-token',
    turn: 2,
    label: 'continuation',
    text: 'the reply',
    sends: [{ channel: 'telegram', conversationId: '100200300' }],
  };

  it('reads a well-formed event', () => {
    expect(parseTurnReplyEvent(event)).toEqual(event);
  });

  it('filters the text and keeps only the send targets', () => {
    expect(
      parseTurnReplyEvent({
        ...event,
        text: '  ',
        sends: [{ channel: 'telegram', conversationId: '100200300', content: 'x' }],
      })
    ).toEqual({ ...event, text: null });
  });

  it.each([
    ['another type', { ...event, type: 'result' }],
    ['no token', { ...event, token: undefined }],
    ['an empty token', { ...event, token: '' }],
    ['a zero turn', { ...event, turn: 0 }],
    ['a fractional turn', { ...event, turn: 1.5 }],
    ['a missing label', { ...event, label: undefined }],
    ['a numeric text', { ...event, text: 3 }],
    ['a missing text', { ...event, text: undefined }],
    ['no sends', { ...event, sends: undefined }],
    ['a send without a conversation', { ...event, sends: [{ channel: 'telegram' }] }],
    ['a send with an empty channel', { ...event, sends: [{ channel: '', conversationId: '1' }] }],
    ['null', null],
  ])('refuses %s', (_label, value) => {
    expect(parseTurnReplyEvent(value)).toBeNull();
  });
});
