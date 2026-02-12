/**
 * Artifact Handlers
 *
 * MCP tools for managing shared artifacts (specs, designs, documents).
 * Artifacts are collaborative resources distinct from personal memories.
 */

import { z } from 'zod';
import { merge as diff3Merge, diff3Merge as diff3MergeRegions } from 'node-diff3';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DataComposer } from '../../data/composer';
import { resolveUserOrThrow, userIdentifierBaseSchema } from '../../services/user-resolver';
import { logger } from '../../utils/logger';
import type { Database, Json } from '../../data/supabase/types';

// ============== Schemas ==============

const createArtifactSchema = userIdentifierBaseSchema.extend({
  uri: z.string().describe('Unique URI for the artifact (e.g., "pcp://specs/orchestration")'),
  title: z.string().describe('Title of the artifact'),
  content: z.string().describe('Content (typically markdown)'),
  artifactType: z
    .enum(['spec', 'design', 'decision', 'document', 'note'])
    .optional()
    .default('document')
    .describe('Type of artifact'),
  agentId: z.string().optional().describe('Agent creating this artifact'),
  collaborators: z.array(z.string()).optional().describe('Agent IDs who can edit'),
  visibility: z
    .enum(['private', 'shared', 'public'])
    .optional()
    .default('private')
    .describe('Visibility level'),
  tags: z.array(z.string()).optional().describe('Tags for categorization'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
});

const getArtifactSchema = userIdentifierBaseSchema.extend({
  uri: z.string().optional().describe('URI of the artifact'),
  artifactId: z.string().uuid().optional().describe('ID of the artifact'),
});

const updateArtifactSchema = userIdentifierBaseSchema.extend({
  uri: z.string().optional().describe('URI of the artifact to update'),
  artifactId: z.string().uuid().optional().describe('ID of the artifact to update'),
  title: z.string().optional().describe('New title'),
  content: z.string().optional().describe('New content'),
  baseVersion: z.number().int().optional().describe('Version this edit is based on. When provided, enables three-way merge: if the artifact has been modified since this version, the server will attempt to merge changes automatically. Omit for legacy last-write-wins behavior.'),
  agentId: z.string().optional().describe('Agent making the update'),
  collaborators: z.array(z.string()).optional().describe('Updated collaborator list'),
  tags: z.array(z.string()).optional().describe('Updated tags'),
  changeSummary: z.string().optional().describe('Summary of changes'),
});

const listArtifactsSchema = userIdentifierBaseSchema.extend({
  artifactType: z.string().optional().describe('Filter by type'),
  tags: z.array(z.string()).optional().describe('Filter by tags (any match)'),
  visibility: z.enum(['private', 'shared', 'public']).optional().describe('Filter by visibility'),
  search: z.string().optional().describe('Search in title and content'),
  limit: z.number().min(1).max(100).optional().default(20).describe('Max results'),
});

const getArtifactHistorySchema = userIdentifierBaseSchema.extend({
  uri: z.string().optional().describe('URI of the artifact'),
  artifactId: z.string().uuid().optional().describe('ID of the artifact'),
  limit: z.number().min(1).max(50).optional().default(10).describe('Max history entries'),
});

const addArtifactCommentSchema = userIdentifierBaseSchema.extend({
  uri: z.string().optional().describe('URI of the artifact'),
  artifactId: z.string().uuid().optional().describe('ID of the artifact'),
  content: z.string().min(1).describe('Comment text'),
  agentId: z.string().optional().describe('Agent authoring the comment'),
  parentCommentId: z.string().uuid().optional().describe('Optional parent comment ID for threading'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
});

const listArtifactCommentsSchema = userIdentifierBaseSchema.extend({
  uri: z.string().optional().describe('URI of the artifact'),
  artifactId: z.string().uuid().optional().describe('ID of the artifact'),
  limit: z.number().min(1).max(200).optional().default(100).describe('Max comments to return'),
});

// ============== Helpers ==============

async function resolveIdentityForAgent(
  supabase: SupabaseClient<Database>,
  userId: string,
  agentId?: string
) {
  if (!agentId) return null;

  const { data, error } = await supabase
    .from('agent_identities')
    .select('id, agent_id, name, backend')
    .eq('user_id', userId)
    .eq('agent_id', agentId)
    .maybeSingle();

  if (error) {
    logger.warn('Failed to resolve identity UUID for agent slug; continuing with slug-only reference', {
      userId,
      agentId,
      error: error.message,
    });
    return null;
  }

  if (!data) {
    logger.warn('No identity row found for agent slug; continuing with slug-only reference', {
      userId,
      agentId,
    });
    return null;
  }

  return data;
}

function resolveArtifactForUser(
  supabase: SupabaseClient<Database>,
  userId: string,
  params: { uri?: string; artifactId?: string },
  selectColumns = '*'
) {
  const { uri, artifactId } = params;
  if (!uri && !artifactId) {
    throw new Error('Must provide either uri or artifactId');
  }

  let query = supabase.from('artifacts').select(selectColumns).eq('user_id', userId);

  if (uri) {
    query = query.eq('uri', uri);
  } else if (artifactId) {
    query = query.eq('id', artifactId);
  }

  return query;
}

// ============== Handlers ==============

export async function handleCreateArtifact(
  args: unknown,
  dataComposer: DataComposer
) {
  const supabase = dataComposer.getClient();
  const parsed = createArtifactSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const {
    uri,
    title,
    content,
    artifactType = 'document',
    agentId,
    collaborators = [],
    visibility = 'private',
    tags = [],
    metadata = {},
  } = parsed;
  const authorIdentity = await resolveIdentityForAgent(supabase, resolved.user.id, agentId);

  // Check if URI already exists
  const { data: existing } = await supabase
    .from('artifacts')
    .select('id')
    .eq('uri', uri)
    .maybeSingle();

  if (existing) {
    throw new Error(`Artifact with URI "${uri}" already exists`);
  }

  const { data: artifact, error } = await supabase
    .from('artifacts')
    .insert({
      uri,
      user_id: resolved.user.id,
      created_by_agent_id: agentId || null,
      created_by_identity_id: authorIdentity?.id || null,
      title,
      content,
      artifact_type: artifactType,
      collaborators,
      visibility,
      tags,
      metadata: metadata as Json,
      version: 1,
    })
    .select()
    .single();

  if (error) {
    logger.error('Failed to create artifact', { error, uri });
    throw new Error(`Failed to create artifact: ${error.message}`);
  }

  // Create initial history entry
  await supabase.from('artifact_history').insert({
    artifact_id: artifact.id,
    version: 1,
    title,
    content,
    changed_by_agent_id: agentId || null,
    changed_by_identity_id: authorIdentity?.id || null,
    changed_by_user_id: agentId ? null : resolved.user.id,
    change_type: 'create',
    change_summary: 'Initial creation',
  });

  logger.info('Artifact created', { uri, type: artifactType, agentId });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          message: 'Artifact created',
          artifact: {
            id: artifact.id,
            uri: artifact.uri,
            title: artifact.title,
            artifactType: artifact.artifact_type,
            version: artifact.version,
            createdAt: artifact.created_at,
          },
        }),
      },
    ],
  };
}

export async function handleGetArtifact(
  args: unknown,
  dataComposer: DataComposer
) {
  const supabase = dataComposer.getClient();
  const parsed = getArtifactSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { uri, artifactId } = parsed;
  const query = resolveArtifactForUser(supabase, resolved.user.id, { uri, artifactId });

  const { data: artifact, error } = await query.maybeSingle();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Failed to get artifact: ${error.message}`);
  }

  if (!artifact) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            message: `Artifact not found: ${uri || artifactId}`,
            artifact: null,
          }),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          artifact: {
            id: artifact.id,
            uri: artifact.uri,
            title: artifact.title,
            content: artifact.content,
            contentType: artifact.content_type,
            artifactType: artifact.artifact_type,
            createdByAgentId: artifact.created_by_agent_id,
            createdByIdentityId: artifact.created_by_identity_id,
            collaborators: artifact.collaborators,
            visibility: artifact.visibility,
            version: artifact.version,
            tags: artifact.tags,
            metadata: artifact.metadata,
            createdAt: artifact.created_at,
            updatedAt: artifact.updated_at,
          },
        }),
      },
    ],
  };
}

export async function handleUpdateArtifact(
  args: unknown,
  dataComposer: DataComposer
) {
  const supabase = dataComposer.getClient();
  const parsed = updateArtifactSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { uri, artifactId, title, content, baseVersion, agentId, collaborators, tags, changeSummary } = parsed;
  const editorIdentity = await resolveIdentityForAgent(supabase, resolved.user.id, agentId);

  // First, get the current artifact
  const query = resolveArtifactForUser(supabase, resolved.user.id, { uri, artifactId });

  const { data: current, error: fetchError } = await query.single();

  if (fetchError) {
    throw new Error(`Artifact not found: ${uri || artifactId}`);
  }

  // Check if agent has permission to edit
  if (agentId && current.collaborators && !current.collaborators.includes(agentId)) {
    if (current.created_by_agent_id !== agentId) {
      throw new Error(`Agent ${agentId} does not have permission to edit this artifact`);
    }
  }

  // Three-way merge logic when content is being updated and baseVersion is provided
  let finalContent = content;
  let mergePerformed = false;

  if (content !== undefined && baseVersion !== undefined && baseVersion !== current.version) {
    // Version mismatch — attempt three-way merge
    logger.info('Version mismatch detected, attempting three-way merge', {
      uri: current.uri,
      baseVersion,
      currentVersion: current.version,
      agentId,
    });

    // Fetch the base version content from history
    const { data: baseHistory, error: historyError } = await supabase
      .from('artifact_history')
      .select('content')
      .eq('artifact_id', current.id)
      .eq('version', baseVersion)
      .single();

    if (historyError || !baseHistory?.content) {
      throw new Error(
        `Cannot merge: base version ${baseVersion} not found in history. ` +
        `Current version is ${current.version}. Re-read the artifact and try again.`
      );
    }

    const baseContent = baseHistory.content;
    const currentContent = current.content || '';
    const incomingContent = content;

    // Run three-way merge: merge(a, o, b) where a=incoming, o=base, b=current
    // Use line-based splitting for markdown documents
    const mergeOptions = {
      excludeFalseConflicts: true,
      stringSeparator: /\n/,
    };
    const mergeResult = diff3Merge(incomingContent, baseContent, currentContent, mergeOptions);

    if (mergeResult.conflict) {
      // Merge failed — return conflict details so the agent can resolve
      const regions = diff3MergeRegions(incomingContent, baseContent, currentContent, mergeOptions);

      const conflicts = regions
        .filter((r): r is { conflict: { a: string[]; b: string[]; o: string[] } } => 'conflict' in r && r.conflict !== undefined)
        .map((r) => ({
          yours: r.conflict.a.join('\n'),
          theirs: r.conflict.b.join('\n'),
          original: r.conflict.o.join('\n'),
        }));

      logger.warn('Three-way merge conflict', {
        uri: current.uri,
        baseVersion,
        currentVersion: current.version,
        conflictCount: conflicts.length,
        agentId,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              conflict: true,
              message: `Merge conflict: ${conflicts.length} conflicting region(s). Both you and another editor modified the same sections since version ${baseVersion}. Re-read the artifact (now at version ${current.version}) and retry your edit.`,
              currentVersion: current.version,
              baseVersion,
              conflicts,
            }),
          },
        ],
      };
    }

    // Clean merge — use the merged result
    // node-diff3 splits on newlines and returns lines without separators, so rejoin with \n
    finalContent = mergeResult.result.join('\n');
    mergePerformed = true;

    logger.info('Three-way merge succeeded', {
      uri: current.uri,
      baseVersion,
      currentVersion: current.version,
      agentId,
    });
  }

  const newVersion = (current.version ?? 0) + 1;

  // Build update object
  const updates: Record<string, unknown> = {
    version: newVersion,
    updated_at: new Date().toISOString(),
    metadata: {
      ...(current.metadata as Record<string, unknown>),
      lastEditedBy: agentId || 'user',
      lastEditedAt: new Date().toISOString(),
    },
  };

  if (title !== undefined) updates.title = title;
  if (finalContent !== undefined) updates.content = finalContent;
  if (collaborators !== undefined) updates.collaborators = collaborators;
  if (tags !== undefined) updates.tags = tags;

  // CAS (compare-and-swap) guard: only write if version hasn't changed since we read it.
  // This prevents true race conditions where two concurrent writers both pass the
  // merge check but then one silently overwrites the other.
  const expectedVersion = current.version ?? 0;

  const { data: updated, error: updateError } = await supabase
    .from('artifacts')
    .update(updates)
    .eq('id', current.id)
    .eq('version', expectedVersion)
    .select()
    .maybeSingle();

  if (updateError) {
    throw new Error(`Failed to update artifact: ${updateError.message}`);
  }

  // No row updated — another writer won the race
  if (!updated) {
    logger.warn('CAS conflict: artifact version changed during update', {
      uri: current.uri,
      expectedVersion,
      agentId,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            conflict: true,
            staleWrite: true,
            message: 'Artifact was modified by another writer during your update. Re-read the artifact and retry your edit with the new baseVersion.',
          }),
        },
      ],
    };
  }

  // Create history entry for this update
  const changeType = mergePerformed ? 'merge' : 'update';
  const mergeSummary = mergePerformed
    ? `Auto-merged with version ${current.version} (base: ${baseVersion}). ${changeSummary || ''}`
    : changeSummary || null;

  await supabase.from('artifact_history').insert({
    artifact_id: current.id,
    version: newVersion,
    title: updated.title,
    content: updated.content,
    changed_by_agent_id: agentId || null,
    changed_by_identity_id: editorIdentity?.id || null,
    changed_by_user_id: agentId ? null : resolved.user.id,
    change_type: changeType,
    change_summary: mergeSummary,
  });

  logger.info('Artifact updated', { uri: current.uri, version: updated.version, agentId, mergePerformed });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          message: mergePerformed ? 'Artifact updated (auto-merged)' : 'Artifact updated',
          artifact: {
            id: updated.id,
            uri: updated.uri,
            title: updated.title,
            version: updated.version,
            updatedAt: updated.updated_at,
          },
          previousVersion: current.version,
          mergePerformed,
          ...(mergePerformed ? { mergedFromBase: baseVersion } : {}),
        }),
      },
    ],
  };
}

export async function handleListArtifacts(
  args: unknown,
  dataComposer: DataComposer
) {
  const supabase = dataComposer.getClient();
  const parsed = listArtifactsSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { artifactType, tags, visibility, search, limit = 20 } = parsed;

  let query = supabase
    .from('artifacts')
    .select('id, uri, title, artifact_type, visibility, version, tags, created_at, updated_at')
    .eq('user_id', resolved.user.id)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (artifactType) {
    query = query.eq('artifact_type', artifactType);
  }
  if (visibility) {
    query = query.eq('visibility', visibility);
  }
  if (tags && tags.length > 0) {
    query = query.overlaps('tags', tags);
  }
  if (search) {
    query = query.or(`title.ilike.%${search}%,content.ilike.%${search}%`);
  }

  const { data: artifacts, error } = await query;

  if (error) {
    throw new Error(`Failed to list artifacts: ${error.message}`);
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          count: artifacts?.length || 0,
          artifacts: (artifacts || []).map((a) => ({
            id: a.id,
            uri: a.uri,
            title: a.title,
            artifactType: a.artifact_type,
            visibility: a.visibility,
            version: a.version,
            tags: a.tags,
            createdAt: a.created_at,
            updatedAt: a.updated_at,
          })),
        }),
      },
    ],
  };
}

export async function handleGetArtifactHistory(
  args: unknown,
  dataComposer: DataComposer
) {
  const supabase = dataComposer.getClient();
  const parsed = getArtifactHistorySchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { uri, artifactId, limit = 10 } = parsed;

  // First get the artifact to verify ownership
  const artifactQuery = resolveArtifactForUser(
    supabase,
    resolved.user.id,
    { uri, artifactId },
    'id'
  );

  const { data: artifact, error: artifactError } = await artifactQuery.single();

  if (artifactError) {
    throw new Error(`Artifact not found: ${uri || artifactId}`);
  }

  const { data: history, error } = await supabase
    .from('artifact_history')
    .select('*')
    .eq('artifact_id', artifact.id)
    .order('version', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to get artifact history: ${error.message}`);
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          artifactId: artifact.id,
          count: history?.length || 0,
          history: (history || []).map((h) => ({
            id: h.id,
            version: h.version,
            title: h.title,
            changedByAgentId: h.changed_by_agent_id,
            changedByIdentityId: h.changed_by_identity_id,
            changedByUserId: h.changed_by_user_id,
            changeType: h.change_type,
            changeSummary: h.change_summary,
            createdAt: h.created_at,
          })),
        }),
      },
    ],
  };
}

export async function handleAddArtifactComment(
  args: unknown,
  dataComposer: DataComposer
) {
  const supabase = dataComposer.getClient();
  const parsed = addArtifactCommentSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { uri, artifactId, content, agentId, parentCommentId, metadata = {} } = parsed;
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('Comment content cannot be empty');
  }

  const { data: artifact, error: artifactError } = await resolveArtifactForUser(
    supabase,
    resolved.user.id,
    { uri, artifactId }
  ).single();

  if (artifactError) {
    throw new Error(`Artifact not found: ${uri || artifactId}`);
  }

  if (parentCommentId) {
    const { data: parent, error: parentError } = await supabase
      .from('artifact_comments')
      .select('id')
      .eq('id', parentCommentId)
      .eq('artifact_id', artifact.id)
      .eq('user_id', resolved.user.id)
      .maybeSingle();

    if (parentError || !parent) {
      throw new Error(`Parent comment not found: ${parentCommentId}`);
    }
  }

  const authorIdentity = await resolveIdentityForAgent(supabase, resolved.user.id, agentId);

  const { data: created, error: createError } = await supabase
    .from('artifact_comments')
    .insert({
      artifact_id: artifact.id,
      user_id: resolved.user.id,
      created_by_agent_id: agentId || null,
      created_by_identity_id: authorIdentity?.id || null,
      parent_comment_id: parentCommentId || null,
      content: trimmed,
      metadata: metadata as Json,
    })
    .select('*')
    .single();

  if (createError) {
    throw new Error(`Failed to add artifact comment: ${createError.message}`);
  }

  logger.info('Artifact comment added', {
    artifactId: artifact.id,
    commentId: created.id,
    agentId: agentId || null,
    identityId: authorIdentity?.id || null,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          message: 'Artifact comment added',
          comment: {
            id: created.id,
            artifactId: created.artifact_id,
            parentCommentId: created.parent_comment_id,
            content: created.content,
            metadata: created.metadata,
            createdByAgentId: created.created_by_agent_id,
            createdByIdentityId: created.created_by_identity_id,
            createdByIdentity: authorIdentity
              ? {
                  id: authorIdentity.id,
                  agentId: authorIdentity.agent_id,
                  name: authorIdentity.name,
                  backend: authorIdentity.backend,
                }
              : null,
            createdAt: created.created_at,
            updatedAt: created.updated_at,
          },
        }),
      },
    ],
  };
}

export async function handleListArtifactComments(
  args: unknown,
  dataComposer: DataComposer
) {
  const supabase = dataComposer.getClient();
  const parsed = listArtifactCommentsSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { uri, artifactId, limit = 100 } = parsed;

  const { data: artifact, error: artifactError } = await resolveArtifactForUser(
    supabase,
    resolved.user.id,
    { uri, artifactId }
  ).single();

  if (artifactError) {
    throw new Error(`Artifact not found: ${uri || artifactId}`);
  }

  const { data: comments, error } = await supabase
    .from('artifact_comments')
    .select('*')
    .eq('artifact_id', artifact.id)
    .eq('user_id', resolved.user.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to list artifact comments: ${error.message}`);
  }

  const identityIds = Array.from(
    new Set((comments || []).map((c) => c.created_by_identity_id).filter(Boolean) as string[])
  );

  let identitiesById = new Map<string, { id: string; agent_id: string; name: string; backend: string | null }>();
  if (identityIds.length > 0) {
    const { data: identities, error: identitiesError } = await supabase
      .from('agent_identities')
      .select('id, agent_id, name, backend')
      .in('id', identityIds);

    if (identitiesError) {
      throw new Error(`Failed to resolve comment identities: ${identitiesError.message}`);
    }

    identitiesById = new Map(
      (identities || []).map((identity) => [identity.id, identity])
    );
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          artifactId: artifact.id,
          artifactUri: artifact.uri,
          count: comments?.length || 0,
          comments: (comments || []).map((comment) => {
            const identity = comment.created_by_identity_id
              ? identitiesById.get(comment.created_by_identity_id) ?? null
              : null;
            return {
              id: comment.id,
              artifactId: comment.artifact_id,
              parentCommentId: comment.parent_comment_id,
              content: comment.content,
              metadata: comment.metadata,
              createdByAgentId: comment.created_by_agent_id,
              createdByIdentityId: comment.created_by_identity_id,
              createdByIdentity: identity
                ? {
                    id: identity.id,
                    agentId: identity.agent_id,
                    name: identity.name,
                    backend: identity.backend,
                  }
                : null,
              createdAt: comment.created_at,
              updatedAt: comment.updated_at,
            };
          }),
        }),
      },
    ],
  };
}

// ============== Tool Registration ==============

export const artifactToolDefinitions = [
  {
    name: 'create_artifact',
    description:
      'Create a shared artifact (spec, design, document). Artifacts are collaborative resources with versioning, distinct from personal memories. Use for specs, designs, decisions, and shared documents.',
    schema: createArtifactSchema,
    handler: handleCreateArtifact,
  },
  {
    name: 'get_artifact',
    description: 'Get an artifact by URI or ID. Returns the full content and metadata.',
    schema: getArtifactSchema,
    handler: handleGetArtifact,
  },
  {
    name: 'update_artifact',
    description:
      'Update an artifact. Supports three-way merge via baseVersion parameter to prevent data loss during concurrent edits. Pass baseVersion (from the version you read) to enable auto-merge.',
    schema: updateArtifactSchema,
    handler: handleUpdateArtifact,
  },
  {
    name: 'list_artifacts',
    description: 'List artifacts with optional filters for type, tags, visibility, and search.',
    schema: listArtifactsSchema,
    handler: handleListArtifacts,
  },
  {
    name: 'get_artifact_history',
    description: 'Get version history for an artifact.',
    schema: getArtifactHistorySchema,
    handler: handleGetArtifactHistory,
  },
  {
    name: 'add_artifact_comment',
    description:
      'Add a comment to an artifact without modifying artifact content. Uses identity_id UUID as canonical author reference.',
    schema: addArtifactCommentSchema,
    handler: handleAddArtifactComment,
  },
  {
    name: 'list_artifact_comments',
    description: 'List comments for an artifact, including canonical identity UUID author metadata.',
    schema: listArtifactCommentsSchema,
    handler: handleListArtifactComments,
  },
];
