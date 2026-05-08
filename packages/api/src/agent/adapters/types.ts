/**
 * Backend Permission Adapter Types
 *
 * Defines the interface for translating PCP permissions to backend-specific formats.
 * Each backend (Claude Code, Direct API, future models) implements this interface.
 */

import type { EffectivePermissions, PermissionId } from '../../services/permissions';

/**
 * Backend-specific permission configuration
 * Each backend returns its own format for configuring permissions
 */
export interface BackendPermissionConfig {
  /** Backend identifier */
  backend: string;

  /** Raw configuration to pass to the backend */
  config: Record<string, unknown>;

  /** Human-readable summary of what's enabled/disabled */
  summary: {
    enabled: string[];
    disabled: string[];
  };
}

/**
 * Permission adapter interface
 * Implement this for each backend to translate PCP permissions
 */
export interface PermissionAdapter {
  /** Backend identifier (e.g., 'claude-code', 'ink') */
  readonly backendId: string;

  /**
   * Translate PCP permissions to backend-specific configuration
   */
  translate(permissions: EffectivePermissions): BackendPermissionConfig;

  /**
   * Get the list of PCP permissions this adapter supports
   */
  getSupportedPermissions(): PermissionId[];

  /**
   * Check if a specific permission is supported by this backend
   */
  supportsPermission(permissionId: PermissionId): boolean;
}

/**
 * Adapter registry for managing multiple backends
 */
export interface AdapterRegistry {
  /**
   * Register an adapter
   */
  register(adapter: PermissionAdapter): void;

  /**
   * Get adapter for a backend
   */
  get(backendId: string): PermissionAdapter | undefined;

  /**
   * List all registered adapters
   */
  list(): PermissionAdapter[];
}
