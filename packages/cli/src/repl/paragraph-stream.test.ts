import { describe, expect, it } from 'vitest';
import { ParagraphStreamBuffer, StreamedTurnRenderer } from './paragraph-stream.js';
import {
  ParagraphStreamBuffer as SharedParagraphStreamBuffer,
  StreamedTurnRenderer as SharedStreamedTurnRenderer,
} from '@inklabs/shared/runtime';

describe('paragraph stream compatibility path', () => {
  it('re-exports the shared classes, not a second implementation', () => {
    expect(ParagraphStreamBuffer).toBe(SharedParagraphStreamBuffer);
    expect(StreamedTurnRenderer).toBe(SharedStreamedTurnRenderer);
  });
});
