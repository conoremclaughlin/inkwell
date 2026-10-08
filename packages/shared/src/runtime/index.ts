/**
 * `@inklabs/shared/runtime` — the ink runtime's host-independent pieces.
 *
 * Imported by its own path, never through the package root: the root barrel
 * re-exports Node-only code (process spawning, filesystem config), and this
 * entry stays free of it. The rules are in `./README.md`, and
 * `runtime-boundary.test.ts` enforces them.
 */

export * from './agent-loop.js';
export {
  fenceAfterLine,
  fenceOpenAtEnd,
  isImitationHeaderLine,
  isImitationResultLine,
  type OpenFence,
} from './imitation-grammar.js';

export * from './context-ledger.js';
export type { ContextImage } from './context-image.js';
export * from './hook-registry.js';
export * from './builtin-hooks.js';

export * from './context-tools.js';
export * from './compaction.js';
export * from './token-usage.js';
export * from './session-log.js';

export * from './activity-render.js';
export * from './provider-sample.js';
export * from './auto-evict.js';
export * from './clone-outcomes.js';
export * from './session-history.js';
export * from './provider-recovery.js';
export * from './serial-input-drain.js';
export * from './session-turn.js';
export * from './session-prompt.js';
export * from './paragraph-stream.js';
export * from './preview-guard.js';
export * from './frame-fanout.js';
export * from './session-budget.js';
export * from './tool-call-executor.js';
export * from './tool-intent.js';
export * from './tool-policy.js';
export * from './tool-profiles.js';

export { bootstrapSessionIdentity, type SessionBootstrapPorts } from './session-bootstrap.js';

export * from './headless-session.js';
export * from './session-tool-batch.js';
export * from './session-usage.js';
export * from './context-limits.js';
export * from './context-pressure.js';
export * from './session-context-state.js';

export * from './tool-result.js';
export * from './coding-tool-names.js';
export * from './clone-capabilities.js';
export * from './spawn-agent.js';
export * from './tool-parameter-help.js';
export * from './local-tool-catalog.js';
export * from './tool-dispatch.js';

export * from './credential-resolver.js';

export * from './session-tools.js';
export * from './local-tool-instruction.js';
export * from './backend-tool-passthrough.js';

export * from './clone-registry.js';
export * from './clone-policy.js';
