/**
 * Authorization Service
 *
 * Handles group chat and user authorization for multi-platform support.
 * Controls who can interact with Myra and which groups she responds in.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { getRequestContext, getSessionContext } from '../utils/request-context';
import crypto from 'crypto';

export type TrustLevel = 'owner' | 'admin' | 'member';
export type Platform = 'telegram' | 'whatsapp' | 'discord' | 'slack';

interface TrustedUser {
  id: string;
  userId: string | null;
  workspaceId: string | null;
  platform: Platform;
  platformUserId: string;
  trustLevel: TrustLevel;
  addedBy: string | null;
  addedAt: Date;
}

interface AuthorizedGroup {
  id: string;
  workspaceId: string | null;
  platform: Platform;
  platformGroupId: string;
  groupName: string | null;
  authorizedBy: string | null;
  authorizedAt: Date;
  authorizationMethod: 'trusted_user' | 'challenge_code';
  status: 'active' | 'revoked';
}

export class AuthorizationService {
  private supabase: SupabaseClient;

  constructor() {
    // Use SUPABASE_SECRET_KEY (normalized from either SECRET_KEY or SERVICE_KEY in env.ts)
    this.supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
  }

  private resolveWorkspaceId(workspaceId?: string): string | undefined {
    // During rollout we allow callers to omit workspaceId for backward compatibility.
    // When available, prefer explicit arg, then request/session context.
    return workspaceId ?? getRequestContext()?.workspaceId ?? getSessionContext()?.workspaceId;
  }

  /**
   * Check if a user is trusted on a platform
   */
  async isUserTrusted(
    platform: Platform,
    platformUserId: string,
    workspaceId?: string
  ): Promise<TrustedUser | null> {
    const resolvedWorkspaceId = this.resolveWorkspaceId(workspaceId);
    let query = this.supabase
      .from('trusted_users')
      .select('*')
      .eq('platform', platform)
      .eq('platform_user_id', platformUserId);

    if (resolvedWorkspaceId) {
      query = query.eq('workspace_id', resolvedWorkspaceId);
    }

    const { data, error } = await query.single();

    if (error || !data) {
      return null;
    }

    return {
      id: data.id,
      userId: data.user_id,
      workspaceId: data.workspace_id,
      platform: data.platform,
      platformUserId: data.platform_user_id,
      trustLevel: data.trust_level,
      addedBy: data.added_by,
      addedAt: new Date(data.added_at),
    };
  }

  /**
   * Check if a group is authorized
   */
  async isGroupAuthorized(
    platform: Platform,
    platformGroupId: string,
    workspaceId?: string
  ): Promise<AuthorizedGroup | null> {
    const resolvedWorkspaceId = this.resolveWorkspaceId(workspaceId);
    let query = this.supabase
      .from('authorized_groups')
      .select('*')
      .eq('platform', platform)
      .eq('platform_group_id', platformGroupId)
      .eq('status', 'active');

    if (resolvedWorkspaceId) {
      query = query.eq('workspace_id', resolvedWorkspaceId);
    }

    const { data, error } = await query.single();

    if (error || !data) {
      return null;
    }

    return {
      id: data.id,
      workspaceId: data.workspace_id,
      platform: data.platform,
      platformGroupId: data.platform_group_id,
      groupName: data.group_name,
      authorizedBy: data.authorized_by,
      authorizedAt: new Date(data.authorized_at),
      authorizationMethod: data.authorization_method,
      status: data.status,
    };
  }

  /**
   * Generate a challenge code for group authorization
   * Only trusted users can generate codes
   */
  async generateChallengeCode(
    platform: Platform,
    platformUserId: string,
    workspaceId?: string
  ): Promise<string | null> {
    const resolvedWorkspaceId = this.resolveWorkspaceId(workspaceId);
    // Verify user is trusted
    const trustedUser = await this.isUserTrusted(platform, platformUserId, resolvedWorkspaceId);
    if (!trustedUser) {
      logger.warn('Non-trusted user attempted to generate challenge code', {
        platform,
        platformUserId,
      });
      return null;
    }

    // Check rate limit: max 5 active codes per user
    let countQuery = this.supabase
      .from('group_challenge_codes')
      .select('*', { count: 'exact', head: true })
      .eq('created_by', trustedUser.userId)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString());

    if (resolvedWorkspaceId) {
      countQuery = countQuery.eq('workspace_id', resolvedWorkspaceId);
    }

    const { count } = await countQuery;

    if (count && count >= 5) {
      logger.warn('User exceeded challenge code rate limit', { userId: trustedUser.userId });
      return null;
    }

    // Generate a 6-character alphanumeric code
    const code = crypto.randomBytes(3).toString('hex').toUpperCase();

    const { error } = await this.supabase.from('group_challenge_codes').insert({
      code,
      created_by: trustedUser.userId,
      workspace_id: resolvedWorkspaceId || null,
    });

    if (error) {
      logger.error('Failed to create challenge code', { error });
      return null;
    }

    logger.info('Challenge code generated', { code, userId: trustedUser.userId });
    return code;
  }

  /**
   * Authorize a group using a challenge code
   */
  async authorizeGroupWithCode(
    platform: Platform,
    platformGroupId: string,
    groupName: string | null,
    code: string,
    workspaceId?: string
  ): Promise<{ success: boolean; error?: string }> {
    const resolvedWorkspaceId = this.resolveWorkspaceId(workspaceId);
    // Find valid code
    let codeQuery = this.supabase
      .from('group_challenge_codes')
      .select('*')
      .eq('code', code.toUpperCase())
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString());

    if (resolvedWorkspaceId) {
      codeQuery = codeQuery.eq('workspace_id', resolvedWorkspaceId);
    }

    const { data: codeData, error: codeError } = await codeQuery.single();

    if (codeError || !codeData) {
      return { success: false, error: 'Invalid or expired code' };
    }

    // Check if group is already authorized
    const existing = await this.isGroupAuthorized(platform, platformGroupId, resolvedWorkspaceId);
    if (existing) {
      return { success: false, error: 'Group is already authorized' };
    }

    // Mark code as used
    await this.supabase
      .from('group_challenge_codes')
      .update({
        used_at: new Date().toISOString(),
        used_for_platform: platform,
        used_for_group_id: platformGroupId,
      })
      .eq('id', codeData.id);

    // Create authorized group
    const { error: groupError } = await this.supabase.from('authorized_groups').insert({
      platform,
      platform_group_id: platformGroupId,
      group_name: groupName,
      authorized_by: codeData.created_by,
      authorization_method: 'challenge_code',
      workspace_id: resolvedWorkspaceId || codeData.workspace_id || null,
    });

    if (groupError) {
      logger.error('Failed to authorize group', { error: groupError });
      return { success: false, error: 'Failed to authorize group' };
    }

    logger.info('Group authorized with challenge code', { platform, platformGroupId, code });
    return { success: true };
  }

  /**
   * Authorize a group directly (for trusted users adding bot to group)
   */
  async authorizeGroupByTrustedUser(
    platform: Platform,
    platformGroupId: string,
    groupName: string | null,
    platformUserId: string,
    workspaceId?: string
  ): Promise<{ success: boolean; error?: string }> {
    const resolvedWorkspaceId = this.resolveWorkspaceId(workspaceId);
    const trustedUser = await this.isUserTrusted(platform, platformUserId, resolvedWorkspaceId);
    if (!trustedUser) {
      return { success: false, error: 'User is not trusted' };
    }

    // Check if already authorized
    const existing = await this.isGroupAuthorized(platform, platformGroupId, resolvedWorkspaceId);
    if (existing) {
      return { success: true }; // Already authorized, that's fine
    }

    const { error } = await this.supabase.from('authorized_groups').insert({
      platform,
      platform_group_id: platformGroupId,
      group_name: groupName,
      authorized_by: trustedUser.userId,
      authorization_method: 'trusted_user',
      workspace_id: resolvedWorkspaceId || null,
    });

    if (error) {
      logger.error('Failed to authorize group', { error });
      return { success: false, error: 'Failed to authorize group' };
    }

    logger.info('Group authorized by trusted user', {
      platform,
      platformGroupId,
      userId: trustedUser.userId,
    });
    return { success: true };
  }

  /**
   * Revoke group authorization and leave the group
   * Returns the group ID so caller can call leaveChat
   */
  async revokeGroup(
    platform: Platform,
    platformGroupId: string,
    revokedByPlatformUserId: string,
    workspaceId?: string
  ): Promise<{ success: boolean; error?: string }> {
    const resolvedWorkspaceId = this.resolveWorkspaceId(workspaceId);
    // Verify user has permission (owner or admin)
    const trustedUser = await this.isUserTrusted(
      platform,
      revokedByPlatformUserId,
      resolvedWorkspaceId
    );
    if (!trustedUser || trustedUser.trustLevel === 'member') {
      return { success: false, error: 'Insufficient permissions' };
    }

    let revokeQuery = this.supabase
      .from('authorized_groups')
      .update({
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        revoked_by: trustedUser.userId,
      })
      .eq('platform', platform)
      .eq('platform_group_id', platformGroupId);

    if (resolvedWorkspaceId) {
      revokeQuery = revokeQuery.eq('workspace_id', resolvedWorkspaceId);
    }

    const { error } = await revokeQuery;

    if (error) {
      logger.error('Failed to revoke group', { error });
      return { success: false, error: 'Failed to revoke group' };
    }

    logger.info('Group authorization revoked', { platform, platformGroupId });
    return { success: true };
  }

  /**
   * Add a trusted user
   * Only owner can add admins; owner and admins can add members
   */
  async addTrustedUser(
    platform: Platform,
    platformUserId: string,
    trustLevel: TrustLevel,
    addedByPlatformUserId: string,
    userId?: string,
    workspaceId?: string
  ): Promise<{ success: boolean; error?: string }> {
    const resolvedWorkspaceId = this.resolveWorkspaceId(workspaceId);
    // Verify adder has permission
    const adder = await this.isUserTrusted(platform, addedByPlatformUserId, resolvedWorkspaceId);
    if (!adder) {
      return { success: false, error: 'You are not a trusted user' };
    }

    // Check permission hierarchy
    if (trustLevel === 'owner') {
      return { success: false, error: 'Cannot add another owner' };
    }
    if (trustLevel === 'admin' && adder.trustLevel !== 'owner') {
      return { success: false, error: 'Only owner can add admins' };
    }
    if (adder.trustLevel === 'member') {
      return { success: false, error: 'Members cannot add trusted users' };
    }

    // Check if already trusted
    const existing = await this.isUserTrusted(platform, platformUserId, resolvedWorkspaceId);
    if (existing) {
      return { success: false, error: 'User is already trusted' };
    }

    const { error } = await this.supabase.from('trusted_users').insert({
      user_id: userId || null,
      platform,
      platform_user_id: platformUserId,
      trust_level: trustLevel,
      added_by: adder.userId,
      workspace_id: resolvedWorkspaceId || null,
    });

    if (error) {
      logger.error('Failed to add trusted user', { error });
      return { success: false, error: 'Failed to add trusted user' };
    }

    logger.info('Trusted user added', {
      platform,
      platformUserId,
      trustLevel,
      addedBy: adder.userId,
    });
    return { success: true };
  }

  /**
   * List all authorized groups for a platform
   */
  async listAuthorizedGroups(
    platform?: Platform,
    workspaceId?: string
  ): Promise<AuthorizedGroup[]> {
    const resolvedWorkspaceId = this.resolveWorkspaceId(workspaceId);
    let query = this.supabase.from('authorized_groups').select('*').eq('status', 'active');

    if (platform) {
      query = query.eq('platform', platform);
    }
    if (resolvedWorkspaceId) {
      query = query.eq('workspace_id', resolvedWorkspaceId);
    }

    const { data, error } = await query;

    if (error || !data) {
      return [];
    }

    return data.map((g) => ({
      id: g.id,
      workspaceId: g.workspace_id,
      platform: g.platform,
      platformGroupId: g.platform_group_id,
      groupName: g.group_name,
      authorizedBy: g.authorized_by,
      authorizedAt: new Date(g.authorized_at),
      authorizationMethod: g.authorization_method,
      status: g.status,
    }));
  }

  /**
   * List all trusted users for a platform
   */
  async listTrustedUsers(platform?: Platform, workspaceId?: string): Promise<TrustedUser[]> {
    const resolvedWorkspaceId = this.resolveWorkspaceId(workspaceId);
    let query = this.supabase.from('trusted_users').select('*');

    if (platform) {
      query = query.eq('platform', platform);
    }
    if (resolvedWorkspaceId) {
      query = query.eq('workspace_id', resolvedWorkspaceId);
    }

    const { data, error } = await query;

    if (error || !data) {
      return [];
    }

    return data.map((u) => ({
      id: u.id,
      userId: u.user_id,
      workspaceId: u.workspace_id,
      platform: u.platform,
      platformUserId: u.platform_user_id,
      trustLevel: u.trust_level,
      addedBy: u.added_by,
      addedAt: new Date(u.added_at),
    }));
  }
}

// Singleton instance
let authServiceInstance: AuthorizationService | null = null;

export function getAuthorizationService(): AuthorizationService {
  if (!authServiceInstance) {
    authServiceInstance = new AuthorizationService();
  }
  return authServiceInstance;
}
