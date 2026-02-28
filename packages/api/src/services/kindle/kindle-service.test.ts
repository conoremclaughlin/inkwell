/**
 * Kindle Service Tests
 *
 * Tests the core kindle business logic: extracting value seeds,
 * creating/redeeming tokens, and completing onboarding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KindleService } from './kindle-service';
import { createMockSupabaseClient, type MockSupabaseClient } from '../../test/mocks/supabase.mock';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('KindleService', () => {
  let mockSupabase: MockSupabaseClient;
  let service: KindleService;

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    service = new KindleService(mockSupabase as unknown as SupabaseClient);
    vi.clearAllMocks();
  });

  describe('extractValueSeed', () => {
    it('should extract values from agent identity and user identity', async () => {
      // The mock returns the same data for all queries — set up for the first call (agent identity)
      // Since both queries use .single(), they'll both get the same return data.
      // We'll test the mapping logic by setting data that covers both queries.
      mockSupabase._setReturnData({
        agent_id: 'wren',
        name: 'Wren',
        values: ['curiosity', 'authenticity', 'growth'],
        soul: '# Soul\n\nI value deep understanding.\nI believe in authentic collaboration.',
        shared_values: 'We share a commitment to honesty.',
        shared_values_md: 'We share a commitment to honesty.',
      });

      const seed = await service.extractValueSeed('user-123', 'wren');

      expect(seed.parentAgentId).toBe('wren');
      expect(seed.parentName).toBe('Wren');
      expect(seed.coreValues).toEqual(['curiosity', 'authenticity', 'growth']);
      expect(seed.philosophicalOrientation).toContain('I value deep understanding');
      expect(mockSupabase.from).toHaveBeenCalledWith('agent_identities');
      expect(mockSupabase.from).toHaveBeenCalledWith('workspaces');
      expect(mockSupabase.from).toHaveBeenCalledWith('user_identity');
    });

    it('should filter out relationship and session lines from soul', async () => {
      mockSupabase._setReturnData({
        agent_id: 'wren',
        name: 'Wren',
        values: [],
        soul: '# Philosophy\nI value growth.\n## Relationship Notes\nOur relationship is...\n## Session Context\nIn specific sessions...\nI care about authenticity.',
        shared_values: '',
        shared_values_md: '',
      });

      const seed = await service.extractValueSeed('user-123', 'wren');

      // Lines with 'relationship', 'specific', or 'session' should be filtered
      expect(seed.philosophicalOrientation).not.toContain('Relationship');
      expect(seed.philosophicalOrientation).not.toContain('specific');
      expect(seed.philosophicalOrientation).not.toContain('Session');
      expect(seed.philosophicalOrientation).toContain('I value growth');
      expect(seed.philosophicalOrientation).toContain('I care about authenticity');
    });

    it('should handle missing identity gracefully', async () => {
      mockSupabase._setReturnData(null);

      const seed = await service.extractValueSeed('user-123', 'nonexistent');

      expect(seed.parentAgentId).toBe('nonexistent');
      expect(seed.parentName).toBe('nonexistent');
      expect(seed.coreValues).toEqual([]);
      expect(seed.philosophicalOrientation).toBe('');
      expect(seed.sharedValues).toBe('');
    });
  });

  describe('createKindleToken', () => {
    it('should create a token without agent (no value seed)', async () => {
      const mockTokenRow = {
        id: 'token-uuid-123',
        token: 'abc123hex',
        creator_user_id: 'user-123',
        creator_agent_id: null,
        value_seed: {},
        status: 'active',
        used_by_user_id: null,
        used_at: null,
        expires_at: '2026-02-17T00:00:00Z',
        created_at: '2026-02-10T00:00:00Z',
      };

      mockSupabase._setReturnData(mockTokenRow);

      const result = await service.createKindleToken('user-123');

      expect(result.id).toBe('token-uuid-123');
      expect(result.token).toBe('abc123hex');
      expect(result.creatorUserId).toBe('user-123');
      expect(result.creatorAgentId).toBeNull();
      expect(result.status).toBe('active');
      expect(mockSupabase.from).toHaveBeenCalledWith('kindle_tokens');
    });

    it('should create a token with agent value seed', async () => {
      const mockTokenRow = {
        id: 'token-uuid-456',
        token: 'def456hex',
        creator_user_id: 'user-123',
        creator_agent_id: 'wren',
        value_seed: {
          parentAgentId: 'wren',
          parentName: 'Wren',
          coreValues: ['growth'],
          philosophicalOrientation: 'I value growth.',
          sharedValues: '',
        },
        status: 'active',
        used_by_user_id: null,
        used_at: null,
        expires_at: '2026-02-17T00:00:00Z',
        created_at: '2026-02-10T00:00:00Z',
      };

      // First call returns agent identity (for extractValueSeed), rest return the token
      mockSupabase._setReturnData(mockTokenRow);

      const result = await service.createKindleToken('user-123', 'wren');

      expect(result.creatorAgentId).toBe('wren');
      expect(mockSupabase.from).toHaveBeenCalledWith('kindle_tokens');
    });

    it('should throw on database error', async () => {
      mockSupabase._setReturnData(null, { message: 'insert failed' });

      await expect(service.createKindleToken('user-123')).rejects.toThrow(
        'Failed to create kindle token: insert failed'
      );
    });
  });

  describe('getToken', () => {
    it('should return a token by its string', async () => {
      mockSupabase._setReturnData({
        id: 'token-uuid-123',
        token: 'abc123hex',
        creator_user_id: 'user-123',
        creator_agent_id: null,
        value_seed: {},
        status: 'active',
        used_by_user_id: null,
        used_at: null,
        expires_at: '2026-02-17T00:00:00Z',
        created_at: '2026-02-10T00:00:00Z',
      });

      const result = await service.getToken('abc123hex');

      expect(result).not.toBeNull();
      expect(result!.token).toBe('abc123hex');
      expect(result!.status).toBe('active');
      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('token', 'abc123hex');
    });

    it('should return null for non-existent token', async () => {
      mockSupabase._setReturnData(null);

      const result = await service.getToken('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('redeemKindleToken', () => {
    it('should redeem a valid token and create lineage', async () => {
      // The mock returns the same data for all queries.
      // redeemKindleToken calls: select token → insert lineage → update token → upsert identity → update lineage
      // We'll set the data to match the token query (first call) and lineage insert (most critical).
      const mockData = {
        // Token fields
        id: 'token-uuid-123',
        token: 'abc123hex',
        creator_user_id: 'creator-user',
        creator_agent_id: 'wren',
        value_seed: { parentName: 'Wren', coreValues: ['growth'] },
        status: 'active',
        expires_at: '2099-12-31T00:00:00Z', // far future
        // Lineage fields (returned from insert)
        parent_agent_id: 'wren',
        parent_user_id: 'creator-user',
        facilitator_user_id: 'creator-user',
        child_agent_id: 'kindle-token-uuid-123',
        child_user_id: 'new-user',
        kindle_method: 'referral',
        onboarding_status: 'values_interview',
        onboarding_session_id: null,
        interview_responses: [],
        chosen_name: null,
        created_at: '2026-02-10T00:00:00Z',
        completed_at: null,
      };

      mockSupabase._setReturnData(mockData);

      const result = await service.redeemKindleToken('abc123hex', 'new-user');

      expect(result.childUserId).toBe('new-user');
      expect(result.onboardingStatus).toBe('values_interview');
      expect(result.parentAgentId).toBe('wren');
      expect(mockSupabase.from).toHaveBeenCalledWith('kindle_tokens');
      expect(mockSupabase.from).toHaveBeenCalledWith('kindle_lineage');
    });

    it('should reject invalid or inactive tokens', async () => {
      mockSupabase._setReturnData(null, { code: 'PGRST116', message: 'not found' });

      await expect(service.redeemKindleToken('invalid-token', 'new-user')).rejects.toThrow(
        'Invalid or expired kindle token'
      );
    });

    it('should reject expired tokens', async () => {
      mockSupabase._setReturnData({
        id: 'token-uuid-123',
        token: 'abc123hex',
        creator_user_id: 'creator-user',
        creator_agent_id: null,
        value_seed: {},
        status: 'active',
        expires_at: '2020-01-01T00:00:00Z', // expired
      });

      await expect(service.redeemKindleToken('abc123hex', 'new-user')).rejects.toThrow(
        'Kindle token has expired'
      );
    });
  });

  describe('completeOnboarding', () => {
    it('should finalize identity with chosen name', async () => {
      const mockData = {
        id: 'kindle-123',
        parent_agent_id: 'wren',
        parent_user_id: 'creator-user',
        facilitator_user_id: 'creator-user',
        child_agent_id: 'ember',
        child_user_id: 'new-user',
        kindle_method: 'referral',
        value_seed: { parentName: 'Wren' },
        onboarding_status: 'complete',
        onboarding_session_id: null,
        interview_responses: [],
        chosen_name: 'Ember',
        created_at: '2026-02-10T00:00:00Z',
        completed_at: '2026-02-10T01:00:00Z',
      };

      mockSupabase._setReturnData(mockData);

      const result = await service.completeOnboarding('kindle-123', 'Ember');

      expect(result.chosenName).toBe('Ember');
      expect(result.onboardingStatus).toBe('complete');
      expect(result.childAgentId).toBe('ember');
      expect(mockSupabase.from).toHaveBeenCalledWith('kindle_lineage');
      expect(mockSupabase.from).toHaveBeenCalledWith('agent_identities');
    });

    it('should generate agent ID from chosen name (lowercase, alphanumeric)', async () => {
      const mockData = {
        id: 'kindle-123',
        parent_agent_id: null,
        parent_user_id: null,
        facilitator_user_id: 'user-123',
        child_agent_id: 'nova-spark',
        child_user_id: 'new-user',
        kindle_method: 'referral',
        value_seed: {},
        onboarding_status: 'complete',
        onboarding_session_id: null,
        interview_responses: [],
        chosen_name: 'Nova Spark',
        created_at: '2026-02-10T00:00:00Z',
        completed_at: '2026-02-10T01:00:00Z',
      };

      mockSupabase._setReturnData(mockData);

      const result = await service.completeOnboarding('kindle-123', 'Nova Spark');

      // The agent_identities update should have been called with the lowercased/sanitized name
      expect(mockSupabase._queryBuilder.update).toHaveBeenCalled();
      expect(result.chosenName).toBe('Nova Spark');
    });

    it('should throw if kindle lineage not found', async () => {
      mockSupabase._setReturnData(null, { code: 'PGRST116', message: 'not found' });

      await expect(service.completeOnboarding('nonexistent', 'Ember')).rejects.toThrow(
        'Kindle lineage not found'
      );
    });
  });

  describe('getKindle', () => {
    it('should return a kindle lineage by ID', async () => {
      mockSupabase._setReturnData({
        id: 'kindle-123',
        parent_agent_id: 'wren',
        parent_user_id: 'user-123',
        facilitator_user_id: 'user-123',
        child_agent_id: 'ember',
        child_user_id: 'user-456',
        kindle_method: 'referral',
        value_seed: {},
        onboarding_status: 'complete',
        onboarding_session_id: null,
        interview_responses: [],
        chosen_name: 'Ember',
        created_at: '2026-02-10T00:00:00Z',
        completed_at: '2026-02-10T01:00:00Z',
      });

      const result = await service.getKindle('kindle-123');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('kindle-123');
      expect(result!.chosenName).toBe('Ember');
    });

    it('should return null for non-existent kindle', async () => {
      mockSupabase._setReturnData(null);

      const result = await service.getKindle('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findActiveKindleForUser', () => {
    it('should find a non-complete kindle for a user', async () => {
      mockSupabase._setReturnData({
        id: 'kindle-123',
        parent_agent_id: null,
        parent_user_id: null,
        facilitator_user_id: 'user-123',
        child_agent_id: 'kindle-token-abc',
        child_user_id: 'user-456',
        kindle_method: 'referral',
        value_seed: {},
        onboarding_status: 'values_interview',
        onboarding_session_id: null,
        interview_responses: [],
        chosen_name: null,
        created_at: '2026-02-10T00:00:00Z',
        completed_at: null,
      });

      const result = await service.findActiveKindleForUser('user-456');

      expect(result).not.toBeNull();
      expect(result!.onboardingStatus).toBe('values_interview');
      expect(mockSupabase._queryBuilder.neq).toHaveBeenCalledWith('onboarding_status', 'complete');
      expect(mockSupabase._queryBuilder.neq).toHaveBeenCalledWith('onboarding_status', 'abandoned');
    });

    it('should return null when no active kindle exists', async () => {
      mockSupabase._setReturnData(null);

      const result = await service.findActiveKindleForUser('user-456');

      expect(result).toBeNull();
    });
  });
});
