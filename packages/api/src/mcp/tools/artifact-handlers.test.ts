/**
 * Artifact Handler Tests
 *
 * Covers three-way merge/CAS behavior plus comment + identity UUID flows.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataComposer } from '../../data/composer';
import { createTableAwareSupabaseMock } from '../../test/table-aware-supabase-mock';
import {
  handleAddArtifactComment,
  handleCreateArtifact,
  handleGetArtifact,
  handleListArtifactComments,
  handleUpdateArtifact,
} from './artifact-handlers';

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
    if (table === 'agent_identities') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: null,
                error: null,
              }),
            }),
          }),
        }),
      };
    }
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
  };
}

function createMockDataComposer(supabase: { from: ReturnType<typeof vi.fn> }) {
  return {
    getClient: () => supabase,
  } as unknown as DataComposer;
}

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
          baseVersion: 1,
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
      const baseContent = '# Section A\nOriginal A content\n\n# Section B\nOriginal B content\n\n# Section C\nOriginal C content\n';
      const currentContent = '# Section A\nOriginal A content\n\n# Section B\nModified B content by Myra\n\n# Section C\nOriginal C content\n';
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
          baseVersion: 1,
          agentId: 'wren',
        },
        dataComposer,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.mergePerformed).toBe(true);
      expect(parsed.mergedFromBase).toBe(1);
      expect((updatedArtifact.content as string)).toContain('Modified B content by Myra');
      expect((updatedArtifact.content as string)).toContain('Modified C content by Wren');
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
      expect(parsed.conflicts.length).toBeGreaterThan(0);
    });

    it('should handle false conflicts (both made same change) gracefully', async () => {
      const baseContent = '# Title\nOriginal content\n\n# Footer\nFooter content\n';
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
        casFailure: true,
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
      const { supabase } = createMockSupabase({
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
          baseVersion: 1,
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

describe('artifact comment + identity UUID flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleGetArtifact includes comments when includeComments=true', async () => {
    const supabase = createTableAwareSupabaseMock({
      artifacts: [
        {
          maybeSingle: [{
            data: {
              id: '11111111-1111-1111-1111-111111111111',
              uri: 'pcp://specs/test',
              title: 'Test Spec',
              content: '# Spec',
              content_type: 'text/markdown',
              artifact_type: 'spec',
              created_by_agent_id: 'wren',
              created_by_identity_id: null,
              collaborators: ['wren', 'lumen'],
              visibility: 'shared',
              version: 2,
              tags: ['memory'],
              metadata: {},
              created_at: '2026-02-11T00:00:00Z',
              updated_at: '2026-02-11T01:00:00Z',
            },
            error: null,
          }],
        },
      ],
      artifact_comments: [
        {
          then: {
            data: [
              {
                id: 'comment-1',
                artifact_id: '11111111-1111-1111-1111-111111111111',
                parent_comment_id: null,
                content: 'Love this direction',
                metadata: {},
                created_by_agent_id: 'lumen',
                created_by_identity_id: 'identity-1',
                created_at: '2026-02-11T02:00:00Z',
                updated_at: '2026-02-11T02:00:00Z',
                user_id: '00000000-0000-0000-0000-000000000001',
                deleted_at: null,
              },
            ],
            error: null,
          },
        },
      ],
      agent_identities: [
        {
          then: {
            data: [{ id: 'identity-1', agent_id: 'lumen', name: 'Lumen', backend: 'codex' }],
            error: null,
          },
        },
      ],
    });

    const result = await handleGetArtifact(
      {
        userId: '00000000-0000-0000-0000-000000000001',
        artifactId: '11111111-1111-1111-1111-111111111111',
        includeComments: true,
      },
      createMockDataComposer(supabase)
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.artifact.commentCount).toBe(1);
    expect(parsed.artifact.comments[0]).toMatchObject({
      id: 'comment-1',
      createdByAgentId: 'lumen',
      createdByIdentity: {
        id: 'identity-1',
        agentId: 'lumen',
        name: 'Lumen',
      },
    });
  });

  it('handleGetArtifact keeps response lightweight by default (no comments)', async () => {
    const supabase = createTableAwareSupabaseMock({
      artifacts: [
        {
          maybeSingle: [{
            data: {
              id: '11111111-1111-1111-1111-111111111111',
              uri: 'pcp://specs/test',
              title: 'Test Spec',
              content: '# Spec',
              content_type: 'text/markdown',
              artifact_type: 'spec',
              created_by_agent_id: 'wren',
              created_by_identity_id: null,
              collaborators: ['wren', 'lumen'],
              visibility: 'shared',
              version: 2,
              tags: ['memory'],
              metadata: {},
              created_at: '2026-02-11T00:00:00Z',
              updated_at: '2026-02-11T01:00:00Z',
            },
            error: null,
          }],
        },
      ],
    });

    const result = await handleGetArtifact(
      {
        userId: '00000000-0000-0000-0000-000000000001',
        artifactId: '11111111-1111-1111-1111-111111111111',
      },
      createMockDataComposer(supabase)
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.artifact.comments).toBeUndefined();
    expect(parsed.artifact.commentCount).toBeUndefined();
  });

  it('handleCreateArtifact stores created_by_identity_id and history changed_by_identity_id', async () => {
    const supabase = createTableAwareSupabaseMock({
      agent_identities: [
        {
          maybeSingle: [{ data: { id: 'identity-1', agent_id: 'lumen', name: 'Lumen', backend: 'codex' }, error: null }],
        },
      ],
      artifacts: [
        { maybeSingle: [{ data: null, error: null }] },
        {
          single: [{
            data: {
              id: 'artifact-1',
              uri: 'pcp://specs/test',
              title: 'Test Spec',
              artifact_type: 'spec',
              version: 1,
              created_at: '2026-02-11T00:00:00Z',
            },
            error: null,
          }],
        },
      ],
      artifact_history: [{ then: { data: null, error: null } }],
    });

    const result = await handleCreateArtifact(
      {
        userId: '00000000-0000-0000-0000-000000000001',
        uri: 'pcp://specs/test',
        title: 'Test Spec',
        content: '# Hello',
        artifactType: 'spec',
        agentId: 'lumen',
      },
      createMockDataComposer(supabase)
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);

    const artifactInsertBuilder = supabase.calls.find((c) => c.table === 'artifacts' && (c.builder.insert as ReturnType<typeof vi.fn>).mock.calls.length > 0)?.builder;
    const historyInsertBuilder = supabase.calls.find((c) => c.table === 'artifact_history')?.builder;

    expect((artifactInsertBuilder?.insert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      created_by_agent_id: 'lumen',
      created_by_identity_id: 'identity-1',
    });
    expect((historyInsertBuilder?.insert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      changed_by_agent_id: 'lumen',
      changed_by_identity_id: 'identity-1',
    });
  });

  it('handleCreateArtifact keeps slug behavior when identity row is missing', async () => {
    const supabase = createTableAwareSupabaseMock({
      agent_identities: [
        { maybeSingle: [{ data: null, error: null }] },
      ],
      artifacts: [
        { maybeSingle: [{ data: null, error: null }] },
        {
          single: [{
            data: {
              id: 'artifact-2',
              uri: 'pcp://specs/slug-only',
              title: 'Slug only',
              artifact_type: 'spec',
              version: 1,
              created_at: '2026-02-11T00:00:00Z',
            },
            error: null,
          }],
        },
      ],
      artifact_history: [{ then: { data: null, error: null } }],
    });

    const result = await handleCreateArtifact(
      {
        userId: '550e8400-e29b-41d4-a716-446655440000',
        uri: 'pcp://specs/slug-only',
        title: 'Slug only',
        content: '# Hi',
        artifactType: 'spec',
        agentId: 'unknown-agent-slug',
      },
      createMockDataComposer(supabase)
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);

    const artifactInsertBuilder = supabase.calls.find((c) => c.table === 'artifacts' && (c.builder.insert as ReturnType<typeof vi.fn>).mock.calls.length > 0)?.builder;
    const historyInsertBuilder = supabase.calls.find((c) => c.table === 'artifact_history')?.builder;

    expect((artifactInsertBuilder?.insert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      created_by_agent_id: 'unknown-agent-slug',
      created_by_identity_id: null,
    });
    expect((historyInsertBuilder?.insert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      changed_by_agent_id: 'unknown-agent-slug',
      changed_by_identity_id: null,
    });
  });

  it('handleAddArtifactComment resolves identity UUID and returns identity metadata', async () => {
    const supabase = createTableAwareSupabaseMock({
      artifacts: [
        { single: [{ data: { id: '11111111-1111-1111-1111-111111111111', uri: 'pcp://specs/test' }, error: null }] },
      ],
      agent_identities: [
        {
          maybeSingle: [{ data: { id: 'identity-1', agent_id: 'lumen', name: 'Lumen', backend: 'codex' }, error: null }],
        },
      ],
      artifact_comments: [
        {
          single: [{
            data: {
              id: 'comment-1',
              artifact_id: '11111111-1111-1111-1111-111111111111',
              user_id: '00000000-0000-0000-0000-000000000001',
              parent_comment_id: null,
              content: 'Great point.',
              metadata: {},
              created_by_agent_id: 'lumen',
              created_by_identity_id: 'identity-1',
              created_at: '2026-02-11T00:00:00Z',
              updated_at: '2026-02-11T00:00:00Z',
            },
            error: null,
          }],
        },
      ],
    });

    const result = await handleAddArtifactComment(
      {
        userId: '00000000-0000-0000-0000-000000000001',
        artifactId: '11111111-1111-1111-1111-111111111111',
        content: 'Great point.',
        agentId: 'lumen',
      },
      createMockDataComposer(supabase)
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.comment.createdByIdentityId).toBe('identity-1');
    expect(parsed.comment.createdByIdentity.agentId).toBe('lumen');

    const commentsBuilder = supabase.calls.find((c) => c.table === 'artifact_comments')?.builder;
    expect((commentsBuilder?.insert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      created_by_agent_id: 'lumen',
      created_by_identity_id: 'identity-1',
      content: 'Great point.',
    });
  });

  it('handleAddArtifactComment rejects invalid parent comment reference', async () => {
    const supabase = createTableAwareSupabaseMock({
      artifacts: [
        { single: [{ data: { id: '11111111-1111-1111-1111-111111111111', uri: 'pcp://specs/test' }, error: null }] },
      ],
      artifact_comments: [
        { maybeSingle: [{ data: null, error: null }] },
      ],
    });

    await expect(
      handleAddArtifactComment(
        {
          userId: '00000000-0000-0000-0000-000000000001',
          artifactId: '11111111-1111-1111-1111-111111111111',
          content: 'Replying to thread',
          parentCommentId: '22222222-2222-2222-2222-222222222222',
        },
        createMockDataComposer(supabase)
      )
    ).rejects.toThrow('Parent comment not found');
  });

  it('handleListArtifactComments enriches comments with identity details', async () => {
    const supabase = createTableAwareSupabaseMock({
      artifacts: [
        { single: [{ data: { id: '11111111-1111-1111-1111-111111111111', uri: 'pcp://specs/test' }, error: null }] },
      ],
      artifact_comments: [
        {
          then: {
            data: [
              {
                id: 'comment-1',
                artifact_id: '11111111-1111-1111-1111-111111111111',
                parent_comment_id: null,
                content: 'From Lumen',
                metadata: {},
                created_by_agent_id: 'lumen',
                created_by_identity_id: 'identity-1',
                created_at: '2026-02-11T00:00:00Z',
                updated_at: '2026-02-11T00:00:00Z',
                user_id: '00000000-0000-0000-0000-000000000001',
                deleted_at: null,
              },
              {
                id: 'comment-2',
                artifact_id: '11111111-1111-1111-1111-111111111111',
                parent_comment_id: null,
                content: 'Anonymous note',
                metadata: {},
                created_by_agent_id: null,
                created_by_identity_id: null,
                created_at: '2026-02-11T00:05:00Z',
                updated_at: '2026-02-11T00:05:00Z',
                user_id: '00000000-0000-0000-0000-000000000001',
                deleted_at: null,
              },
            ],
            error: null,
          },
        },
      ],
      agent_identities: [
        {
          then: {
            data: [{ id: 'identity-1', agent_id: 'lumen', name: 'Lumen', backend: 'codex' }],
            error: null,
          },
        },
      ],
    });

    const result = await handleListArtifactComments(
      {
        userId: '00000000-0000-0000-0000-000000000001',
        artifactId: '11111111-1111-1111-1111-111111111111',
      },
      createMockDataComposer(supabase)
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.count).toBe(2);
    expect(parsed.comments[0].createdByIdentity).toMatchObject({
      id: 'identity-1',
      agentId: 'lumen',
      name: 'Lumen',
    });
    expect(parsed.comments[1].createdByIdentity).toBeNull();
  });
});
