import { describe, expect, it, vi } from 'vitest';
const log = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('../audit', () => ({ getAuditService: () => ({ log }) }));
import { recordSearchBatch } from './batch-audit';

describe('batch security audit', () => {
  it.each([true, false])(
    'requires the account-scoped row even with contentRecording=%s',
    async (contentRecording) => {
      const observations = {
        kind: 'unvalidated-stream-observations' as const,
        queryCount: 1,
        hitCount: 0,
        truncated: false,
        malformedLines: 0,
      };
      await recordSearchBatch({
        accountId: 'account-A',
        batchId: 'batch-A',
        contentRecording,
        searchMayHaveRun: true,
        reason: 'invalid_output',
        observations,
      });
      expect(log).toHaveBeenLastCalledWith(
        expect.objectContaining({
          userId: 'account-A',
          action: 'web_search_batch',
          responseStatus: 'error',
          metadata: {
            batchId: 'batch-A',
            contentRecording,
            searchMayHaveRun: true,
            reason: 'invalid_output',
            observations,
          },
        }),
        { required: true }
      );
    }
  );
  it('propagates a required write failure, never downgrades it to best effort', async () => {
    log.mockRejectedValueOnce(new Error('inert failed write'));
    await expect(
      recordSearchBatch({
        accountId: 'account-A',
        batchId: 'batch-A',
        contentRecording: false,
        searchMayHaveRun: false,
        reason: 'disabled',
        observations: {
          kind: 'unvalidated-stream-observations',
          queryCount: 0,
          hitCount: 0,
          truncated: false,
          malformedLines: 0,
        },
      })
    ).rejects.toThrow('inert failed write');
  });
});

it('the recorder independently strips raw fields when content recording is off', async () => {
  await recordSearchBatch({
    accountId: 'account-A',
    batchId: 'batch-A',
    contentRecording: false,
    searchMayHaveRun: true,
    observations: {
      kind: 'unvalidated-stream-observations',
      queryCount: 1,
      hitCount: 1,
      truncated: false,
      malformedLines: 0,
      queries: [{ query: 'private query', truncated: false }],
      hits: [{ title: 'private title', url: 'https://example.com/private', truncated: false }],
    },
  });
  expect(JSON.stringify(log.mock.lastCall)).not.toContain('private');
});
