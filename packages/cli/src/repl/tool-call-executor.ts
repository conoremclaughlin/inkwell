/** CLI host adapter for the shared policy/approval/intent execution sequence. */
import { randomUUID } from 'crypto';
import {
  executeToolCalls as executeSharedToolCalls,
  type LocalToolCall,
  type ToolCallResult,
  type ToolCallExecutorPorts,
} from '@inklabs/shared/runtime';
import type { ToolPolicyState } from './tool-policy.js';
import { impossibleCallRefusal } from './tool-dispatch.js';

export type { LocalToolCall, ToolCallResult } from '@inklabs/shared/runtime';
export type ToolCallExecutorDeps = Omit<
  ToolCallExecutorPorts,
  'mintInvocationId' | 'impossibleCallRefusal' | 'policy'
> & { policy: ToolPolicyState };

export function executeToolCalls(
  calls: LocalToolCall[],
  deps: ToolCallExecutorDeps
): Promise<ToolCallResult[]> {
  return executeSharedToolCalls(calls, {
    ...deps,
    mintInvocationId: randomUUID,
    impossibleCallRefusal,
  });
}
