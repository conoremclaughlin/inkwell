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

export { DirectApiBackend, createDirectApiBackend } from './backends/direct-api.backend';
export type { DirectApiConfig } from './backends/direct-api.backend';

// Manager
export { BackendManager, createBackendManager } from './backend-manager';
export type { BackendManagerConfig } from './backend-manager';
