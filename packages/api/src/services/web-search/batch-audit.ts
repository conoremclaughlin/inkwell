import { getAuditService } from '../audit';
import type { SearchBatchRecord } from './coordinator';

/** Account-scoped row; never folded into another caller's result or audit row. */
export async function recordSearchBatch(record: SearchBatchRecord): Promise<void> {
  const { queries, hits, ...observationCounts } = record.observations;
  await getAuditService().log(
    {
      userId: record.accountId,
      action: 'web_search_batch',
      category: 'network',
      target: 'provider-search',
      responseStatus: record.reason ? (record.searchMayHaveRun ? 'error' : 'blocked') : 'success',
      responseSummary: 'Batch settled; bounded stream observations, not proof of network execution',
      metadata: {
        batchId: record.batchId,
        contentRecording: record.contentRecording,
        searchMayHaveRun: record.searchMayHaveRun,
        ...(record.reason && { reason: record.reason }),
        observations: {
          ...observationCounts,
          // Enforce opt-out again at persistence, not just in the collector.
          ...(record.contentRecording && { queries, hits }),
        },
      },
    },
    { required: true }
  );
}
