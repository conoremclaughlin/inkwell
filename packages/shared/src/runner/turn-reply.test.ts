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
  it('reads a well-formed event and filters its text', () => {
    expect(
      parseTurnReplyEvent({ type: 'turn_reply', turn: 2, label: 'continuation', text: '  ' })
    ).toEqual({ type: 'turn_reply', turn: 2, label: 'continuation', text: null });
  });

  it.each([
    ['another type', { type: 'result', turn: 1, label: 'x', text: 'a' }],
    ['a zero turn', { type: 'turn_reply', turn: 0, label: 'x', text: 'a' }],
    ['a fractional turn', { type: 'turn_reply', turn: 1.5, label: 'x', text: 'a' }],
    ['a missing label', { type: 'turn_reply', turn: 1, text: 'a' }],
    ['a numeric text', { type: 'turn_reply', turn: 1, label: 'x', text: 3 }],
    ['a missing text', { type: 'turn_reply', turn: 1, label: 'x' }],
    ['null', null],
  ])('refuses %s', (_label, value) => {
    expect(parseTurnReplyEvent(value)).toBeNull();
  });
});
