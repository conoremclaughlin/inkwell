/** CLI non-persisting policy factory around the shared clone envelope. */
import { ToolPolicyState } from './tool-policy.js';
import {
  deriveClonePolicyWithFactory,
  type CloneEnvelope as SharedEnvelope,
  type DeriveClonePolicyOptions,
} from '@inklabs/shared/runtime';
export {
  CLONE_BASELINE_TOOLS,
  CLONE_DENIED_TOOLS,
  isForbiddenInClone,
  type DeriveClonePolicyOptions,
} from '@inklabs/shared/runtime';
export type CloneEnvelope = SharedEnvelope<ToolPolicyState>;
export function deriveClonePolicy(
  parent: ToolPolicyState,
  options: DeriveClonePolicyOptions = {}
): CloneEnvelope {
  return deriveClonePolicyWithFactory(
    parent,
    options,
    (mode) => new ToolPolicyState(mode, { persist: false })
  );
}
