import { describe, expect, it } from 'vitest';
import { collectFinalReplyText } from './turn-reply.js';

describe('the non-interactive run reply', () => {
  it('retains the reply when a later outer turn only signals completion', () => {
    const first = collectFinalReplyText(null, 'The example is ready.');
    expect(collectFinalReplyText(first, '(local tool call emitted; see tool results above)')).toBe(
      first
    );
    expect(collectFinalReplyText(first, '<invoke name="signal_status"></invoke>')).toBe(first);
  });
  it('prefers a later correction, without searching a prior run transcript', () => {
    expect(collectFinalReplyText('Earlier answer.', 'Corrected answer.')).toBe('Corrected answer.');
    expect(collectFinalReplyText(null, null)).toBeNull();
  });
});
