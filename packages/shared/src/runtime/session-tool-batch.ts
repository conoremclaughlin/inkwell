import type { LocalToolCall, ToolResultRecord } from './agent-loop.js';
import { localToolLedgerLine } from './auto-evict.js';
import type { ContextImage } from './context-image.js';
import { recordContextImages } from './context-media.js';
import type { ContextLedger } from './context-ledger.js';
import { isClientLocalTool } from './context-tools.js';
import { compactForLedger } from './session-history.js';
import { createToolIntentCommitter } from './tool-intent.js';
import {
  executeToolCalls,
  type ToolCallExecutorPorts,
  type ToolCallResult,
} from './tool-call-executor.js';

export interface SessionToolBatchPorts extends Omit<
  ToolCallExecutorPorts,
  'commitIntent' | 'onResult'
> {
  ledger: ContextLedger;
  log: { append(event: Record<string, unknown>): number; flush(): Promise<void> };
  beginContextMutation(calls: ReadonlyArray<LocalToolCall>): () => void;
  /** Clone handoffs own a dedicated ledger entry; don't duplicate their summary. */
  isHandoffTool(tool: string): boolean;
  /** Consume the host's captured image descriptors, never raw bytes. */
  takeImages(result: ToolCallResult['result']): ContextImage[];
  /** Presentation/send accounting only; transcript and ledger are already updated. */
  onResult?(result: ToolCallResult): void;
}

/**
 * The parent session's existing policy/intent/tool/outcome sequence. Dispatch,
 * credential resolution, approvals and image caching are explicit host ports.
 * This layer preserves the original model args and records returned outcomes,
 * without asserting that an unknown external effect did not happen.
 */
export async function runSessionToolBatch(
  calls: LocalToolCall[],
  ports: SessionToolBatchPorts
): Promise<ToolResultRecord[]> {
  const iterationResults: ToolResultRecord[] = [];
  const settleMutation = ports.beginContextMutation(calls);
  try {
    await executeToolCalls(calls, {
      ...ports,
      commitIntent: createToolIntentCommitter(ports.log),
      onResult: (result) => {
        const common = {
          type: 'local_tool_call',
          invocationId: result.invocationId,
          dispatchState: result.dispatchState,
          tool: result.tool,
          args: result.args,
          status: result.status,
        };
        if (result.status === 'blocked' || result.status === 'denied') {
          ports.log.append({ ...common, reason: result.reason });
          ports.ledger.addEntry(
            'system',
            compactForLedger(`Local tool ${result.status} (${result.tool}): ${result.reason}`, 400),
            'local-tool'
          );
          iterationResults.push({
            tool: result.tool,
            result: result.reason,
            status: result.status,
          });
        } else if (result.status === 'error') {
          ports.log.append({ ...common, error: result.error });
          ports.ledger.addEntry(
            'system',
            compactForLedger(`Local tool error (${result.tool}): ${result.error}`, 400),
            'local-tool'
          );
          iterationResults.push({ tool: result.tool, result: result.error, status: 'error' });
        } else {
          // Re-inserting a list/eviction result reintroduces the context that
          // was just removed. Clone handoffs already inserted their own entry.
          const keep = !isClientLocalTool(result.tool) && !ports.isHandoffTool(result.tool);
          const images = keep ? ports.takeImages(result.result) : [];
          const content = compactForLedger(
            compactForLedger(
              localToolLedgerLine(result.tool, result.result, JSON.stringify(result.result)),
              500
            ) +
              (images.length > 0
                ? ` [${images.map((image) => `${image.ref} ${image.width}x${image.height}`).join(', ')} attached]`
                : ''),
            8192
          );
          const eid = ports.log.append({
            ...common,
            result: result.result,
            ...(images.length
              ? { imageContext: { version: 1, content, images: recordContextImages(images) } }
              : {}),
          });
          if (keep) {
            ports.ledger.addEntry(
              'system',
              content,
              'local-tool',
              images.length ? eid : undefined,
              undefined,
              images
            );
          }
          iterationResults.push({
            tool: result.tool,
            result: result.result,
            status: result.status,
            args: result.args,
          });
        }
        // Synchronous append reserves an eid; the next intent/turn flush
        // confirms persistence. A reporting error must not erase that record.
        ports.onResult?.(result);
      },
    });
  } finally {
    settleMutation();
  }
  return iterationResults;
}
