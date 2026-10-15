import { createSessionToolBatch, type SessionToolBatchPorts } from './session-tool-batch.js';
import { createStreamToolDispatch } from './stream-tool-dispatch.js';
import { createToolInvocationJournal, type ToolAttemptOwner } from './tool-invocation-journal.js';
import type { ToolSettlementSupervisor } from './tool-settlement-supervisor.js';

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
  supervisor: ToolSettlementSupervisor;
  owner: Pick<ToolAttemptOwner, 'turnId' | 'attemptId'>;
}) {
  if (options.enabled !== true) return undefined;
  const { ports } = options;
  if (
    options.journal.log !== options.ports.log ||
    options.journal.sessionId !== options.ports.sessionId ||
    options.supervisor.sessionId !== options.journal.sessionId
  ) {
    throw new Error('Tool stream must use its owning session journal');
  }
  const controller = new AbortController();
  let settleResources!: () => void;
  let failedRelease!: (error: unknown) => void;
  const resources = new Promise<void>((resolve, reject) => {
    settleResources = resolve;
    failedRelease = reject;
  });
  let stream: NonNullable<ReturnType<typeof createStreamToolDispatch>> | undefined;
  let batch: ReturnType<typeof createSessionToolBatch>;
  let finishing:
    | Promise<
        Awaited<ReturnType<NonNullable<typeof stream>['finish']>> & {
          records: typeof batch.records;
        }
      >
    | undefined;
  const stop = () => {
    controller.abort();
    if (stream) void finish({ endOfResponse: false }).catch(() => {});
  };
  // Reserve before the first journal flush: an opening write can itself hang.
  // Capacity or duplicate-owner refusal happens before any durable write/effect.
  const ownership = options.supervisor.track(
    { sessionId: options.journal.sessionId, ...options.owner },
    {
      settled: resources,
      requestStop: () => {
        stop();
        return undefined;
      },
    }
  );
  const externalStop = () => ownership.requestStop();
  ports.signal?.addEventListener('abort', externalStop, { once: true });
  if (ports.signal?.aborted) externalStop();
  try {
    const invocations = await options.journal.begin(options.owner);
    batch = createSessionToolBatch({ ...options.ports, signal: controller.signal, invocations });
    stream = createStreamToolDispatch({
      enabled: true,
      executor: batch.executor,
      onAdmission: (call) => batch.admit([call]),
    })!;
  } catch (error) {
    // No stream/effect was created, and the opening operation has now settled.
    ports.signal?.removeEventListener('abort', externalStop);
    settleResources();
    throw error;
  }
  if (controller.signal.aborted) stop();

  function finish(options: { endOfResponse: boolean }) {
    ownership.closeAdmission();
    return (finishing ??= (async () => {
      let result: Awaited<ReturnType<NonNullable<typeof stream>['finish']>>;
      let releaseFailure: { error: unknown } | undefined;
      // Known effects are retained even when persistence or bookkeeping
      // fails. The host must treat failure as a failed attempt, not retry it.
      try {
        result = await stream!.finish(options);
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
        ports.signal?.removeEventListener('abort', externalStop);
        // Unknown external effect and live resources are different states.
        // A release failure stays visible for explicit host reconciliation.
        if (releaseFailure) failedRelease(releaseFailure.error);
        else settleResources();
      }
      if (releaseFailure)
        result.failure ??= {
          kind: 'executor',
          message: `Tool context settlement failed: ${String(releaseFailure.error)}`,
        };
      return { ...result, records: batch.records };
    })());
  }
  return {
    signal: controller.signal,
    ownership,
    markGenerationEnded: () => ownership.markGenerationEnded(),
    append: (delta: string) => stream!.append(delta),
    finish,
  };
}
