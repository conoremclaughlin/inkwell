import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArtifactSearchRepository } from './artifact-search.repository';
import { createMockSupabaseClient, type MockSupabaseClient } from '../../test/mocks/supabase.mock';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('ArtifactSearchRepository', () => {
  let mockSupabase: MockSupabaseClient;
  let repo: ArtifactSearchRepository;

  const disableEmbeddings = () => {
    (repo as any).embeddingRouter = {
      isEnabled: vi.fn().mockReturnValue(false),
      getRuntimeConfig: vi.fn().mockReturnValue({
        enabled: false,
        queryThreshold: 0.2,
        matchCountMultiplier: 1,
      }),
      embedQuery: vi.fn().mockResolvedValue(null),
    };
  };

  const mockArtifactRow = {
    id: 'art-1',
    uri: 'ink://specs/test',
    user_id: 'user-1',
    workspace_id: 'ws-1',
    title: 'Test Spec',
    content: 'This is a test specification document about authentication.',
    content_type: 'text/markdown',
    artifact_type: 'spec',
    collaborators: [],
    visibility: 'private',
    version: 1,
    tags: ['auth', 'security'],
    metadata: {},
    created_at: '2026-05-11T10:00:00Z',
    updated_at: '2026-05-11T12:00:00Z',
    created_by_sb_id: null,
    edit_mode: 'workspace',
    embedding: null,
  };

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    repo = new ArtifactSearchRepository(mockSupabase as unknown as SupabaseClient);
    disableEmbeddings();
  });

  describe('search', () => {
    it('should perform text search when mode is text', async () => {
      mockSupabase._setArrayData([mockArtifactRow]);

      const results = await repo.search('user-1', 'authentication', 'text');

      expect(results).toHaveLength(1);
      expect(results[0].uri).toBe('ink://specs/test');
      expect(results[0].title).toBe('Test Spec');
      expect(results[0].artifactType).toBe('spec');
      expect(results[0].textScore).toBeGreaterThan(0);
    });

    it('should fall back to text when mode is auto and embeddings disabled', async () => {
      mockSupabase._setArrayData([mockArtifactRow]);

      const results = await repo.search('user-1', 'test', 'auto');

      expect(results).toHaveLength(1);
      expect(mockSupabase.from).toHaveBeenCalledWith('artifacts');
    });

    it('should return empty array for empty query in semantic mode', async () => {
      const results = await repo.search('user-1', '', 'semantic');

      expect(results).toHaveLength(0);
    });

    it('should compute text scores correctly', async () => {
      mockSupabase._setArrayData([mockArtifactRow]);

      const results = await repo.search('user-1', 'authentication', 'text');

      expect(results[0].textScore).toBeGreaterThan(0);
      expect(results[0].finalScore).toBe(results[0].textScore);
    });

    it('should boost exact title matches', async () => {
      mockSupabase._setArrayData([mockArtifactRow]);

      const results = await repo.search('user-1', 'Test Spec', 'text');

      expect(results[0].textScore).toBeGreaterThan(0.3);
    });
  });

  describe('filters', () => {
    it('should apply artifactType filter', async () => {
      mockSupabase._setArrayData([mockArtifactRow]);

      await repo.search('user-1', 'test', 'text', { artifactType: 'spec' });

      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('artifact_type', 'spec');
    });

    it('should apply tags filter', async () => {
      mockSupabase._setArrayData([mockArtifactRow]);

      await repo.search('user-1', 'test', 'text', { tags: ['auth'] });

      expect(mockSupabase._queryBuilder.overlaps).toHaveBeenCalledWith('tags', ['auth']);
    });

    it('should apply workspace filter', async () => {
      mockSupabase._setArrayData([mockArtifactRow]);

      await repo.search('user-1', 'test', 'text', { workspaceId: 'ws-1' });

      expect(mockSupabase._queryBuilder.eq).toHaveBeenCalledWith('workspace_id', 'ws-1');
    });
  });

  describe('semantic fallback', () => {
    it('should fall back to text search when embedding fails', async () => {
      mockSupabase._setArrayData([mockArtifactRow]);
      (repo as any).embeddingRouter = {
        isEnabled: vi.fn().mockReturnValue(true),
        getRuntimeConfig: vi.fn().mockReturnValue({
          enabled: true,
          queryThreshold: 0.2,
          matchCountMultiplier: 1,
        }),
        embedQuery: vi.fn().mockResolvedValue(null),
      };

      const results = await repo.search('user-1', 'test', 'semantic');

      expect(results).toHaveLength(1);
      expect(results[0].textScore).toBeDefined();
    });
  });
});
