/**
 * Artifact Handlers
 *
 * MCP tools for managing shared artifacts (specs, designs, documents).
 * Artifacts are collaborative resources distinct from personal memories.
 */

import { z } from 'zod';
// node-diff3 is ESM-only; dynamic import required from CJS context
async function loadDiff3() {
  const mod = await import('node-diff3');
  return { diff3Merge: mod.merge, diff3MergeRegions: mod.diff3Merge };
}
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DataComposer } from '../../data/composer';
import { resolveUserOrThrow, userIdentifierBaseSchema } from '../../services/user-resolver';
import { logger } from '../../utils/logger';
import { getEffectiveAgentId } from '../../auth/enforce-identity';
import type { Database, Json } from '../../data/supabase/types';
import { mergeWithContext } from '../../utils/request-context';
import { resolveWorkspaceScopeForWrite } from '../../utils/workspace-scope';
import { EmbeddingRouter } from '../../services/embeddings/router';
import { formatVectorLiteral } from '../../services/embeddings/memory-chunks';

const embeddingRouter = new EmbeddingRouter();

async function tryEmbedArtifact(
  supabase: SupabaseClient<Database>,
  artifactId: string,
  title: string,
  content: string,
  existingMetadata: Record<string, unknown>
): Promise<void> {
  if (!embeddingRouter.isEnabled()) return;

  try {
    const textToEmbed = `${title}\n\n${content}`;
    const result = await embeddingRouter.embedDocument(textToEmbed);
    if (!result) return;

    const { error } = await supabase
      .from('artifacts')
      .update({
        embedding: formatVectorLiteral(result.vector),
        metadata: {
          ...existingMetadata,
          embedding: {
            provider: result.provider,
            model: result.model,
            dimensions: result.dimensions,
            updatedAt: new Date().toISOString(),
          },
        } as Json,
      })
      .eq('id', artifactId);

    if (error) {
      logger.warn('Failed to persist artifact embedding', { artifactId, error: error.message });
    }
  } catch (err) {
    logger.warn('Artifact embedding failed', {
      artifactId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ============== Schemas ==============

const workspaceScopedUserIdentifierSchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().uuid().optional().describe('Optional product workspace scope'),
});

// The Library derives folders from the URI's first path segment, so URIs must
// follow ink://<namespace>/<path>. All pre-existing artifacts conform (94/94).
const ARTIFACT_URI_PATTERN = /^ink:\/\/[a-z0-9][a-z0-9-]*(\/[A-Za-z0-9._-]+)+$/;
const artifactUriSchema = z
  .string()
  .regex(
    ARTIFACT_URI_PATTERN,
    'Artifact URIs must look like ink://<namespace>/<slug> — lowercase namespace; letters, digits, dot, underscore, hyphen in path segments'
  );

const createArtifactSchema = workspaceScopedUserIdentifierSchema.extend({
  uri: artifactUriSchema.describe(
    'Unique URI for the artifact (e.g., "ink://specs/orchestration"). The first path segment is its Library folder.'
  ),
  title: z.string().describe('Title of the artifact'),
  content: z.string().describe('Content (typically markdown)'),
  artifactType: z
    .enum(['spec', 'design', 'decision', 'document', 'note'])
    .optional()
    .default('document')
    .describe('Type of artifact'),
  agentId: z.string().optional().describe('Agent creating this artifact'),
  editMode: z
    .enum(['workspace', 'editors'])
    .optional()
    .default('workspace')
    .describe('Edit permission mode: workspace (all workspace agents) or editors list only'),
  editors: z.array(z.string()).optional().describe('Editor IDs when editMode is editors'),
  collaborators: z.array(z.string()).optional().describe('Backward-compatible alias for editors'),
  visibility: z
    .enum(['private', 'shared', 'public'])
    .optional()
    .default('private')
    .describe('Visibility level'),
  tags: z.array(z.string()).optional().describe('Tags for categorization'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
});

const getArtifactSchema = workspaceScopedUserIdentifierSchema.extend({
  uri: z.string().optional().describe('URI of the artifact'),
  artifactId: z.string().uuid().optional().describe('ID of the artifact'),
  includeComments: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include comments in the response'),
  commentLimit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .describe('Max comments when includeComments=true'),
});

const updateArtifactSchema = workspaceScopedUserIdentifierSchema.extend({
  uri: z.string().optional().describe('URI of the artifact to update'),
  artifactId: z.string().uuid().optional().describe('ID of the artifact to update'),
  newUri: artifactUriSchema
    .optional()
    .describe(
      'Rename/move the artifact to this URI (moving between Library folders = changing the namespace segment). The old URI keeps resolving via an alias.'
    ),
  title: z.string().optional().describe('New title'),
  content: z.string().optional().describe('New content'),
  baseVersion: z
    .number()
    .int()
    .optional()
    .describe(
      'Version this edit is based on. When provided, enables three-way merge: if the artifact has been modified since this version, the server will attempt to merge changes automatically. Omit for legacy last-write-wins behavior.'
    ),
  agentId: z.string().optional().describe('Agent making the update'),
  editMode: z.enum(['workspace', 'editors']).optional().describe('Updated edit permission mode'),
  editors: z.array(z.string()).optional().describe('Updated editor IDs'),
  collaborators: z.array(z.string()).optional().describe('Backward-compatible alias for editors'),
  tags: z.array(z.string()).optional().describe('Updated tags'),
  changeSummary: z.string().optional().describe('Summary of changes'),
});

const listArtifactsSchema = workspaceScopedUserIdentifierSchema.extend({
  artifactType: z.string().optional().describe('Filter by type'),
  tags: z.array(z.string()).optional().describe('Filter by tags (any match)'),
  visibility: z.enum(['private', 'shared', 'public']).optional().describe('Filter by visibility'),
  search: z.string().optional().describe('Search in title and content'),
  limit: z.number().min(1).max(100).optional().default(20).describe('Max results'),
});

const getArtifactHistorySchema = workspaceScopedUserIdentifierSchema.extend({
  uri: z.string().optional().describe('URI of the artifact'),
  artifactId: z.string().uuid().optional().describe('ID of the artifact'),
  limit: z.number().min(1).max(50).optional().default(10).describe('Max history entries'),
});

const addArtifactCommentSchema = workspaceScopedUserIdentifierSchema.extend({
  uri: z.string().optional().describe('URI of the artifact'),
  artifactId: z.string().uuid().optional().describe('ID of the artifact'),
  content: z.string().min(1).describe('Comment text'),
  agentId: z.string().optional().describe('Agent authoring the comment'),
  parentCommentId: z
    .string()
    .uuid()
    .optional()
    .describe('Optional parent comment ID for threading'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
});

const listArtifactCommentsSchema = workspaceScopedUserIdentifierSchema.extend({
  uri: z.string().optional().describe('URI of the artifact'),
  artifactId: z.string().uuid().optional().describe('ID of the artifact'),
  limit: z.number().min(1).max(200).optional().default(100).describe('Max comments to return'),
});

const searchArtifactsSchema = workspaceScopedUserIdentifierSchema.extend({
  query: z.string().describe('Search query text'),
  mode: z
    .enum(['text', 'semantic', 'hybrid', 'auto'])
    .optional()
    .default('auto')
    .describe(
      'Search mode: text (keyword/trigram), semantic (embedding similarity), hybrid (blended), auto (hybrid if embeddings enabled, else text)'
    ),
  artifactType: z
    .enum(['spec', 'design', 'decision', 'document', 'note'])
    .optional()
    .describe('Filter by artifact type'),
  tags: z.array(z.string()).optional().describe('Filter by tags (any match)'),
  limit: z.number().min(1).max(50).optional().default(10).describe('Max results to return'),
});

// ============== Helpers ==============

function withWorkspaceFilter<T>(query: T, workspaceId?: string): T {
  if (!workspaceId) return query;
  const queryWithEq = query as { eq?: (column: string, value: string) => T };
  if (typeof queryWithEq.eq !== 'function') return query;
  return queryWithEq.eq('workspace_id', workspaceId);
}

function parseWithContext<T extends z.ZodTypeAny>(schema: T, args: unknown): z.infer<T> {
  const merged = mergeWithContext((args ?? {}) as Record<string, unknown>);
  return schema.parse(merged);
}

function toArgsRecord(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  return args as Record<string, unknown>;
}

type ArtifactEditMode = 'workspace' | 'editors';

function normalizeEditMode(value: string | null | undefined): ArtifactEditMode {
  return value === 'editors' ? 'editors' : 'workspace';
}

function normalizeEditorAgentIds(values: string[] | undefined): string[] {
  if (!values) return [];
  return Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))
  );
}

async function deriveWorkspaceIdFromAgent(
  supabase: SupabaseClient<Database>,
  userId: string,
  agentId: string
): Promise<string | null> {
  // TODO(lumen): Deduplicate with MCPServer.deriveWorkspaceIdFromAgent in
  // server.ts via a shared helper; keep strict throw-on-ambiguous behavior
  // here for write-path safety.
  const { data, error } = await supabase
    .from('agent_identities')
    .select('workspace_id')
    .eq('user_id', userId)
    .eq('agent_id', agentId);

  if (error) {
    logger.warn('Failed to derive workspace from agent identity', {
      userId,
      agentId,
      error: error.message,
    });
    return null;
  }

  const workspaceIds = Array.from(
    new Set(
      (data || [])
        .map((row) => row.workspace_id)
        .filter((workspaceId): workspaceId is string => typeof workspaceId === 'string')
    )
  );

  if (workspaceIds.length === 1) return workspaceIds[0];
  if (workspaceIds.length > 1) {
    throw new Error(
      `Workspace is ambiguous for agent "${agentId}". Provide workspaceId or X-PCP-Workspace-Id.`
    );
  }

  return null;
}

async function resolveIdentityForAgent(
  supabase: SupabaseClient<Database>,
  userId: string,
  workspaceId: string | undefined,
  agentId?: string
) {
  if (!agentId) return null;

  let query = supabase
    .from('agent_identities')
    .select('id, agent_id, name, backend')
    .eq('user_id', userId)
    .eq('agent_id', agentId);

  query = withWorkspaceFilter(query, workspaceId);
  const { data, error } = await query.maybeSingle();

  if (error) {
    logger.warn(
      'Failed to resolve identity UUID for agent slug; continuing with slug-only reference',
      {
        userId,
        agentId,
        error: error.message,
      }
    );
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

type ArtifactCommentAuthorUser = {
  id: string;
  first_name: string | null;
  username: string | null;
  email: string | null;
};

function formatArtifactCommentAuthorUserName(
  user: ArtifactCommentAuthorUser | null
): string | null {
  if (!user) return null;
  if (user.first_name?.trim()) return user.first_name.trim();
  if (user.username?.trim()) return user.username.trim();
  if (user.email?.trim()) return user.email.trim();
  return null;
}

function resolveArtifactForUser(
  supabase: SupabaseClient<Database>,
  userId: string,
  workspaceId: string | undefined,
  params: { uri?: string; artifactId?: string }
) {
  const { uri, artifactId } = params;
  if (!uri && !artifactId) {
    throw new Error('Must provide either uri or artifactId');
  }

  let query = supabase.from('artifacts').select('*').eq('user_id', userId);
  query = withWorkspaceFilter(query, workspaceId);

  if (uri) {
    query = query.eq('uri', uri);
  } else if (artifactId) {
    query = query.eq('id', artifactId);
  }

  return query;
}

type ArtifactRow = Database['public']['Tables']['artifacts']['Row'];

/**
 * Resolve an artifact by URI or id, falling back to artifact_uri_aliases on a
 * canonical URI miss — a rename leaves the old URI resolving forever
 * (spec:library). resolvedViaAlias carries the requested URI when the alias
 * path was taken, so callers can tell readers the canonical address.
 */
async function resolveArtifactRowForUser(
  supabase: SupabaseClient<Database>,
  userId: string,
  workspaceId: string | undefined,
  params: { uri?: string; artifactId?: string }
): Promise<{ artifact: ArtifactRow | null; resolvedViaAlias: string | null }> {
  const { data, error } = await resolveArtifactForUser(
    supabase,
    userId,
    workspaceId,
    params
  ).maybeSingle();
  if (error && error.code !== 'PGRST116') {
    throw new Error(`Failed to resolve artifact: ${error.message}`);
  }
  if (data || !params.uri) {
    return { artifact: data ?? null, resolvedViaAlias: null };
  }

  const { data: alias, error: aliasError } = await supabase
    .from('artifact_uri_aliases')
    .select('artifact_id')
    .eq('alias_uri', params.uri)
    .eq('user_id', userId)
    .maybeSingle();
  // A lookup failure is infrastructure, not a miss — surfacing it as
  // not-found would make renamed artifacts appear absent (round 1, Lumen).
  if (aliasError) {
    throw new Error(`Failed to resolve artifact alias: ${aliasError.message}`);
  }
  if (!alias) {
    return { artifact: null, resolvedViaAlias: null };
  }

  const { data: aliased, error: aliasedError } = await resolveArtifactForUser(
    supabase,
    userId,
    workspaceId,
    { artifactId: alias.artifact_id }
  ).maybeSingle();
  if (aliasedError && aliasedError.code !== 'PGRST116') {
    throw new Error(`Failed to resolve artifact: ${aliasedError.message}`);
  }
  return { artifact: aliased ?? null, resolvedViaAlias: aliased ? params.uri : null };
}

// ============== Handlers ==============

export async function handleCreateArtifact(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const rawArgs = toArgsRecord(args);
  const parsed = parseWithContext(createArtifactSchema, args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const {
    uri,
    title,
    content,
    artifactType = 'document',
    editMode = 'workspace',
    editors,
    collaborators,
    visibility = 'private',
    tags = [],
    metadata = {},
    workspaceId,
  } = parsed;
  const normalizedEditors = normalizeEditorAgentIds(editors ?? collaborators);
  if (editMode === 'editors' && normalizedEditors.length === 0) {
    throw new Error('editMode "editors" requires at least one editor');
  }
  const effectiveEditors = normalizedEditors;
  const agentId = getEffectiveAgentId(parsed.agentId);
  const workspaceResolution = await resolveWorkspaceScopeForWrite({
    rawArgs,
    explicitWorkspaceId: workspaceId,
    agentId,
    deriveWorkspaceIdFromAgent: (candidateAgentId) =>
      deriveWorkspaceIdFromAgent(supabase, resolved.user.id, candidateAgentId),
  });
  if (!workspaceResolution) {
    throw new Error(
      'Artifact write requires workspace scope. Provide X-PCP-Workspace-Id, workspaceId, or a workspace-scoped agent identity.'
    );
  }
  const workspaceScope = workspaceResolution.workspaceId;
  const authorIdentity = await resolveIdentityForAgent(
    supabase,
    resolved.user.id,
    workspaceScope,
    agentId
  );

  // Check if URI already exists
  let existingQuery = supabase
    .from('artifacts')
    .select('id')
    .eq('user_id', resolved.user.id)
    .eq('uri', uri);
  existingQuery = withWorkspaceFilter(existingQuery, workspaceScope);
  const { data: existing } = await existingQuery.maybeSingle();

  if (existing) {
    throw new Error(`Artifact with URI "${uri}" already exists`);
  }

  // A URI that was left behind by a rename stays reserved: creating there would
  // silently capture every reader still following the old link. The DB trigger
  // backstops this check against races.
  const { data: aliasHit } = await supabase
    .from('artifact_uri_aliases')
    .select('artifact_id')
    .eq('alias_uri', uri)
    .maybeSingle();
  if (aliasHit) {
    throw new Error(
      `Artifact URI "${uri}" is an alias of an existing artifact (it was renamed). Choose a different URI.`
    );
  }

  const { data: artifact, error } = await supabase
    .from('artifacts')
    .insert({
      uri,
      user_id: resolved.user.id,
      workspace_id: workspaceScope,
      created_by_sb_id: authorIdentity?.id || null,
      title,
      content,
      artifact_type: artifactType,
      collaborators: effectiveEditors,
      edit_mode: editMode,
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
    workspace_id: workspaceScope,
    version: 1,
    title,
    content,
    changed_by_sb_id: authorIdentity?.id || null,
    changed_by_user_id: agentId ? null : resolved.user.id,
    change_type: 'create',
    change_summary: 'Initial creation',
  });

  logger.info('Artifact created', { uri, type: artifactType, agentId });

  // Best-effort embedding — don't block the response
  tryEmbedArtifact(
    supabase,
    artifact.id,
    title,
    content,
    (metadata || {}) as Record<string, unknown>
  );

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
            editMode: normalizeEditMode(artifact.edit_mode),
            editors: artifact.collaborators || [],
            version: artifact.version,
            createdAt: artifact.created_at,
          },
        }),
      },
    ],
  };
}

export async function handleGetArtifact(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = parseWithContext(getArtifactSchema, args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { uri, artifactId, includeComments = false, commentLimit = 50, workspaceId } = parsed;
  const { artifact, resolvedViaAlias } = await resolveArtifactRowForUser(
    supabase,
    resolved.user.id,
    workspaceId,
    { uri, artifactId }
  );

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

  let comments: Array<{
    id: string;
    artifactId: string;
    parentCommentId: string | null;
    content: string;
    metadata: Json | null;
    createdByAgentId: string | null;
    createdByUserId: string | null;
    createdByUser: {
      id: string;
      name: string | null;
      username: string | null;
      email: string | null;
    } | null;
    createdBySbId: string | null;
    createdByIdentity: { id: string; agentId: string; name: string; backend: string | null } | null;
    createdAt: string | null;
    updatedAt: string | null;
  }> = [];

  if (includeComments) {
    const { data: commentRows, error: commentsError } = await supabase
      .from('artifact_comments')
      .select('*')
      .eq('artifact_id', artifact.id)
      .eq('user_id', resolved.user.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(commentLimit);

    if (commentsError) {
      throw new Error(`Failed to get artifact comments: ${commentsError.message}`);
    }

    const sbIds = Array.from(
      new Set((commentRows || []).map((c) => c.created_by_sb_id).filter(Boolean) as string[])
    );
    const commentAuthorUserIds = Array.from(
      new Set(
        (commentRows || [])
          .map((comment) => comment.created_by_user_id || comment.user_id)
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
      )
    );

    let identitiesById = new Map<
      string,
      { id: string; agent_id: string; name: string; backend: string | null }
    >();
    let commentUsersById = new Map<string, ArtifactCommentAuthorUser>();
    if (sbIds.length > 0) {
      const { data: identities, error: identitiesError } = await supabase
        .from('agent_identities')
        .select('id, agent_id, name, backend')
        .in('id', sbIds);

      if (identitiesError) {
        throw new Error(
          `Failed to resolve artifact comment identities: ${identitiesError.message}`
        );
      }

      identitiesById = new Map((identities || []).map((identity) => [identity.id, identity]));
    }

    if (commentAuthorUserIds.length > 0) {
      const { data: commentUsers, error: commentUsersError } = await supabase
        .from('users')
        .select('id, first_name, username, email')
        .in('id', commentAuthorUserIds);

      if (commentUsersError) {
        throw new Error(`Failed to resolve artifact comment users: ${commentUsersError.message}`);
      }

      commentUsersById = new Map(
        (commentUsers || []).map((commentUser) => [commentUser.id, commentUser])
      );
    }

    comments = (commentRows || []).map((comment) => {
      const identity = comment.created_by_sb_id
        ? (identitiesById.get(comment.created_by_sb_id) ?? null)
        : null;
      const commentAuthorUserId = comment.created_by_user_id || comment.user_id || null;
      const commentAuthorUser = commentAuthorUserId
        ? (commentUsersById.get(commentAuthorUserId) ?? null)
        : null;
      return {
        id: comment.id,
        artifactId: comment.artifact_id,
        parentCommentId: comment.parent_comment_id,
        content: comment.content,
        metadata: comment.metadata,
        createdByAgentId: identity?.agent_id ?? null,
        createdByUserId: commentAuthorUserId,
        createdByUser: commentAuthorUser
          ? {
              id: commentAuthorUser.id,
              name: formatArtifactCommentAuthorUserName(commentAuthorUser),
              username: commentAuthorUser.username,
              email: commentAuthorUser.email,
            }
          : null,
        createdBySbId: comment.created_by_sb_id,
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
    });
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          ...(resolvedViaAlias
            ? {
                resolvedViaAlias,
                canonicalUri: artifact.uri,
                note: `"${resolvedViaAlias}" is a former URI of this artifact; update links to ${artifact.uri}.`,
              }
            : {}),
          artifact: {
            id: artifact.id,
            uri: artifact.uri,
            title: artifact.title,
            content: artifact.content,
            contentType: artifact.content_type,
            artifactType: artifact.artifact_type,
            createdBySbId: artifact.created_by_sb_id,
            collaborators: artifact.collaborators,
            editMode: normalizeEditMode(artifact.edit_mode),
            editors: artifact.collaborators || [],
            visibility: artifact.visibility,
            version: artifact.version,
            tags: artifact.tags,
            metadata: artifact.metadata,
            createdAt: artifact.created_at,
            updatedAt: artifact.updated_at,
            ...(includeComments ? { commentCount: comments.length, comments } : {}),
          },
        }),
      },
    ],
  };
}

export async function handleUpdateArtifact(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const rawArgs = toArgsRecord(args);
  const parsed = parseWithContext(updateArtifactSchema, args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const {
    uri,
    artifactId,
    newUri,
    title,
    content,
    baseVersion,
    editMode,
    editors,
    collaborators,
    tags,
    changeSummary,
    workspaceId,
  } = parsed;
  const agentId = getEffectiveAgentId(parsed.agentId);
  const workspaceResolution = await resolveWorkspaceScopeForWrite({
    rawArgs,
    explicitWorkspaceId: workspaceId,
    agentId,
    deriveWorkspaceIdFromAgent: (candidateAgentId) =>
      deriveWorkspaceIdFromAgent(supabase, resolved.user.id, candidateAgentId),
  });
  if (!workspaceResolution) {
    throw new Error(
      'Artifact write requires workspace scope. Provide X-PCP-Workspace-Id, workspaceId, or a workspace-scoped agent identity.'
    );
  }
  const workspaceScope = workspaceResolution.workspaceId;
  const editorIdentity = await resolveIdentityForAgent(
    supabase,
    resolved.user.id,
    workspaceScope,
    agentId
  );

  // First, get the current artifact (alias-aware: renamed URIs keep working)
  const { artifact: current, resolvedViaAlias } = await resolveArtifactRowForUser(
    supabase,
    resolved.user.id,
    workspaceScope,
    { uri, artifactId }
  );

  if (!current) {
    throw new Error(`Artifact not found: ${uri || artifactId}`);
  }

  // Check if agent has permission to edit
  if (agentId) {
    const currentEditMode = normalizeEditMode(current.edit_mode);
    const currentEditors = current.collaborators || [];
    const editorIdentityId = editorIdentity?.id || null;
    const isCreator = editorIdentity && current.created_by_sb_id === editorIdentity.id;
    const hasEditorAccess =
      currentEditMode === 'workspace' ||
      (!!editorIdentityId && currentEditors.includes(editorIdentityId)) ||
      currentEditors.includes(agentId);

    if (!isCreator && !hasEditorAccess) {
      throw new Error(`Agent ${agentId} does not have permission to edit this artifact`);
    }
  }

  // Rename: validate the target URI before any write. The DB triggers backstop
  // every one of these checks against races (spec:library).
  let renameFrom: string | null = null;
  let redundantAliasId: string | null = null;
  if (newUri !== undefined && newUri !== current.uri) {
    const { data: occupied } = await supabase
      .from('artifacts')
      .select('id')
      .eq('uri', newUri)
      .maybeSingle();
    if (occupied) {
      throw new Error(`Cannot rename: an artifact already exists at "${newUri}"`);
    }
    const { data: aliasAtTarget } = await supabase
      .from('artifact_uri_aliases')
      .select('id, artifact_id')
      .eq('alias_uri', newUri)
      .maybeSingle();
    if (aliasAtTarget && aliasAtTarget.artifact_id !== current.id) {
      throw new Error(`Cannot rename: "${newUri}" is an alias of another artifact`);
    }
    renameFrom = current.uri;
    // Renaming back to one of this artifact's own former URIs: the alias there
    // becomes redundant and is deleted after the rename lands.
    redundantAliasId = aliasAtTarget?.id ?? null;
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
    let baseHistoryQuery = supabase
      .from('artifact_history')
      .select('content')
      .eq('artifact_id', current.id)
      .eq('version', baseVersion);
    baseHistoryQuery = withWorkspaceFilter(baseHistoryQuery, workspaceScope);
    const { data: baseHistory, error: historyError } = await baseHistoryQuery.single();

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
    const { diff3Merge, diff3MergeRegions } = await loadDiff3();
    const mergeOptions = {
      excludeFalseConflicts: true,
      stringSeparator: /\n/,
    };
    const mergeResult = diff3Merge(incomingContent, baseContent, currentContent, mergeOptions);

    if (mergeResult.conflict) {
      // Merge failed — return conflict details so the agent can resolve
      const regions = diff3MergeRegions(incomingContent, baseContent, currentContent, mergeOptions);

      const conflicts = regions
        .filter((r) => 'conflict' in r && r.conflict !== undefined)
        .map((r) => {
          const c = (r as { conflict: { a: string[]; b: string[]; o: string[] } }).conflict;
          return {
            yours: c.a.join('\n'),
            theirs: c.b.join('\n'),
            original: c.o.join('\n'),
          };
        });

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

  const currentEditMode = normalizeEditMode(current.edit_mode);
  const requestedEditors = normalizeEditorAgentIds(editors ?? collaborators);
  const nextEditMode: ArtifactEditMode = editMode ?? currentEditMode;
  let nextEditors =
    editors !== undefined || collaborators !== undefined
      ? requestedEditors
      : current.collaborators || [];

  if (nextEditMode === 'editors' && nextEditors.length === 0) {
    throw new Error('editMode "editors" requires at least one editor');
  }

  if (renameFrom) updates.uri = newUri;
  if (title !== undefined) updates.title = title;
  if (finalContent !== undefined) updates.content = finalContent;
  if (editMode !== undefined || editors !== undefined || collaborators !== undefined) {
    updates.edit_mode = nextEditMode;
    updates.collaborators = nextEditors;
  }
  if (tags !== undefined) updates.tags = tags;

  // Reserve the old URI BEFORE the CAS releases it (round 1, Lumen: with
  // insert-after-update the old URI was capturable between the two
  // statements — a squatter created at A after the CAS made the alias insert
  // fail, silently retargeting old links). The trigger permits an alias at
  // its own target's live URI exactly for this reservation; canonical
  // resolution wins until the CAS lands, a leftover reservation after a lost
  // CAS or a crash still points at the artifact that owns the URI, and a
  // reservation failure aborts the rename before anything has moved.
  if (renameFrom) {
    const { error: reserveError } = await supabase.from('artifact_uri_aliases').insert({
      user_id: resolved.user.id,
      workspace_id: current.workspace_id,
      artifact_id: current.id,
      alias_uri: renameFrom,
    });
    if (reserveError) {
      // A unique violation here should only be our own earlier reservation —
      // the triggers reject every other combination at our live URI. Verify
      // rather than assume; anything else aborts with nothing written.
      const { data: existingReservation, error: reservationLookupError } = await supabase
        .from('artifact_uri_aliases')
        .select('artifact_id')
        .eq('alias_uri', renameFrom)
        .maybeSingle();
      if (reservationLookupError || existingReservation?.artifact_id !== current.id) {
        throw new Error(
          `Cannot rename: failed to reserve the old URI "${renameFrom}" (${reserveError.message})`
        );
      }
    }
  }

  // CAS (compare-and-swap) guard: only write if version hasn't changed since we read it.
  // This prevents true race conditions where two concurrent writers both pass the
  // merge check but then one silently overwrites the other.
  const expectedVersion = current.version ?? 0;

  let updateQuery = supabase
    .from('artifacts')
    .update(updates)
    .eq('id', current.id)
    .eq('version', expectedVersion);
  updateQuery = withWorkspaceFilter(updateQuery, workspaceScope);
  const { data: updated, error: updateError } = await updateQuery.select().maybeSingle();

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
            message:
              'Artifact was modified by another writer during your update. Re-read the artifact and retry your edit with the new baseVersion.',
          }),
        },
      ],
    };
  }

  // Rename-back only: the alias that pointed at the URI we now live at again
  // is redundant — remove it so resolution has one canonical path.
  if (renameFrom && redundantAliasId) {
    await supabase.from('artifact_uri_aliases').delete().eq('id', redundantAliasId);
  }

  // Create history entry for this update
  const changeType = mergePerformed ? 'merge' : 'update';
  const renameNote = renameFrom ? `Renamed ${renameFrom} → ${updated.uri}. ` : '';
  const baseSummaryText = mergePerformed
    ? `Auto-merged with version ${current.version} (base: ${baseVersion}). ${changeSummary || ''}`
    : changeSummary || '';
  const mergeSummary = `${renameNote}${baseSummaryText}`.trim() || null;

  await supabase.from('artifact_history').insert({
    artifact_id: current.id,
    workspace_id: workspaceScope,
    version: newVersion,
    title: updated.title,
    content: updated.content,
    changed_by_sb_id: editorIdentity?.id || null,
    changed_by_user_id: agentId ? null : resolved.user.id,
    change_type: changeType,
    change_summary: mergeSummary,
  });

  logger.info('Artifact updated', {
    uri: current.uri,
    version: updated.version,
    agentId,
    mergePerformed,
  });

  // Re-embed when content or title changed
  if (finalContent !== undefined || title !== undefined) {
    tryEmbedArtifact(
      supabase,
      updated.id,
      updated.title,
      updated.content,
      (updated.metadata || {}) as Record<string, unknown>
    );
  }

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
            editMode: normalizeEditMode(updated.edit_mode),
            editors: updated.collaborators || [],
            version: updated.version,
            updatedAt: updated.updated_at,
          },
          previousVersion: current.version,
          mergePerformed,
          ...(mergePerformed ? { mergedFromBase: baseVersion } : {}),
          ...(renameFrom
            ? {
                renamedFrom: renameFrom,
                note: `The old URI ${renameFrom} keeps resolving via an alias.`,
              }
            : {}),
          ...(resolvedViaAlias ? { resolvedViaAlias, canonicalUri: updated.uri } : {}),
        }),
      },
    ],
  };
}

export async function handleListArtifacts(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = parseWithContext(listArtifactsSchema, args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { artifactType, tags, visibility, search, limit = 20, workspaceId } = parsed;

  let query = supabase
    .from('artifacts')
    .select(
      'id, uri, title, artifact_type, visibility, edit_mode, collaborators, version, tags, created_at, updated_at'
    )
    .eq('user_id', resolved.user.id);
  query = withWorkspaceFilter(query, workspaceId);
  query = query.order('updated_at', { ascending: false }).limit(limit);

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
            editMode: normalizeEditMode(a.edit_mode),
            editors: a.collaborators || [],
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

export async function handleGetArtifactHistory(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = parseWithContext(getArtifactHistorySchema, args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { uri, artifactId, limit = 10, workspaceId } = parsed;

  // First get the artifact to verify ownership (alias-aware)
  const { artifact, resolvedViaAlias } = await resolveArtifactRowForUser(
    supabase,
    resolved.user.id,
    workspaceId,
    { uri, artifactId }
  );

  if (!artifact) {
    throw new Error(`Artifact not found: ${uri || artifactId}`);
  }

  let historyQuery = supabase.from('artifact_history').select('*').eq('artifact_id', artifact.id);
  historyQuery = withWorkspaceFilter(historyQuery, workspaceId);
  const { data: history, error } = await historyQuery
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
          ...(resolvedViaAlias ? { resolvedViaAlias, canonicalUri: artifact.uri } : {}),
          artifactId: artifact.id,
          count: history?.length || 0,
          history: (history || []).map((h) => ({
            id: h.id,
            version: h.version,
            title: h.title,
            changedBySbId: h.changed_by_sb_id,
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

export async function handleAddArtifactComment(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const rawArgs = toArgsRecord(args);
  const parsed = parseWithContext(addArtifactCommentSchema, args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { uri, artifactId, content, agentId, parentCommentId, metadata = {}, workspaceId } = parsed;
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('Comment content cannot be empty');
  }

  const effectiveAgentId = getEffectiveAgentId(agentId);
  const workspaceResolution = await resolveWorkspaceScopeForWrite({
    rawArgs,
    explicitWorkspaceId: workspaceId,
    agentId: effectiveAgentId,
    deriveWorkspaceIdFromAgent: (candidateAgentId) =>
      deriveWorkspaceIdFromAgent(supabase, resolved.user.id, candidateAgentId),
  });
  if (!workspaceResolution) {
    throw new Error(
      'Artifact write requires workspace scope. Provide X-PCP-Workspace-Id, workspaceId, or a workspace-scoped agent identity.'
    );
  }
  const workspaceScope = workspaceResolution.workspaceId;

  const { artifact } = await resolveArtifactRowForUser(supabase, resolved.user.id, workspaceScope, {
    uri,
    artifactId,
  });

  if (!artifact) {
    throw new Error(`Artifact not found: ${uri || artifactId}`);
  }

  if (parentCommentId) {
    let parentQuery = supabase
      .from('artifact_comments')
      .select('id')
      .eq('id', parentCommentId)
      .eq('artifact_id', artifact.id)
      .eq('user_id', resolved.user.id);
    parentQuery = withWorkspaceFilter(parentQuery, workspaceScope);
    const { data: parent, error: parentError } = await parentQuery.maybeSingle();

    if (parentError || !parent) {
      throw new Error(`Parent comment not found: ${parentCommentId}`);
    }
  }

  const authorIdentity = await resolveIdentityForAgent(
    supabase,
    resolved.user.id,
    workspaceScope,
    effectiveAgentId
  );

  const { data: created, error: createError } = await supabase
    .from('artifact_comments')
    .insert({
      artifact_id: artifact.id,
      user_id: resolved.user.id,
      created_by_user_id: resolved.user.id,
      workspace_id: workspaceScope,
      created_by_sb_id: authorIdentity?.id || null,
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
    agentId: effectiveAgentId || null,
    sbId: authorIdentity?.id || null,
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
            createdByAgentId: authorIdentity?.agent_id || null,
            createdByUserId: created.created_by_user_id || resolved.user.id,
            createdByUser: {
              id: resolved.user.id,
              name: formatArtifactCommentAuthorUserName(resolved.user),
              username: resolved.user.username,
              email: resolved.user.email,
            },
            createdBySbId: created.created_by_sb_id,
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

export async function handleListArtifactComments(args: unknown, dataComposer: DataComposer) {
  const supabase = dataComposer.getClient();
  const parsed = parseWithContext(listArtifactCommentsSchema, args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { uri, artifactId, limit = 100, workspaceId } = parsed;

  const { artifact, resolvedViaAlias } = await resolveArtifactRowForUser(
    supabase,
    resolved.user.id,
    workspaceId,
    { uri, artifactId }
  );

  if (!artifact) {
    throw new Error(`Artifact not found: ${uri || artifactId}`);
  }

  let commentsQuery = supabase
    .from('artifact_comments')
    .select('*')
    .eq('artifact_id', artifact.id)
    .eq('user_id', resolved.user.id)
    .is('deleted_at', null);
  commentsQuery = withWorkspaceFilter(commentsQuery, workspaceId);
  const { data: comments, error } = await commentsQuery
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to list artifact comments: ${error.message}`);
  }

  const sbIds = Array.from(
    new Set((comments || []).map((c) => c.created_by_sb_id).filter(Boolean) as string[])
  );
  const commentAuthorUserIds = Array.from(
    new Set(
      (comments || [])
        .map((comment) => comment.created_by_user_id || comment.user_id)
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
    )
  );

  let identitiesById = new Map<
    string,
    { id: string; agent_id: string; name: string; backend: string | null }
  >();
  let commentUsersById = new Map<string, ArtifactCommentAuthorUser>();
  if (sbIds.length > 0) {
    let identitiesQuery = supabase
      .from('agent_identities')
      .select('id, agent_id, name, backend')
      .in('id', sbIds);
    identitiesQuery = withWorkspaceFilter(identitiesQuery, workspaceId);
    const { data: identities, error: identitiesError } = await identitiesQuery;

    if (identitiesError) {
      throw new Error(`Failed to resolve comment identities: ${identitiesError.message}`);
    }

    identitiesById = new Map((identities || []).map((identity) => [identity.id, identity]));
  }

  if (commentAuthorUserIds.length > 0) {
    const { data: commentUsers, error: commentUsersError } = await supabase
      .from('users')
      .select('id, first_name, username, email')
      .in('id', commentAuthorUserIds);

    if (commentUsersError) {
      throw new Error(`Failed to resolve comment users: ${commentUsersError.message}`);
    }

    commentUsersById = new Map(
      (commentUsers || []).map((commentUser) => [commentUser.id, commentUser])
    );
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          ...(resolvedViaAlias ? { resolvedViaAlias, canonicalUri: artifact.uri } : {}),
          artifactId: artifact.id,
          artifactUri: artifact.uri,
          count: comments?.length || 0,
          comments: (comments || []).map((comment) => {
            const identity = comment.created_by_sb_id
              ? (identitiesById.get(comment.created_by_sb_id) ?? null)
              : null;
            const commentAuthorUserId = comment.created_by_user_id || comment.user_id || null;
            const commentAuthorUser = commentAuthorUserId
              ? (commentUsersById.get(commentAuthorUserId) ?? null)
              : null;
            return {
              id: comment.id,
              artifactId: comment.artifact_id,
              parentCommentId: comment.parent_comment_id,
              content: comment.content,
              metadata: comment.metadata,
              createdByAgentId: identity?.agent_id ?? null,
              createdByUserId: commentAuthorUserId,
              createdByUser: commentAuthorUser
                ? {
                    id: commentAuthorUser.id,
                    name: formatArtifactCommentAuthorUserName(commentAuthorUser),
                    username: commentAuthorUser.username,
                    email: commentAuthorUser.email,
                  }
                : null,
              createdBySbId: comment.created_by_sb_id,
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

export async function handleSearchArtifacts(args: unknown, dataComposer: DataComposer) {
  const parsed = parseWithContext(searchArtifactsSchema, args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { query, mode = 'auto', artifactType, tags, limit = 10, workspaceId } = parsed;

  const results = await dataComposer.repositories.artifactSearch.search(
    resolved.user.id,
    query,
    mode,
    {
      artifactType,
      tags,
      workspaceId,
      limit,
    }
  );

  const SNIPPET_LENGTH = 200;

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          query,
          mode,
          resultCount: results.length,
          results: results.map((r) => ({
            title: r.title,
            uri: r.uri,
            artifactType: r.artifactType,
            snippet:
              r.content.length > SNIPPET_LENGTH
                ? r.content.slice(0, SNIPPET_LENGTH) + '...'
                : r.content,
            relevanceScore: Math.round(r.finalScore * 1000) / 1000,
            tags: r.tags,
            version: r.version,
            updatedAt: r.updatedAt,
          })),
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
    description:
      'Get an artifact by URI or ID. Returns the full content and metadata, with optional comments. Renamed URIs keep resolving via aliases — the response then carries resolvedViaAlias plus the canonical URI.',
    schema: getArtifactSchema,
    handler: handleGetArtifact,
  },
  {
    name: 'update_artifact',
    description:
      'Update an artifact. Supports three-way merge via baseVersion parameter to prevent data loss during concurrent edits. Pass baseVersion (from the version you read) to enable auto-merge. Pass newUri to rename/move it between Library folders (the URI namespace) — the old URI keeps resolving via an alias.',
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
      'Add a comment to an artifact without modifying artifact content. Uses sb_id UUID as canonical author reference.',
    schema: addArtifactCommentSchema,
    handler: handleAddArtifactComment,
  },
  {
    name: 'list_artifact_comments',
    description:
      'List comments for an artifact, including canonical identity UUID author metadata.',
    schema: listArtifactCommentsSchema,
    handler: handleListArtifactComments,
  },
  {
    name: 'search_artifacts',
    description:
      'Search artifacts using text (keyword/trigram), semantic (embedding similarity), or hybrid (blended) modes. Returns matching artifacts with title, URI, snippet, relevance score, and metadata.',
    schema: searchArtifactsSchema,
    handler: handleSearchArtifacts,
  },
];
