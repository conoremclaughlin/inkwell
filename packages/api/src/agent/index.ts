/**
 * Agent Module
 *
 * Provides swappable agent backends for message processing.
 */

// Types
export * from './types';

// Backends
export { ClaudeCodeBackend, createClaudeCodeBackend } from './backends/claude-code.backend';
export type { ClaudeCodeConfig } from './backends/claude-code.backend';

export { InkBackend, createInkBackend } from './backends/ink.backend';
export type { InkConfig } from './backends/ink.backend';

// Tools
export {
  createInkCodingTools,
  getPiToolSchemas,
  createPiToolExecutor,
} from './tools/pi-coding-tools';
export type { InkToolDefinition, PiCodingToolsConfig } from './tools/pi-coding-tools';

// Manager
export { BackendManager, createBackendManager } from './backend-manager';
export type { BackendManagerConfig } from './backend-manager';
