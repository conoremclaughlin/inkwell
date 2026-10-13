import { describe, expect, it } from 'vitest';
import { ImitationPreviewGuard } from './preview-guard.js';
import { ImitationPreviewGuard as SharedImitationPreviewGuard } from '@inklabs/shared/runtime';

describe('preview guard compatibility path', () => {
  it('re-exports the shared implementation', () => {
    expect(ImitationPreviewGuard).toBe(SharedImitationPreviewGuard);
  });
});
