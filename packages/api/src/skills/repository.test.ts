/**
 * Tests for Skills Repository
 *
 * Tests database operations for the cloud-based skills registry.
 * These tests verify the repository methods call supabase correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillsRepository } from './repository';
import type { SupabaseClient } from '@supabase/supabase-js';

// Helper to create a fluent mock that supports chaining
function createFluentMock(finalResponse: { data: unknown; error: unknown; count?: number }) {
  const mock: Record<string, unknown> = {};
  const methods = [
    'select',
    'insert',
    'update',
    'delete',
    'upsert',
    'eq',
    'not',
    'or',
    'order',
    'range',
    'single',
  ];

  methods.forEach((method) => {
    mock[method] = vi.fn(() => mock);
  });

  // Terminal methods return the response
  mock.single = vi.fn(() => Promise.resolve(finalResponse));
  mock.range = vi.fn(() => Promise.resolve(finalResponse));
  mock.order = vi.fn(() => mock); // order is not terminal
  mock.then = (resolve: (v: unknown) => void) => resolve(finalResponse);

  return mock;
}

describe('SkillsRepository', () => {
  describe('listRegistrySkills', () => {
    it('should return skills from the registry', async () => {
      const mockSkills = [
        {
          id: 'skill-1',
          name: 'bill-split',
          display_name: 'Bill Split',
          description: 'Split bills',
          type: 'mini-app',
          category: 'finance',
          tags: ['bills'],
          emoji: '💸',
          current_version: '1.0.0',
          author: 'PCP',
          is_official: true,
          is_verified: true,
          install_count: 100,
        },
      ];

      const fluentMock = createFluentMock({ data: mockSkills, error: null, count: 1 });
      const mockSupabase = {
        from: vi.fn(() => fluentMock),
      } as unknown as SupabaseClient;

      const repository = new SkillsRepository(mockSupabase);
      const result = await repository.listRegistrySkills();

      expect(mockSupabase.from).toHaveBeenCalledWith('skills');
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe('bill-split');
      expect(result.skills[0].displayName).toBe('Bill Split');
      expect(result.total).toBe(1);
    });

    it('should apply filters when provided', async () => {
      const fluentMock = createFluentMock({ data: [], error: null, count: 0 });
      const mockSupabase = {
        from: vi.fn(() => fluentMock),
      } as unknown as SupabaseClient;

      const repository = new SkillsRepository(mockSupabase);
      await repository.listRegistrySkills({ type: 'cli', category: 'developer' });

      expect(fluentMock.eq).toHaveBeenCalledWith('type', 'cli');
      expect(fluentMock.eq).toHaveBeenCalledWith('category', 'developer');
    });
  });

  describe('getRegistrySkill', () => {
    it('should return skill details by name', async () => {
      const mockSkill = {
        id: 'skill-1',
        name: 'bill-split',
        display_name: 'Bill Split',
        description: 'Split bills',
        type: 'mini-app',
        category: 'finance',
        tags: [],
        emoji: '💸',
        current_version: '1.0.0',
        author: 'PCP',
        is_official: true,
        is_verified: true,
        install_count: 100,
        manifest: {},
        content: '# Bill Split',
        repository_url: null,
        homepage_url: null,
      };

      const skillMock = createFluentMock({ data: mockSkill, error: null });
      const versionsMock = createFluentMock({ data: [], error: null });

      let callCount = 0;
      const mockSupabase = {
        from: vi.fn(() => {
          callCount++;
          if (callCount === 1) return skillMock;
          return versionsMock;
        }),
      } as unknown as SupabaseClient;

      const repository = new SkillsRepository(mockSupabase);
      const result = await repository.getRegistrySkill('bill-split');

      expect(result).not.toBeNull();
      expect(result?.name).toBe('bill-split');
      expect(result?.displayName).toBe('Bill Split');
    });

    it('should return null for non-existent skill', async () => {
      const fluentMock = createFluentMock({ data: null, error: { code: 'PGRST116' } });
      const mockSupabase = {
        from: vi.fn(() => fluentMock),
      } as unknown as SupabaseClient;

      const repository = new SkillsRepository(mockSupabase);
      const result = await repository.getRegistrySkill('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('installSkill', () => {
    it('should create an installation record', async () => {
      const mockInstallation = {
        id: 'inst-1',
        user_id: 'user-123',
        skill_id: 'skill-456',
        version_pinned: null,
        enabled: true,
        config: {},
        installed_at: '2024-01-01T00:00:00Z',
        last_used_at: null,
        usage_count: 0,
      };

      const fluentMock = createFluentMock({ data: mockInstallation, error: null });
      const mockSupabase = {
        from: vi.fn(() => fluentMock),
      } as unknown as SupabaseClient;

      const repository = new SkillsRepository(mockSupabase);
      const result = await repository.installSkill({
        skillId: 'skill-456',
        userId: 'user-123',
      });

      expect(mockSupabase.from).toHaveBeenCalledWith('skill_installations');
      expect(fluentMock.upsert).toHaveBeenCalled();
      expect(result.skillId).toBe('skill-456');
      expect(result.userId).toBe('user-123');
    });

    it('should support version pinning', async () => {
      const mockInstallation = {
        id: 'inst-1',
        user_id: 'user-123',
        skill_id: 'skill-456',
        version_pinned: '1.2.3',
        enabled: true,
        config: {},
        installed_at: '2024-01-01T00:00:00Z',
        last_used_at: null,
        usage_count: 0,
      };

      const fluentMock = createFluentMock({ data: mockInstallation, error: null });
      const mockSupabase = {
        from: vi.fn(() => fluentMock),
      } as unknown as SupabaseClient;

      const repository = new SkillsRepository(mockSupabase);
      const result = await repository.installSkill({
        skillId: 'skill-456',
        userId: 'user-123',
        versionPinned: '1.2.3',
      });

      expect(result.versionPinned).toBe('1.2.3');
    });
  });

  describe('uninstallSkill', () => {
    it('should delete the installation record', async () => {
      const fluentMock = createFluentMock({ data: null, error: null });
      const mockSupabase = {
        from: vi.fn(() => fluentMock),
      } as unknown as SupabaseClient;

      const repository = new SkillsRepository(mockSupabase);
      await repository.uninstallSkill('skill-456', 'user-123');

      expect(mockSupabase.from).toHaveBeenCalledWith('skill_installations');
      expect(fluentMock.delete).toHaveBeenCalled();
      expect(fluentMock.eq).toHaveBeenCalledWith('skill_id', 'skill-456');
      expect(fluentMock.eq).toHaveBeenCalledWith('user_id', 'user-123');
    });
  });

  describe('getUserInstalledSkills', () => {
    it('should return user installed skills from the view', async () => {
      const mockInstalled = [
        {
          installation_id: 'inst-1',
          user_id: 'user-123',
          enabled: true,
          user_config: {},
          version_pinned: null,
          installed_at: '2024-01-01',
          last_used_at: null,
          usage_count: 5,
          skill_id: 'skill-1',
          name: 'bill-split',
          display_name: 'Bill Split',
          description: 'Split bills',
          type: 'mini-app',
          category: 'finance',
          tags: [],
          emoji: '💸',
          current_version: '1.0.0',
          manifest: {},
          content: '# Bill Split',
          is_official: true,
          is_verified: true,
          author: 'PCP',
          repository_url: null,
          resolved_content: '# Bill Split',
          resolved_manifest: {},
          resolved_version: '1.0.0',
        },
      ];

      const fluentMock = createFluentMock({ data: mockInstalled, error: null });
      const mockSupabase = {
        from: vi.fn(() => fluentMock),
      } as unknown as SupabaseClient;

      const repository = new SkillsRepository(mockSupabase);
      const result = await repository.getUserInstalledSkills('user-123');

      expect(mockSupabase.from).toHaveBeenCalledWith('skill_installations');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('bill-split');
    });
  });

  describe('publishSkill', () => {
    it('should create a new skill in the registry', async () => {
      const mockSkill = {
        id: 'new-skill-id',
        name: 'my-skill',
        display_name: 'My Skill',
        description: 'A custom skill',
        type: 'guide',
        category: 'custom',
        tags: ['custom'],
        emoji: '🎯',
        current_version: '1.0.0',
        manifest: {},
        content: '# My Skill',
        author_user_id: 'author-123',
        is_public: true,
        is_official: false,
        is_verified: false,
        install_count: 0,
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
        published_at: '2024-01-01',
      };

      const fluentMock = createFluentMock({ data: mockSkill, error: null });
      const mockSupabase = {
        from: vi.fn(() => fluentMock),
      } as unknown as SupabaseClient;

      const repository = new SkillsRepository(mockSupabase);
      const result = await repository.publishSkill({
        name: 'my-skill',
        displayName: 'My Skill',
        description: 'A custom skill',
        type: 'guide',
        version: '1.0.0',
        manifest: {},
        content: '# My Skill',
        authorUserId: 'author-123',
      });

      expect(mockSupabase.from).toHaveBeenCalledWith('skills');
      expect(fluentMock.upsert).toHaveBeenCalled();
      expect(result.name).toBe('my-skill');
    });
  });

  describe('getSkillVersions', () => {
    it('should return version history for a skill', async () => {
      const mockVersions = [
        {
          id: 'v2',
          skill_id: 'skill-1',
          version: '1.1.0',
          manifest: {},
          content: 'v2',
          changelog: 'Update',
          published_by: null,
          published_at: '2024-02-01',
        },
        {
          id: 'v1',
          skill_id: 'skill-1',
          version: '1.0.0',
          manifest: {},
          content: 'v1',
          changelog: 'Initial',
          published_by: null,
          published_at: '2024-01-01',
        },
      ];

      const fluentMock = createFluentMock({ data: mockVersions, error: null });
      const mockSupabase = {
        from: vi.fn(() => fluentMock),
      } as unknown as SupabaseClient;

      const repository = new SkillsRepository(mockSupabase);
      const result = await repository.getSkillVersions('skill-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('skill_versions');
      expect(result).toHaveLength(2);
      expect(result[0].version).toBe('1.1.0');
    });
  });

  describe('getCategories', () => {
    it('should return unique categories', async () => {
      const mockData = [
        { category: 'finance' },
        { category: 'developer' },
        { category: 'social' },
        { category: 'finance' }, // duplicate
      ];

      const fluentMock = createFluentMock({ data: mockData, error: null });
      const mockSupabase = {
        from: vi.fn(() => fluentMock),
      } as unknown as SupabaseClient;

      const repository = new SkillsRepository(mockSupabase);
      const result = await repository.getCategories();

      expect(result).toContain('finance');
      expect(result).toContain('developer');
      expect(result).toContain('social');
      expect(result.length).toBe(3); // deduplicated
    });
  });
});
