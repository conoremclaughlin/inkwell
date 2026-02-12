/**
 * Artifact Handler Tests
 *
 * Tests for three-way merge logic in update_artifact.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleUpdateArtifact } from './artifact-handlers';

// =====================================================
// MOCK SETUP
// =====================================================

vi.mock('../../services/user-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/user-resolver')>();
  return {
    ...actual,
    resolveUserOrThrow: vi.fn().mockResolvedValue({
      user: { id: '00000000-0000-0000-0000-000000000001' },
      resolvedBy: 'userId',
    }),
  };
});

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// =====================================================
// HELPERS
// =====================================================

function createMockSupabase(overrides: {
  artifact?: Record<string, unknown> | null;
  historyContent?: string | null;
  historyError?: boolean;
  casFailure?: boolean;
} = {}) {
  const artifact = overrides.artifact ?? {
    id: 'artifact-1',
    uri: 'pcp://test/doc',
    title: 'Test Doc',
    content: 'Line 1\nLine 2\nLine 3\n',
    version: 1,
    metadata: {},
    collaborators: ['wren'],
    created_by_agent_id: 'wren',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  };

  const updatedArtifact = { ...artifact };
  const insertedHistory: Record<string, unknown>[] = [];

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table === 'artifacts') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: artifact,
                error: artifact ? null : { message: 'Not found' },
              }),
            }),
          }),
        }),
        update: vi.fn().mockImplementation((updates: Record<string, unknown>) => {
          Object.assign(updatedArtifact, updates);
          // CAS guard: .eq('id', ...).eq('version', ...).select().maybeSingle()
          return {
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: overrides.casFailure ? null : updatedArtifact,
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }),
      };
    }
    if (table === 'artifact_history') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: overrides.historyError ? null : { content: overrides.historyContent ?? artifact?.content },
                error: overrides.historyError ? { message: 'Not found' } : null,
              }),
            }),
          }),
        }),
        insert: vi.fn().mockImplementation((entry: Record<string, unknown>) => {
          insertedHistory.push(entry);
          return { error: null };
        }),
      };
    }
    return {};
  });

  return {
    supabase: { from: mockFrom },
    updatedArtifact,
    insertedHistory,
    mockFrom,
  };
}

function createMockDataComposer(supabase: { from: ReturnType<typeof vi.fn> }) {
  return {
    getClient: () => supabase,
    repositories: {},
  } as unknown as Parameters<typeof handleUpdateArtifact>[1];
}

// =====================================================
// TESTS
// =====================================================

describe('handleUpdateArtifact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('without baseVersion (backward compatible)', () => {
    it('should update content with last-write-wins when baseVersion is omitted', async () => {
      const { supabase, updatedArtifact } = createMockSupabase();
      const dataComposer = createMockDataComposer(supabase);

      const result = await handleUpdateArtifact(
        {
          userId: '00000000-0000-0000-0000-000000000001',
          uri: 'pcp://test/doc',
          content: 'Completely new content',
          agentId: 'wren',
        },
        dataComposer,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.mergePerformed).toBeFalsy();
      expect(updatedArtifact.content).toBe('Completely new content');
    });
  });

  describe('with baseVersion matching current', () => {
    it('should update normally when baseVersion matches current version', async () => {
      const { supabase, updatedArtifact } = createMockSupabase();
      const dataComposer = createMockDataComposer(supabase);

      const result = await handleUpdateArtifact(
        {
          userId: '00000000-0000-0000-0000-000000000001',
          uri: 'pcp://test/doc',
          content: 'Updated content',
          baseVersion: 1, // matches current version
          agentId: 'wren',
        },
        dataComposer,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.mergePerformed).toBeFalsy();
      expect(updatedArtifact.content).toBe('Updated content');
    });
  });

  describe('three-way merge', () => {
    it('should auto-merge when changes are in different sections', async () => {
      // Base (version 1): three sections
      const baseContent = '# Section A\nOriginal A content\n\n# Section B\nOriginal B content\n\n# Section C\nOriginal C content\n';

      // Current (version 2): someone edited section B
      const currentContent = '# Section A\nOriginal A content\n\n# Section B\nModified B content by Myra\n\n# Section C\nOriginal C content\n';

      // Incoming: agent edited section C (based on version 1)
      const incomingContent = '# Section A\nOriginal A content\n\n# Section B\nOriginal B content\n\n# Section C\nModified C content by Wren\n';

      const { supabase, updatedArtifact, insertedHistory } = createMockSupabase({
        artifact: {
          id: 'artifact-1',
          uri: 'pcp://test/doc',
          title: 'Test Doc',
          content: currentContent,
          version: 2,
          metadata: {},
          collaborators: ['wren', 'myra'],
          created_by_agent_id: 'wren',
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        },
        historyContent: baseContent,
      });
      const dataComposer = createMockDataComposer(supabase);

      const result = await handleUpdateArtifact(
        {
          userId: '00000000-0000-0000-0000-000000000001',
          uri: 'pcp://test/doc',
          content: incomingContent,
          baseVersion: 1, // doesn't match current version 2
          agentId: 'wren',
        },
        dataComposer,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.mergePerformed).toBe(true);
      expect(parsed.mergedFromBase).toBe(1);

      // The merged content should have Myra's B changes AND Wren's C changes
      const merged = updatedArtifact.content as string;
      expect(merged).toContain('Modified B content by Myra');
      expect(merged).toContain('Modified C content by Wren');

      // History should record it as a merge
      expect(insertedHistory[0].change_type).toBe('merge');
    });

    it('should return conflict when both editors changed the same lines', async () => {
      const baseContent = '# Title\nOriginal content here\n';
      const currentContent = '# Title\nMyra changed this line\n';
      const incomingContent = '# Title\nWren changed this line differently\n';

      const { supabase } = createMockSupabase({
        artifact: {
          id: 'artifact-1',
          uri: 'pcp://test/doc',
          title: 'Test Doc',
          content: currentContent,
          version: 2,
          metadata: {},
          collaborators: ['wren', 'myra'],
          created_by_agent_id: 'wren',
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        },
        historyContent: baseContent,
      });
      const dataComposer = createMockDataComposer(supabase);

      const result = await handleUpdateArtifact(
        {
          userId: '00000000-0000-0000-0000-000000000001',
          uri: 'pcp://test/doc',
          content: incomingContent,
          baseVersion: 1,
          agentId: 'wren',
        },
        dataComposer,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.conflict).toBe(true);
      expect(parsed.currentVersion).toBe(2);
      expect(parsed.baseVersion).toBe(1);
      expect(parsed.conflicts).toBeDefined();
      expect(parsed.conflicts.length).toBeGreaterThan(0);
    });

    it('should handle false conflicts (both made same change) gracefully', async () => {
      const baseContent = '# Title\nOriginal content\n\n# Footer\nFooter content\n';
      // Both editors made the exact same change
      const currentContent = '# Title\nSame new content\n\n# Footer\nFooter content\n';
      const incomingContent = '# Title\nSame new content\n\n# Footer\nFooter content\n';

      const { supabase } = createMockSupabase({
        artifact: {
          id: 'artifact-1',
          uri: 'pcp://test/doc',
          title: 'Test Doc',
          content: currentContent,
          version: 2,
          metadata: {},
          collaborators: ['wren'],
          created_by_agent_id: 'wren',
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        },
        historyContent: baseContent,
      });
      const dataComposer = createMockDataComposer(supabase);

      const result = await handleUpdateArtifact(
        {
          userId: '00000000-0000-0000-0000-000000000001',
          uri: 'pcp://test/doc',
          content: incomingContent,
          baseVersion: 1,
          agentId: 'wren',
        },
        dataComposer,
      );

      const parsed = JSON.parse(result.content[0].text);
      // excludeFalseConflicts: true means identical changes merge cleanly
      expect(parsed.success).toBe(true);
    });

    it('should throw when base version is not found in history', async () => {
      const { supabase } = createMockSupabase({
        artifact: {
          id: 'artifact-1',
          uri: 'pcp://test/doc',
          title: 'Test Doc',
          content: 'Current content',
          version: 5,
          metadata: {},
          collaborators: ['wren'],
          created_by_agent_id: 'wren',
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        },
        historyError: true,
      });
      const dataComposer = createMockDataComposer(supabase);

      await expect(
        handleUpdateArtifact(
          {
            userId: '00000000-0000-0000-0000-000000000001',
            uri: 'pcp://test/doc',
            content: 'New content',
            baseVersion: 1,
            agentId: 'wren',
          },
          dataComposer,
        ),
      ).rejects.toThrow('Cannot merge: base version 1 not found in history');
    });
  });

  describe('CAS (compare-and-swap) guard', () => {
    it('should return staleWrite conflict when another writer wins the race', async () => {
      const { supabase } = createMockSupabase({
        casFailure: true, // simulate another writer incrementing version between read and write
      });
      const dataComposer = createMockDataComposer(supabase);

      const result = await handleUpdateArtifact(
        {
          userId: '00000000-0000-0000-0000-000000000001',
          uri: 'pcp://test/doc',
          content: 'My update',
          agentId: 'wren',
        },
        dataComposer,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.conflict).toBe(true);
      expect(parsed.staleWrite).toBe(true);
    });
  });

  describe('non-content updates', () => {
    it('should not trigger merge for metadata-only updates even with baseVersion', async () => {
      const { supabase, updatedArtifact } = createMockSupabase({
        artifact: {
          id: 'artifact-1',
          uri: 'pcp://test/doc',
          title: 'Test Doc',
          content: 'Original content',
          version: 3,
          metadata: {},
          collaborators: ['wren'],
          created_by_agent_id: 'wren',
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        },
      });
      const dataComposer = createMockDataComposer(supabase);

      const result = await handleUpdateArtifact(
        {
          userId: '00000000-0000-0000-0000-000000000001',
          uri: 'pcp://test/doc',
          tags: ['new-tag'],
          baseVersion: 1, // mismatches but no content change
          agentId: 'wren',
        },
        dataComposer,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.mergePerformed).toBeFalsy();
    });
  });
});
