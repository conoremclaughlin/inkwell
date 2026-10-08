/**
 * `@inklabs/shared/providers` — the backend provider layer: the adapters that
 * turn a turn request into a provider CLI's argv, env and stdin, their stream
 * parsers, and `startBackendTurn`, which spawns one provider turn.
 *
 * Node-only, unlike `@inklabs/shared/runtime`: a provider spawns a process
 * and reads the files its config lives in. Imported by its own path, never
 * through the package root. It depends on nothing outside this package, so
 * the CLI and a server host run the same code (`ink://specs/live-agent-surfaces`).
 * `providers-boundary.test.ts` checks that closure.
 */

export * from './types.js';
export * from './stream.js';
export * from './claude-stream.js';
export * from './claude.js';
export * from './codex.js';
export * from './gemini.js';
export * from './registry.js';
export * from './identity-prompt.js';
export * from './backend-runner.js';
export * from './turn-owner.js';
export * from './skill-mcp.js';
export * from './skill-servers.js';
export * from './skill-discovery.js';
export * from './session-provider.js';
export * from './session-agent-turn.js';
export * from './session-stream.js';
export * from './session-model.js';
export * from './session-compaction.js';
