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
