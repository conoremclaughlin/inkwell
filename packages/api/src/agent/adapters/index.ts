/**
 * Backend Permission Adapters
 *
 * Registry and exports for permission adapters.
 * Add new adapters here as we support more backends.
 */

import type { PermissionAdapter, AdapterRegistry } from './types';
import { getClaudeCodeAdapter } from './claude-code.adapter';

export * from './types';
export * from './claude-code.adapter';

/**
 * Simple adapter registry implementation
 */
class SimpleAdapterRegistry implements AdapterRegistry {
  private adapters = new Map<string, PermissionAdapter>();

  register(adapter: PermissionAdapter): void {
    this.adapters.set(adapter.backendId, adapter);
  }

  get(backendId: string): PermissionAdapter | undefined {
    return this.adapters.get(backendId);
  }

  list(): PermissionAdapter[] {
    return Array.from(this.adapters.values());
  }
}

// Global registry singleton
let registryInstance: SimpleAdapterRegistry | null = null;

/**
 * Get the global adapter registry
 * Automatically registers built-in adapters on first call
 */
export function getAdapterRegistry(): AdapterRegistry {
  if (!registryInstance) {
    registryInstance = new SimpleAdapterRegistry();

    // Register built-in adapters
    registryInstance.register(getClaudeCodeAdapter());

    // Future adapters would be registered here:
    // registryInstance.register(getInkAdapter());
    // registryInstance.register(getOpenAiAdapter());
  }
  return registryInstance;
}

/**
 * Convenience function to get adapter for a backend
 */
export function getAdapter(backendId: string): PermissionAdapter | undefined {
  return getAdapterRegistry().get(backendId);
}
