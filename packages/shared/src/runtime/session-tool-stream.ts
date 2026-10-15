import { createSessionToolBatch, type SessionToolBatchPorts } from './session-tool-batch.js';
import { createStreamToolDispatch } from './stream-tool-dispatch.js';
import { createToolInvocationJournal, type ToolAttemptOwner } from './tool-invocation-journal.js';

/**
 * Incremental admission through the parent's existing session settlement path.
 * Hosts remain disconnected until attempt recovery and bounded teardown are
 * composed. A tool result still owns its journal, ledger, images and mutation
 * bookkeeping; generation ending does not release those resources early.
 */
export async function createSessionToolStream(options: {
  enabled?: boolean;
  ports: SessionToolBatchPorts;
  journal: ReturnType<typeof createToolInvocationJournal>;
  owner: Pick<ToolAttemptOwner, 'turnId' | 'attemptId'>;
}) {
  if (options.enabled !== true) return undefined;
  const { ports } = options;
  if (
    options.journal.log !== options.ports.log ||
    options.journal.sessionId !== options.ports.sessionId
  ) {
    throw new Error('Tool stream must use its owning session journal');
  }
  const invocations = await options.journal.begin(options.owner);
  const batch = createSessionToolBatch({ ...options.ports, invocations });
  const stream = createStreamToolDispatch({
    enabled: true,
    executor: batch.executor,
    onAdmission: (call) => batch.admit([call]),
  })!;
  let finishing:
    | Promise<Awaited<ReturnType<typeof stream.finish>> & { records: typeof batch.records }>
    | undefined;
  return {
    append: (delta: string) => stream.append(delta),
    finish(options: { endOfResponse: boolean }) {
      return (finishing ??= (async () => {
        let result: Awaited<ReturnType<typeof stream.finish>>;
        let releaseFailure: { error: unknown } | undefined;
        // Known effects are retained even when persistence or bookkeeping
        // fails. The host must treat failure as a failed attempt, not retry it.
        try {
          result = await stream.finish(options);
          try {
            await ports.log.flush();
          } catch (error) {
            result.failure ??= {
              kind: 'executor',
              message: `Tool outcome persistence failed: ${String(error)}`,
            };
          }
        } finally {
          try {
            batch.release();
          } catch (error) {
            releaseFailure = { error };
          }
        }
        if (releaseFailure)
          result.failure ??= {
            kind: 'executor',
            message: `Tool context settlement failed: ${String(releaseFailure.error)}`,
          };
        return { ...result, records: batch.records };
      })());
    },
  };
}
