/**
 * Permissions Service
 *
 * Manages user permissions for AI capabilities.
 * Permissions can be toggled per-user and translated to different backend formats.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export type PermissionId =
  | 'web_search'
  | 'web_fetch'
  | 'bash_curl'
  | 'bash_general'
  | 'file_read'
  | 'file_write'
  | 'mcp_tools';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type PermissionCategory = 'network' | 'filesystem' | 'execution';

export interface PermissionDefinition {
  id: PermissionId;
  name: string;
  description: string | null;
  category: PermissionCategory;
  riskLevel: RiskLevel;
  defaultEnabled: boolean;
}

export interface UserPermission {
  permissionId: PermissionId;
  enabled: boolean;
  grantedBy: string | null;
  grantedAt: Date;
  expiresAt: Date | null;
  reason: string | null;
}

export interface EffectivePermissions {
  userId: string;
  permissions: Map<PermissionId, boolean>;
  /** Permissions that are enabled */
  enabled: PermissionId[];
  /** Permissions that are disabled */
  disabled: PermissionId[];
}

export class PermissionsService {
  private supabase: SupabaseClient;
  private definitionsCache: Map<PermissionId, PermissionDefinition> | null = null;

  constructor() {
    this.supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
  }

  /**
   * Get all permission definitions
   */
  async getDefinitions(): Promise<Map<PermissionId, PermissionDefinition>> {
    if (this.definitionsCache) {
      return this.definitionsCache;
    }

    const { data, error } = await this.supabase.from('permission_definitions').select('*');

    if (error || !data) {
      logger.error('Failed to load permission definitions', { error });
      return new Map();
    }

    this.definitionsCache = new Map(
      data.map((d) => [
        d.id as PermissionId,
        {
          id: d.id as PermissionId,
          name: d.name,
          description: d.description,
          category: d.category as PermissionCategory,
          riskLevel: d.risk_level as RiskLevel,
          defaultEnabled: d.default_enabled,
        },
      ])
    );

    return this.definitionsCache;
  }

  /**
   * Get effective permissions for a user
   * Combines defaults with user-specific overrides
   */
  async getEffectivePermissions(userId: string): Promise<EffectivePermissions> {
    const definitions = await this.getDefinitions();

    // Start with defaults
    const permissions = new Map<PermissionId, boolean>();
    for (const [id, def] of definitions) {
      permissions.set(id, def.defaultEnabled);
    }

    // Apply user overrides
    const { data: overrides } = await this.supabase
      .from('user_permissions')
      .select('*')
      .eq('user_id', userId)
      .or('expires_at.is.null,expires_at.gt.now()');

    if (overrides) {
      for (const override of overrides) {
        permissions.set(override.permission_id as PermissionId, override.enabled);
      }
    }

    // Build enabled/disabled lists
    const enabled: PermissionId[] = [];
    const disabled: PermissionId[] = [];

    for (const [id, isEnabled] of permissions) {
      if (isEnabled) {
        enabled.push(id);
      } else {
        disabled.push(id);
      }
    }

    return { userId, permissions, enabled, disabled };
  }

  /**
   * Check if a user has a specific permission
   */
  async hasPermission(userId: string, permissionId: PermissionId): Promise<boolean> {
    const effective = await this.getEffectivePermissions(userId);
    return effective.permissions.get(permissionId) ?? false;
  }

  /**
   * Set a permission for a user
   */
  async setPermission(
    userId: string,
    permissionId: PermissionId,
    enabled: boolean,
    options?: {
      grantedBy?: string;
      expiresAt?: Date;
      reason?: string;
    }
  ): Promise<{ success: boolean; error?: string }> {
    const { error } = await this.supabase.from('user_permissions').upsert(
      {
        user_id: userId,
        permission_id: permissionId,
        enabled,
        granted_by: options?.grantedBy || null,
        granted_at: new Date().toISOString(),
        expires_at: options?.expiresAt?.toISOString() || null,
        reason: options?.reason || null,
      },
      { onConflict: 'user_id,permission_id' }
    );

    if (error) {
      logger.error('Failed to set permission', { error, userId, permissionId });
      return { success: false, error: error.message };
    }

    logger.info('Permission updated', { userId, permissionId, enabled, reason: options?.reason });
    return { success: true };
  }

  /**
   * Reset a user's permission to default
   */
  async resetPermission(userId: string, permissionId: PermissionId): Promise<void> {
    await this.supabase
      .from('user_permissions')
      .delete()
      .eq('user_id', userId)
      .eq('permission_id', permissionId);

    logger.info('Permission reset to default', { userId, permissionId });
  }

  /**
   * Get user's permission overrides (not including defaults)
   */
  async getUserOverrides(userId: string): Promise<UserPermission[]> {
    const { data, error } = await this.supabase
      .from('user_permissions')
      .select('*')
      .eq('user_id', userId);

    if (error || !data) {
      return [];
    }

    return data.map((p) => ({
      permissionId: p.permission_id as PermissionId,
      enabled: p.enabled,
      grantedBy: p.granted_by,
      grantedAt: new Date(p.granted_at),
      expiresAt: p.expires_at ? new Date(p.expires_at) : null,
      reason: p.reason,
    }));
  }
}

// Singleton
let permissionsServiceInstance: PermissionsService | null = null;

export function getPermissionsService(): PermissionsService {
  if (!permissionsServiceInstance) {
    permissionsServiceInstance = new PermissionsService();
  }
  return permissionsServiceInstance;
}
