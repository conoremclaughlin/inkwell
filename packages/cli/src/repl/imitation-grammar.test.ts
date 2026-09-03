import { describe, it, expect } from 'vitest';
import {
  fenceAfterLine,
  fenceOpenAtEnd,
  isImitationHeaderLine,
  isImitationResultLine,
  isPotentialImitationPrefix,
} from './imitation-grammar.js';

/**
 * Whole-line and could-still-become answers come from ONE grammar, so every
 * accepted line's every prefix must be held, whatever spacing it uses
 * (Lumen, PR #575 round 4).
 */
const HEADERS = [
  '[Tool results from previous turn]',
  '[Tool results from previous turn — FINAL]',
  '[Tool results from previous turn   —    FINAL]',
  '[Tool results from previous turn\t-\tFINAL]',
  'user[Tool results from previous turn]',
  'user  :  [Tool results from previous turn]',
  'Human: [Tool results from previous turn]',
  'system\t:\t[Tool results from previous turn – FINAL]',
  '  assistant [Tool results from previous turn]  ',
];
const RESULT_LINES = [
  'Tool list_emails (executed): {"ok":true}',
  'Tool list_emails (executed):\t\t{"ok":true}',
  '  Tool get.email-v2 (denied): ["nope"]',
  'Tool x (rejected):"text"',
];

describe('imitation grammar — whole lines', () => {
  it.each(HEADERS)('accepts header %j', (line) => {
    expect(isImitationHeaderLine(line)).toBe(true);
  });
  it.each(RESULT_LINES)('accepts results line %j', (line) => {
    expect(isImitationResultLine(line)).toBe(true);
  });
  it.each([
    '[Tool results are back]',
    '[Tool results from previous turn] and more',
    'user says [Tool results from previous turn]',
    'Tool list_emails (executed): it worked',
    'Tool list_emails (running): {}',
    'Tool (executed): {}',
    'Toolbox',
  ])('rejects %j', (line) => {
    expect(isImitationHeaderLine(line)).toBe(false);
    expect(isImitationResultLine(line)).toBe(false);
  });
});

describe('imitation grammar — prefixes', () => {
  it('every prefix of every accepted line is a potential prefix', () => {
    for (const line of [...HEADERS, ...RESULT_LINES]) {
      for (let i = 1; i <= line.length; i++) {
        const probe = line.slice(0, i);
        if (!probe.trim()) continue;
        expect(isPotentialImitationPrefix(probe), JSON.stringify(probe)).toBe(true);
      }
    }
  });

  it.each([
    '',
    '   ',
    'Looking.',
    'Tools I used:',
    'Tool list_emails ran fine',
    'user says hi',
    'Toolbox',
  ])('lets %j through', (line) => {
    expect(isPotentialImitationPrefix(line)).toBe(false);
  });
});

describe('fences (CommonMark closers)', () => {
  it('a closer may carry only trailing whitespace; an opener may carry an info string', () => {
    let open = fenceAfterLine(null, '```text');
    expect(open).toEqual({ char: '`', length: 3 });
    // ```not-a-close is CONTENT inside the open fence.
    expect(fenceAfterLine(open, '```not-a-close')).toBe(open);
    expect(fenceAfterLine(open, '```  ')).toBeNull();
    open = fenceAfterLine(null, '~~~ md');
    expect(fenceAfterLine(open, '```')).toBe(open);
    expect(fenceAfterLine(open, '~~')).toBe(open);
    expect(fenceAfterLine(open, '~~~~')).toBeNull();
  });

  it('a backtick opener whose info string contains a backtick is not a fence', () => {
    expect(fenceAfterLine(null, '``` a `b`')).toBeNull();
  });

  it('REGRESSION (Lumen, round 4): a quoted frame after ```not-a-close is still inside the fence', () => {
    const text =
      '```text\n```not-a-close\n[Tool results from previous turn]\nTool x (executed): {}\n```';
    expect(fenceOpenAtEnd('```text\n```not-a-close')).toBe(true);
    expect(fenceOpenAtEnd(text)).toBe(false);
  });
});
