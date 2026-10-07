/**
 * Path media and a person's uploads share `metadata.media`. The path resolver
 * leaves `{ upload }` entries to services/uploads/dispatch.ts, and still drops
 * anything else malformed, scalars included, without failing the dispatch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mockWarn = vi.fn();
vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: (...a: unknown[]) => mockWarn(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { resolveTriggerMedia } from './agent-media';

let root: string;

beforeEach(async () => {
  mockWarn.mockReset();
  root = await mkdtemp(join(tmpdir(), 'agent-media-uploads-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveTriggerMedia with uploads and scalars', () => {
  it('drops scalar entries as malformed, never throwing', async () => {
    await expect(
      resolveTriggerMedia({ media: ['bad', 1, true, null] }, { mediaRoot: root })
    ).resolves.toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith('[Trigger] malformed media entries dropped', {
      count: 4,
    });
  });

  it('leaves upload entries to the upload resolver, not counting them as malformed', async () => {
    await expect(
      resolveTriggerMedia(
        { media: [{ upload: '5a5a5a5a-0000-4000-8000-000000000001' }] },
        { mediaRoot: root }
      )
    ).resolves.toEqual([]);
    expect(mockWarn).not.toHaveBeenCalledWith(
      '[Trigger] malformed media entries dropped',
      expect.anything()
    );
  });
});
