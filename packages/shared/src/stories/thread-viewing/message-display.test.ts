import { describe, expect, it } from 'vitest';
import { FOLD_CHARS, FOLD_LINES, messageLabel, shouldFold } from './message-display.js';

describe('shouldFold', () => {
  it('folds past the character limit, and not at it', () => {
    expect(shouldFold('x'.repeat(FOLD_CHARS))).toBe(false);
    expect(shouldFold('x'.repeat(FOLD_CHARS + 1))).toBe(true);
  });

  it('folds past the line limit, and not at it', () => {
    expect(shouldFold(Array(FOLD_LINES).fill('a').join('\n'))).toBe(false);
    expect(
      shouldFold(
        Array(FOLD_LINES + 1)
          .fill('a')
          .join('\n')
      )
    ).toBe(true);
  });

  it('leaves an ordinary message open', () => {
    expect(shouldFold('Round 2 — approve.\n\nOne nit below.')).toBe(false);
  });
});

describe('messageLabel', () => {
  it('names the known types, and spells out any other', () => {
    expect(messageLabel('task_request')).toBe('task request');
    expect(messageLabel('session_resume')).toBe('resume');
    expect(messageLabel('some_new_type')).toBe('some new type');
  });
});
