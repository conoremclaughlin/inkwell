/**
 * A conversation's mode as a request names it and as a retry is held to it
 * (conversation-mode.ts; send-receipt.ts createRequestOf, createIntentOf,
 * matchesCreateIntent).
 */

import { describe, expect, it } from 'vitest';
import { parseConversationMode, storedConversationMode } from './conversation-mode';
import { createIntentOf, createRequestOf, matchesCreateIntent } from '../send-receipt';

describe('parseConversationMode', () => {
  it('reads absent as no mode', () => {
    expect(parseConversationMode(undefined)).toEqual({ ok: true, mode: null });
    expect(parseConversationMode(null)).toEqual({ ok: true, mode: null });
  });

  it('takes exactly public or private', () => {
    expect(parseConversationMode('public')).toEqual({ ok: true, mode: 'public' });
    expect(parseConversationMode('private')).toEqual({ ok: true, mode: 'private' });
  });

  it.each([['Public'], [' private'], ['shared'], [''], [0], [false], [{}], [['public']]])(
    'refuses %j rather than guessing',
    (raw) => {
      expect(parseConversationMode(raw)).toEqual({ ok: false });
    }
  );
});

describe('storedConversationMode', () => {
  it('passes a mode through and reads anything else as none', () => {
    expect(storedConversationMode('private')).toBe('private');
    expect(storedConversationMode(null)).toBeNull();
    expect(storedConversationMode(undefined)).toBeNull();
    expect(storedConversationMode('PRIVATE')).toBeNull();
  });
});

describe('a create request and its intent carry the mode it named', () => {
  const ID = '33333333-3333-4333-8333-333333333333';

  it('records a mode only when one was named, so older records keep their shape', () => {
    expect(createRequestOf(['Pip'], '')).toEqual({ recipients: ['pip'], title: null });
    expect(createRequestOf(['pip'], '', 'public')).toEqual({
      recipients: ['pip'],
      title: null,
      mode: 'public',
    });
    expect(createIntentOf(ID, createRequestOf(['pip'], ''), 'hi', null)).not.toHaveProperty('mode');
    expect(createIntentOf(ID, createRequestOf(['pip'], '', 'private'), 'hi', null)).toMatchObject({
      mode: 'private',
    });
  });

  it('matches a retry naming the same mode, and none naming another or none', () => {
    const intent = (mode: 'public' | 'private' | null) => ({
      createIntent: createIntentOf(ID, createRequestOf(['pip'], '', mode), 'hi', null),
    });
    const retry = (mode: 'public' | 'private' | null) => createRequestOf(['pip'], '', mode);
    expect(matchesCreateIntent(intent('private'), ID, retry('private'), 'hi', null)).toBe(true);
    expect(matchesCreateIntent(intent('private'), ID, retry('public'), 'hi', null)).toBe(false);
    expect(matchesCreateIntent(intent('private'), ID, retry(null), 'hi', null)).toBe(false);
    // An intent recorded before modes existed named none.
    expect(matchesCreateIntent(intent(null), ID, retry(null), 'hi', null)).toBe(true);
    expect(matchesCreateIntent(intent(null), ID, retry('public'), 'hi', null)).toBe(false);
  });
});
