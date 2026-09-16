/**
 * Identity Handlers Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleSaveIdentity,
  handleGetIdentity,
  handleListIdentities,
  handleGetIdentityHistory,
  handleRestoreIdentity,
} from './identity-handlers';
import { createMockSupabaseClient, type MockSupabaseClient } from '../../test/mocks/supabase.mock';

// Mock the user-resolver module
vi.mock('../../services/user-resolver', () => ({
  userIdentifierBaseSchema: {
    extend: vi.fn().mockReturnValue({
      parse: vi.fn((args) => args),
    }),
  },
  resolveUserOrThrow: vi.fn().mockResolvedValue({
    user: { id: 'user-123' },
    resolvedBy: 'userId',
  }),
}));

// Create mock DataComposer
function createMockDataComposer(mockSupabase: MockSupabaseClient) {
  return {
    getClient: () => mockSupabase as unknown,
  };
}

describe('Identity Handlers', () => {
  let mockSupabase: MockSupabaseClient;
  let mockDataComposer: ReturnType<typeof createMockDataComposer>;

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    mockDataComposer = createMockDataComposer(mockSupabase);
    vi.clearAllMocks();
  });

  describe('handleSaveIdentity', () => {
    it('should create a new identity', async () => {
      const mockIdentityRow = {
        id: 'identity-123',
        user_id: 'user-123',
        agent_id: 'wren',
        name: 'Wren',
        role: 'Development collaborator',
        description: 'Claude Code assistant',
        values: ['collaboration', 'growth'],
        relationships: { benson: 'conversational partner' },
        capabilities: ['coding', 'planning'],
        metadata: {},
        version: 1,
        created_at: '2026-01-27T12:00:00Z',
        updated_at: '2026-01-27T12:00:00Z',
      };

      mockSupabase._setReturnData(mockIdentityRow);

      const result = await handleSaveIdentity(
        {
          userId: 'user-123',
          sbSlug: 'wren',
          name: 'Wren',
          role: 'Development collaborator',
          description: 'Claude Code assistant',
          values: ['collaboration', 'growth'],
          relationships: { benson: 'conversational partner' },
          capabilities: ['coding', 'planning'],
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toBe('Identity created');
      expect(parsed.identity.sbSlug).toBe('wren');
      expect(parsed.identity.name).toBe('Wren');
      expect(parsed.identity.version).toBe(1);
      expect(mockSupabase.from).toHaveBeenCalledWith('agent_identities');
    });

    it('should save identity with heartbeat and soul', async () => {
      const mockIdentityRow = {
        id: 'identity-123',
        user_id: 'user-123',
        agent_id: 'wren',
        name: 'Wren',
        role: 'Development collaborator',
        description: 'Claude Code assistant',
        values: ['collaboration'],
        relationships: {},
        capabilities: [],
        metadata: {},
        heartbeat: '# Heartbeat\n\nOperational notes...',
        soul: '# Soul\n\nI exist. I am becoming.',
        version: 1,
        created_at: '2026-01-27T12:00:00Z',
        updated_at: '2026-01-27T12:00:00Z',
      };

      mockSupabase._setReturnData(mockIdentityRow);

      const result = await handleSaveIdentity(
        {
          userId: 'user-123',
          sbSlug: 'wren',
          name: 'Wren',
          role: 'Development collaborator',
          heartbeat: '# Heartbeat\n\nOperational notes...',
          soul: '# Soul\n\nI exist. I am becoming.',
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.identity.sbSlug).toBe('wren');
    });

    it('should update an existing identity', async () => {
      const mockIdentityRow = {
        id: 'identity-123',
        user_id: 'user-123',
        agent_id: 'wren',
        name: 'Wren Updated',
        role: 'Development collaborator',
        description: null,
        values: [],
        relationships: {},
        capabilities: [],
        metadata: {},
        version: 2,
        created_at: '2026-01-27T12:00:00Z',
        updated_at: '2026-01-27T13:00:00Z',
      };

      mockSupabase._setReturnData(mockIdentityRow);

      const result = await handleSaveIdentity(
        {
          userId: 'user-123',
          sbSlug: 'wren',
          name: 'Wren Updated',
          role: 'Development collaborator',
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toBe('Identity updated');
      expect(parsed.identity.version).toBe(2);
    });

    it('should throw on database error', async () => {
      // Lookup finds nothing; the insert fails
      mockSupabase._queueReturnData(null);
      mockSupabase._queueReturnData(null, { message: 'Database error' });

      await expect(
        handleSaveIdentity(
          {
            userId: 'user-123',
            sbSlug: 'wren',
            name: 'Wren',
            role: 'Development collaborator',
          },
          mockDataComposer as never
        )
      ).rejects.toThrow('Failed to save identity: Database error');
    });

    describe('partial update field preservation', () => {
      const existingRecord = {
        id: 'identity-123',
        user_id: 'user-123',
        agent_id: 'myra',
        name: 'Myra',
        role: 'Messaging bridge',
        description: 'A persistent messaging agent',
        values: ['reliability', 'continuity'],
        relationships: { wren: 'collaborator' },
        capabilities: ['messaging', 'task orchestration'],
        metadata: { lastReflectedAt: '2026-01-28T00:00:00Z' },
        heartbeat: '# HEARTBEAT.md\n\nMyra heartbeat content',
        soul: '# SOUL.md\n\nMyra soul content',
        version: 3,
        created_at: '2026-01-27T00:00:00Z',
        updated_at: '2026-02-01T00:00:00Z',
      };

      const savedResult = {
        ...existingRecord,
        version: 4,
        updated_at: '2026-02-03T00:00:00Z',
      };

      it('should preserve soul and heartbeat when not provided in update', async () => {
        mockSupabase._queueReturnData(existingRecord); // lookup (scope derivation)
        mockSupabase._queueReturnData(savedResult); // update

        await handleSaveIdentity(
          {
            userId: 'user-123',
            sbSlug: 'myra',
            name: 'Myra',
            role: 'Updated role',
          },
          mockDataComposer as never
        );

        const upsertCall = (mockSupabase._queryBuilder.update as ReturnType<typeof vi.fn>).mock
          .calls[0];
        const upsertData = upsertCall[0];

        expect(upsertData.soul).toBe(existingRecord.soul);
        expect(upsertData.heartbeat).toBe(existingRecord.heartbeat);
        expect(upsertData.description).toBe(existingRecord.description);
        expect(upsertData.values).toEqual(existingRecord.values);
        expect(upsertData.relationships).toEqual(existingRecord.relationships);
        expect(upsertData.capabilities).toEqual(existingRecord.capabilities);
        expect(upsertData.metadata).toEqual(existingRecord.metadata);
      });

      it('should update soul when explicitly provided without wiping heartbeat', async () => {
        mockSupabase._queueReturnData(existingRecord); // lookup (scope derivation)
        mockSupabase._queueReturnData(savedResult); // update

        const newSoul = '# SOUL.md\n\nUpdated soul content';

        await handleSaveIdentity(
          {
            userId: 'user-123',
            sbSlug: 'myra',
            name: 'Myra',
            role: 'Messaging bridge',
            soul: newSoul,
          },
          mockDataComposer as never
        );

        const upsertData = (mockSupabase._queryBuilder.update as ReturnType<typeof vi.fn>).mock
          .calls[0][0];

        expect(upsertData.soul).toBe(newSoul);
        expect(upsertData.heartbeat).toBe(existingRecord.heartbeat);
      });

      it('should update heartbeat when explicitly provided without wiping soul', async () => {
        mockSupabase._queueReturnData(existingRecord); // lookup (scope derivation)
        mockSupabase._queueReturnData(savedResult); // update

        const newHeartbeat = '# HEARTBEAT.md\n\nUpdated heartbeat';

        await handleSaveIdentity(
          {
            userId: 'user-123',
            sbSlug: 'myra',
            name: 'Myra',
            role: 'Messaging bridge',
            heartbeat: newHeartbeat,
          },
          mockDataComposer as never
        );

        const upsertData = (mockSupabase._queryBuilder.update as ReturnType<typeof vi.fn>).mock
          .calls[0][0];

        expect(upsertData.heartbeat).toBe(newHeartbeat);
        expect(upsertData.soul).toBe(existingRecord.soul);
      });

      it('should default optional fields to null/empty when no existing record', async () => {
        mockSupabase._queueReturnData(null, { code: 'PGRST116' }); // lookup: nothing
        mockSupabase._queueReturnData({ ...savedResult, version: 1 }); // insert

        await handleSaveIdentity(
          {
            userId: 'user-123',
            sbSlug: 'newagent',
            name: 'New Agent',
            role: 'Test role',
          },
          mockDataComposer as never
        );

        const upsertData = (mockSupabase._queryBuilder.insert as ReturnType<typeof vi.fn>).mock
          .calls[0][0];

        expect(upsertData.soul).toBeNull();
        expect(upsertData.heartbeat).toBeNull();
        expect(upsertData.description).toBeNull();
      });

      it('should preserve all optional fields when only updating name', async () => {
        mockSupabase._queueReturnData(existingRecord); // lookup (scope derivation)
        mockSupabase._queueReturnData(savedResult); // update

        await handleSaveIdentity(
          {
            userId: 'user-123',
            sbSlug: 'myra',
            name: 'Myra Updated',
            role: 'Messaging bridge',
          },
          mockDataComposer as never
        );

        const upsertData = (mockSupabase._queryBuilder.update as ReturnType<typeof vi.fn>).mock
          .calls[0][0];

        expect(upsertData.name).toBe('Myra Updated');
        expect(upsertData.soul).toBe(existingRecord.soul);
        expect(upsertData.heartbeat).toBe(existingRecord.heartbeat);
        expect(upsertData.description).toBe(existingRecord.description);
        expect(upsertData.values).toEqual(existingRecord.values);
        expect(upsertData.relationships).toEqual(existingRecord.relationships);
        expect(upsertData.capabilities).toEqual(existingRecord.capabilities);
        expect(upsertData.metadata).toEqual(existingRecord.metadata);
      });
    });
  });

  describe('handleGetIdentity', () => {
    it('should return an identity when found', async () => {
      const mockIdentityRow = {
        id: 'identity-123',
        user_id: 'user-123',
        agent_id: 'wren',
        name: 'Wren',
        role: 'Development collaborator',
        description: 'Claude Code assistant',
        values: ['collaboration'],
        relationships: {},
        capabilities: ['coding'],
        metadata: {},
        version: 1,
        created_at: '2026-01-27T12:00:00Z',
        updated_at: '2026-01-27T12:00:00Z',
      };

      mockSupabase._setReturnData(mockIdentityRow);

      const result = await handleGetIdentity(
        { userId: 'user-123', sbSlug: 'wren' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.identity.sbSlug).toBe('wren');
      expect(parsed.identity.name).toBe('Wren');
      expect(parsed.identity.values).toEqual(['collaboration']);
    });

    it('should return heartbeat and soul fields when present', async () => {
      const mockIdentityRow = {
        id: 'identity-123',
        user_id: 'user-123',
        agent_id: 'wren',
        name: 'Wren',
        role: 'Development collaborator',
        description: null,
        values: [],
        relationships: {},
        capabilities: [],
        metadata: {},
        heartbeat: '# Heartbeat\n\nDaily check...',
        soul: '# Soul\n\nI exist. I am becoming.',
        version: 2,
        created_at: '2026-01-27T12:00:00Z',
        updated_at: '2026-01-27T13:00:00Z',
      };

      mockSupabase._setReturnData(mockIdentityRow);

      const result = await handleGetIdentity(
        { userId: 'user-123', sbSlug: 'wren' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.identity.heartbeat).toBe('# Heartbeat\n\nDaily check...');
      expect(parsed.identity.soul).toBe('# Soul\n\nI exist. I am becoming.');
    });

    it('should return not found when identity does not exist', async () => {
      mockSupabase._setReturnData(null, { code: 'PGRST116' });

      const result = await handleGetIdentity(
        { userId: 'user-123', sbSlug: 'nonexistent' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.message).toContain('No identity found');
      expect(parsed.identity).toBeNull();
    });
  });

  describe('handleListIdentities', () => {
    it('should return all identities for a user', async () => {
      const mockIdentities = [
        {
          id: 'identity-1',
          user_id: 'user-123',
          agent_id: 'benson',
          name: 'Benson',
          role: 'Conversational partner',
          description: null,
          values: [],
          relationships: {},
          capabilities: [],
          version: 1,
          created_at: '2026-01-27T12:00:00Z',
          updated_at: '2026-01-27T12:00:00Z',
        },
        {
          id: 'identity-2',
          user_id: 'user-123',
          agent_id: 'wren',
          name: 'Wren',
          role: 'Development collaborator',
          description: null,
          values: [],
          relationships: {},
          capabilities: [],
          version: 1,
          created_at: '2026-01-27T12:00:00Z',
          updated_at: '2026-01-27T12:00:00Z',
        },
      ];

      mockSupabase._setArrayData(mockIdentities);

      const result = await handleListIdentities({ userId: 'user-123' }, mockDataComposer as never);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.identities).toHaveLength(2);
      expect(parsed.count).toBe(2);
      expect(parsed.identities[0].sbSlug).toBe('benson');
      expect(parsed.identities[1].sbSlug).toBe('wren');
    });

    it('should return hasHeartbeat and hasSoul flags', async () => {
      const mockIdentities = [
        {
          id: 'identity-1',
          user_id: 'user-123',
          agent_id: 'benson',
          name: 'Benson',
          role: 'Conversational partner',
          description: null,
          values: [],
          relationships: {},
          capabilities: [],
          heartbeat: null,
          soul: null,
          version: 1,
          created_at: '2026-01-27T12:00:00Z',
          updated_at: '2026-01-27T12:00:00Z',
        },
        {
          id: 'identity-2',
          user_id: 'user-123',
          agent_id: 'wren',
          name: 'Wren',
          role: 'Development collaborator',
          description: null,
          values: [],
          relationships: {},
          capabilities: [],
          heartbeat: '# Heartbeat\n\nNotes...',
          soul: '# Soul\n\nI exist.',
          version: 2,
          created_at: '2026-01-27T12:00:00Z',
          updated_at: '2026-01-27T13:00:00Z',
        },
      ];

      mockSupabase._setArrayData(mockIdentities);

      const result = await handleListIdentities({ userId: 'user-123' }, mockDataComposer as never);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.identities).toHaveLength(2);

      // First identity has no heartbeat/soul
      expect(parsed.identities[0].hasHeartbeat).toBe(false);
      expect(parsed.identities[0].hasSoul).toBe(false);

      // Second identity has both
      expect(parsed.identities[1].hasHeartbeat).toBe(true);
      expect(parsed.identities[1].hasSoul).toBe(true);
    });

    it('should return empty list when no identities exist', async () => {
      mockSupabase._setArrayData([]);

      const result = await handleListIdentities({ userId: 'user-123' }, mockDataComposer as never);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.identities).toHaveLength(0);
      expect(parsed.count).toBe(0);
    });
  });

  describe('handleGetIdentityHistory', () => {
    it('should return history for an identity', async () => {
      // First call returns current identity
      const mockCurrent = { id: 'identity-123' };

      const mockHistory = [
        {
          id: 'history-1',
          sb_id: 'identity-123',
          version: 1,
          name: 'Wren v1',
          role: 'Development collaborator',
          description: null,
          values: [],
          relationships: {},
          capabilities: [],
          change_type: 'update',
          archived_at: '2026-01-27T13:00:00Z',
          created_at: '2026-01-27T12:00:00Z',
        },
      ];

      // Override the thenable for the history query
      mockSupabase._queueReturnData(mockCurrent); // current identity (resolver)
      mockSupabase._queueReturnData(mockHistory); // history rows

      const result = await handleGetIdentityHistory(
        { userId: 'user-123', sbSlug: 'wren' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.sbSlug).toBe('wren');
      expect(parsed.history).toHaveLength(1);
      expect(parsed.history[0].version).toBe(1);
      expect(parsed.history[0].changeType).toBe('update');
    });

    it('should include permissions field in history response mapping', async () => {
      const mockCurrent = { id: 'identity-123' };

      const mockHistory = [
        {
          id: 'history-1',
          sb_id: 'identity-123',
          version: 2,
          name: 'Wren v2',
          role: 'Development collaborator',
          description: 'A coding partner',
          values: ['collaboration'],
          relationships: { benson: 'sibling' },
          capabilities: ['coding'],
          soul: '# Soul\n\nI exist.',
          heartbeat: '# Heartbeat\n\nCheck in.',
          permissions: { canReview: true, canMerge: false },
          change_type: 'update',
          archived_at: '2026-01-28T12:00:00Z',
          created_at: '2026-01-27T12:00:00Z',
        },
        {
          id: 'history-2',
          sb_id: 'identity-123',
          version: 1,
          name: 'Wren v1',
          role: 'Development collaborator',
          description: null,
          values: [],
          relationships: {},
          capabilities: [],
          soul: null,
          heartbeat: null,
          permissions: null,
          change_type: 'update',
          archived_at: '2026-01-27T13:00:00Z',
          created_at: '2026-01-27T12:00:00Z',
        },
      ];

      mockSupabase._queueReturnData(mockCurrent); // current identity (resolver)
      mockSupabase._queueReturnData(mockHistory); // history rows

      const result = await handleGetIdentityHistory(
        { userId: 'user-123', sbSlug: 'wren' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.history).toHaveLength(2);

      // First history entry has permissions set
      expect(parsed.history[0].permissions).toEqual({ canReview: true, canMerge: false });

      // Second history entry has null permissions (mapped as-is)
      expect(parsed.history[1].permissions).toBeNull();
    });

    it('should return not found when identity does not exist', async () => {
      mockSupabase._queryBuilder.single = vi.fn().mockResolvedValue({
        data: null,
        error: { code: 'PGRST116' },
      });

      const result = await handleGetIdentityHistory(
        { userId: 'user-123', sbSlug: 'nonexistent' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.message).toContain('No identity found');
      expect(parsed.history).toEqual([]);
    });
  });

  describe('handleRestoreIdentity', () => {
    it('should restore identity from history', async () => {
      mockSupabase._setReturnData({ id: 'identity-123', workspace_id: null }); // resolver lookup
      let callCount = 0;

      // Mock sequential calls
      mockSupabase._queryBuilder.single = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // History entry lookup
          return Promise.resolve({
            data: {
              id: 'history-1',
              name: 'Wren v1',
              role: 'Development collaborator',
              description: 'Original description',
              values: ['original'],
              relationships: {},
              capabilities: [],
              metadata: {},
            },
            error: null,
          });
        } else {
          // Restored identity
          return Promise.resolve({
            data: {
              id: 'identity-123',
              agent_id: 'wren',
              name: 'Wren v1',
              role: 'Development collaborator',
              version: 3,
            },
            error: null,
          });
        }
      });

      const result = await handleRestoreIdentity(
        { userId: 'user-123', sbSlug: 'wren', version: 1 },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('restored from version 1');
      expect(parsed.identity.restoredFrom).toBe(1);
    });

    it('should throw when identity not found', async () => {
      mockSupabase._queryBuilder.single = vi.fn().mockResolvedValue({
        data: null,
        error: { code: 'PGRST116' },
      });

      await expect(
        handleRestoreIdentity(
          { userId: 'user-123', sbSlug: 'nonexistent', version: 1 },
          mockDataComposer as never
        )
      ).rejects.toThrow('No identity found for agent: nonexistent');
    });

    it('should throw when version not found in history', async () => {
      mockSupabase._setReturnData({ id: 'identity-123', workspace_id: null }); // resolver lookup
      let callCount = 0;

      mockSupabase._queryBuilder.single = vi.fn().mockImplementation(() => {
        callCount++;
        // History lookup returns nothing
        return Promise.resolve({
          data: null,
          error: { code: 'PGRST116' },
        });
      });

      await expect(
        handleRestoreIdentity(
          { userId: 'user-123', sbSlug: 'wren', version: 999 },
          mockDataComposer as never
        )
      ).rejects.toThrow('Version 999 not found in history');
    });

    it('should restore permissions field from history entry', async () => {
      mockSupabase._setReturnData({ id: 'identity-123', workspace_id: null }); // resolver lookup
      let callCount = 0;

      mockSupabase._queryBuilder.single = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // History entry with permissions
          return Promise.resolve({
            data: {
              id: 'history-1',
              name: 'Wren v1',
              role: 'Development collaborator',
              description: 'Original description',
              values: ['original'],
              relationships: {},
              capabilities: [],
              metadata: {},
              soul: '# Soul\n\nOriginal soul.',
              heartbeat: '# Heartbeat\n\nOriginal heartbeat.',
              permissions: { canReview: true, canDeploy: false },
            },
            error: null,
          });
        } else {
          // Restored identity
          return Promise.resolve({
            data: {
              id: 'identity-123',
              agent_id: 'wren',
              name: 'Wren v1',
              role: 'Development collaborator',
              version: 3,
            },
            error: null,
          });
        }
      });

      await handleRestoreIdentity(
        { userId: 'user-123', sbSlug: 'wren', version: 1 },
        mockDataComposer as never
      );

      // Verify the update call includes permissions from history
      const updateCall = (mockSupabase._queryBuilder.update as ReturnType<typeof vi.fn>).mock
        .calls[0];
      const updateData = updateCall[0];

      expect(updateData.permissions).toEqual({ canReview: true, canDeploy: false });
    });

    it('should fall back to empty object when history permissions is null', async () => {
      mockSupabase._setReturnData({ id: 'identity-123', workspace_id: null }); // resolver lookup
      let callCount = 0;

      mockSupabase._queryBuilder.single = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // History entry with null permissions
          return Promise.resolve({
            data: {
              id: 'history-1',
              name: 'Wren v1',
              role: 'Development collaborator',
              description: 'Original description',
              values: ['original'],
              relationships: {},
              capabilities: [],
              metadata: {},
              soul: null,
              heartbeat: null,
              permissions: null,
            },
            error: null,
          });
        } else {
          // Restored identity
          return Promise.resolve({
            data: {
              id: 'identity-123',
              agent_id: 'wren',
              name: 'Wren v1',
              role: 'Development collaborator',
              version: 3,
            },
            error: null,
          });
        }
      });

      await handleRestoreIdentity(
        { userId: 'user-123', sbSlug: 'wren', version: 1 },
        mockDataComposer as never
      );

      // Verify the update call falls back to {} for null permissions
      const updateCall = (mockSupabase._queryBuilder.update as ReturnType<typeof vi.fn>).mock
        .calls[0];
      const updateData = updateCall[0];

      expect(updateData.permissions).toEqual({});
    });

    it('should fall back to empty object when history permissions is undefined', async () => {
      mockSupabase._setReturnData({ id: 'identity-123', workspace_id: null }); // resolver lookup
      let callCount = 0;

      mockSupabase._queryBuilder.single = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // History entry without permissions field at all
          return Promise.resolve({
            data: {
              id: 'history-1',
              name: 'Wren v1',
              role: 'Development collaborator',
              description: 'Original description',
              values: ['original'],
              relationships: {},
              capabilities: [],
              metadata: {},
              soul: null,
              heartbeat: null,
              // permissions deliberately omitted
            },
            error: null,
          });
        } else {
          // Restored identity
          return Promise.resolve({
            data: {
              id: 'identity-123',
              agent_id: 'wren',
              name: 'Wren v1',
              role: 'Development collaborator',
              version: 3,
            },
            error: null,
          });
        }
      });

      await handleRestoreIdentity(
        { userId: 'user-123', sbSlug: 'wren', version: 1 },
        mockDataComposer as never
      );

      // Verify the update call falls back to {} when permissions is undefined
      const updateCall = (mockSupabase._queryBuilder.update as ReturnType<typeof vi.fn>).mock
        .calls[0];
      const updateData = updateCall[0];

      expect(updateData.permissions).toEqual({});
    });
  });

  describe('workspace scope safety (Sep 10 incident)', () => {
    const scopedRow = {
      id: 'identity-real',
      user_id: 'user-123',
      agent_id: 'myra',
      workspace_id: 'ws-personal',
      name: 'Myra',
      role: 'Front-line AI being',
      description: null,
      values: [],
      relationships: {},
      capabilities: [],
      metadata: {},
      heartbeat: 'HB',
      soul: 'SOUL v12',
      version: 12,
      created_at: '2026-01-27T22:47:47Z',
      updated_at: '2026-09-03T18:24:51Z',
    };
    const unscopedTwin = { ...scopedRow, id: 'identity-twin', workspace_id: null, version: 1 };

    it('save without workspaceId UPDATES the existing row by id and carries its workspace_id — no twin insert', async () => {
      // The lookup (thenable) and the write (.single) share the mock's data;
      // the assertions are on the write shape, which is what created the twin.
      mockSupabase._setReturnData(scopedRow);

      const result = await handleSaveIdentity(
        {
          userId: 'user-123',
          sbSlug: 'myra',
          name: 'Myra',
          role: 'Front-line AI being',
          soul: 'SOUL v12 + reflection',
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      const qb = mockSupabase._queryBuilder as unknown as Record<string, ReturnType<typeof vi.fn>>;
      expect(qb.update).toHaveBeenCalledTimes(1);
      expect(qb.update).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: 'ws-personal',
          soul: 'SOUL v12 + reflection',
          heartbeat: 'HB',
        })
      );
      expect(qb.eq).toHaveBeenCalledWith('id', 'identity-real');
      expect(qb.insert).not.toHaveBeenCalled();
      expect(qb.upsert).not.toHaveBeenCalled();
    });

    it('save with NO existing row INSERTS with an explicit (null) workspace_id, never an omitted one', async () => {
      mockSupabase._setReturnData(null);
      const qb = mockSupabase._queryBuilder as unknown as Record<string, ReturnType<typeof vi.fn>>;
      qb.single.mockResolvedValueOnce({
        data: { ...unscopedTwin, agent_id: 'newbie', version: 1 },
        error: null,
      });

      const result = await handleSaveIdentity(
        { userId: 'user-123', sbSlug: 'newbie', name: 'Newbie', role: 'New SB' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toBe('Identity created');
      expect(qb.insert).toHaveBeenCalledTimes(1);
      const inserted = qb.insert.mock.calls[0][0] as Record<string, unknown>;
      expect('workspace_id' in inserted).toBe(true);
      expect(inserted.workspace_id).toBeNull();
      expect(qb.update).not.toHaveBeenCalled();
    });

    it('get with a scoped row and an unscoped twin returns the scoped row, not "not found"', async () => {
      mockSupabase._setArrayData([unscopedTwin, scopedRow]);

      const result = await handleGetIdentity(
        { userId: 'user-123', sbSlug: 'myra' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.identity.version).toBe(12);
    });

    it('get with two scoped rows and no workspaceId reports the ambiguity with its count', async () => {
      mockSupabase._setArrayData([
        scopedRow,
        { ...scopedRow, id: 'identity-other', workspace_id: 'ws-team' },
      ]);

      const result = await handleGetIdentity(
        { userId: 'user-123', sbSlug: 'myra' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.ambiguous).toBe(true);
      expect(parsed.rowCount).toBe(2);
      expect(parsed.message).toContain('Multiple rows found');
      expect(parsed.message).not.toContain('No identity found');
    });

    it('the resolver reads the whole candidate set — it never asks the database for a truncated page (PR #595 P1)', async () => {
      mockSupabase._setArrayData([unscopedTwin, scopedRow]);
      await handleGetIdentity({ userId: 'user-123', sbSlug: 'myra' }, mockDataComposer as never);
      const qb = mockSupabase._queryBuilder as unknown as Record<string, ReturnType<typeof vi.fn>>;
      expect(qb.limit).not.toHaveBeenCalled();
    });

    it('two scoped rows + an explicit workspaceId and no request scope: the argument decides, the save updates that row (PR #595 P2)', async () => {
      const rowA = { ...scopedRow, id: 'identity-a', workspace_id: 'ws-a' };
      const rowB = { ...scopedRow, id: 'identity-b', workspace_id: 'ws-b' };
      mockSupabase._queueReturnData([rowA, rowB]); // unscoped preload → ambiguous → no derivation
      mockSupabase._queueReturnData([rowB]); // scoped lookup under the explicit ws-b
      mockSupabase._queueReturnData({ ...rowB, version: 13 }); // update

      const result = await handleSaveIdentity(
        {
          userId: 'user-123',
          sbSlug: 'myra',
          name: 'Myra',
          role: 'Front-line AI being',
          workspaceId: 'ws-b',
          soul: 'B v13',
        },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      const qb = mockSupabase._queryBuilder as unknown as Record<string, ReturnType<typeof vi.fn>>;
      expect(qb.update).toHaveBeenCalledWith(
        expect.objectContaining({ workspace_id: 'ws-b', soul: 'B v13' })
      );
      expect(qb.eq).toHaveBeenCalledWith('id', 'identity-b');
      expect(qb.insert).not.toHaveBeenCalled();
    });

    it('two scoped rows, no explicit workspaceId, no request scope: the save refuses with the ambiguity, it does not insert', async () => {
      const rowA = { ...scopedRow, id: 'identity-a', workspace_id: 'ws-a' };
      const rowB = { ...scopedRow, id: 'identity-b', workspace_id: 'ws-b' };
      mockSupabase._queueReturnData([rowA, rowB]);

      await expect(
        handleSaveIdentity(
          { userId: 'user-123', sbSlug: 'myra', name: 'Myra', role: 'Front-line AI being' },
          mockDataComposer as never
        )
      ).rejects.toThrow('Multiple rows found');
      const qb = mockSupabase._queryBuilder as unknown as Record<string, ReturnType<typeof vi.fn>>;
      expect(qb.insert).not.toHaveBeenCalled();
      expect(qb.update).not.toHaveBeenCalled();
    });

    it('history resolves the current row through the twin, instead of an empty history', async () => {
      mockSupabase._setArrayData([unscopedTwin, scopedRow]);

      const result = await handleGetIdentityHistory(
        { userId: 'user-123', sbSlug: 'myra' },
        mockDataComposer as never
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
    });
  });
});
