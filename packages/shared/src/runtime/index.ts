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
