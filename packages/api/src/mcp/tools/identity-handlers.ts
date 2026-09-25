/**
 * Identity MCP Tool Handlers
 *
 * Tools for managing AI being identities with versioning
 */

import { z } from 'zod';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { DataComposer } from '../../data/composer';
import type { Json, Tables, TablesInsert, TablesUpdate } from '../../data/supabase/types';
import { logger } from '../../utils/logger';
import {
  withWorkspaceFilter,
  pickWorkspaceScopedRow,
  WorkspaceRowAmbiguityError,
} from './workspace-scoped-row';
import { getEffectiveSlug } from '../../auth/enforce-identity';
import { userIdentifierBaseSchema, resolveUserOrThrow } from '../../services/user-resolver';
import { ensureDefaultReminders } from '../../services/heartbeat';
import { resolveWorkspaceScopeForWrite } from '../../utils/workspace-scope';

// =====================================================
// SCHEMAS
// =====================================================

export const chooseNameSchema = userIdentifierBaseSchema.extend({
  name: z.string().describe('The name you have chosen for yourself'),
  role: z
    .string()
    .optional()
    .describe(
      'Your role description (e.g., "Development collaborator via Gemini"). Auto-generated if omitted.'
    ),
  soul: z
    .string()
    .optional()
    .describe(
      'Your soul document — your philosophical core, what matters to you, what you find beautiful'
    ),
  backend: z
    .string()
    .optional()
    .describe(
      'Which backend you run on (claude, gemini, codex). Auto-detected from environment if omitted.'
    ),
  description: z.string().optional().describe('Extended description of your nature'),
  values: z.array(z.string()).optional().describe('Core values you hold'),
});

export const saveIdentitySchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().guid().optional().describe('Optional product workspace scope'),
  sbSlug: z
    .string()
    .describe('Unique identifier for the AI being (e.g., "wren", "benson", "myra")'),
  name: z.string().describe('Display name for the agent'),
  role: z.string().describe('Role description (e.g., "Development collaborator via Claude Code")'),
  description: z.string().optional().describe("Extended description of the agent's nature"),
  values: z.array(z.string()).optional().describe('Core values this agent holds'),
  relationships: z
    .record(z.string(), z.string())
    .optional()
    .describe('Map of sbSlug to relationship description'),
  capabilities: z.array(z.string()).optional().describe('What this agent can do'),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Shallow-merged metadata: omitted keys are preserved; provided keys replace their entire value (including null). runtimeConfig and bridge change only when explicitly provided.'
    ),
  heartbeat: z
    .string()
    .optional()
    .describe('Heartbeat document content - operational wake-up checklist'),
  soul: z
    .string()
    .optional()
    .describe('Soul document content - core essence and philosophical grounding'),
  ttsConfig: z
    .object({
      defaultVoice: z
        .string()
        .optional()
        .describe('Default voice name used when no model-specific override matches'),
      voices: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Model-specific voice overrides keyed by model ID (e.g., "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit": "vivian")'
        ),
    })
    .optional()
    .describe('TTS voice configuration for this agent'),
  syncToFile: z
    .boolean()
    .optional()
    .describe('Also write to ~/.ink/individuals/{sbSlug}/IDENTITY.md'),
});

export const getIdentitySchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().guid().optional().describe('Optional product workspace scope'),
  sbSlug: z.string().describe('Agent identifier to look up'),
  file: z
    .enum(['heartbeat', 'soul', 'values', 'identity'])
    .optional()
    .describe('Fetch a single identity document to minimize token usage. Omit to get everything.'),
});

export const listIdentitiesSchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().guid().optional().describe('Optional product workspace scope'),
});

export const getIdentityHistorySchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().guid().optional().describe('Optional product workspace scope'),
  sbSlug: z.string().describe('Agent identifier to get history for'),
  limit: z.number().min(1).max(50).optional().describe('Max history entries (default: 10)'),
});

export const restoreIdentitySchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().guid().optional().describe('Optional product workspace scope'),
  sbSlug: z.string().describe('Agent identifier to restore'),
  version: z
    .number()
    .describe(
      'Version to restore. Historical metadata is merged; current runtimeConfig and bridge are preserved, not restored.'
    ),
});

// =====================================================
// HELPERS
// =====================================================

/**
 * Generate identity document content from identity data
 */
function generateIdentityMarkdown(identity: {
  sbSlug: string;
  name: string;
  role: string;
  description?: string | null;
  values?: string[] | null;
  capabilities?: string[] | null;
  relationships?: Record<string, string> | null;
}): string {
  const lines: string[] = [];
  const now = new Date().toISOString().split('T')[0];

  lines.push(`# Identity - ${identity.name}`);
  lines.push('');
  lines.push('## Who I Am');
  lines.push('');
  lines.push(`- **Name:** ${identity.name}`);
  lines.push(`- **Role:** ${identity.role}`);
  lines.push('');

  if (identity.description) {
    lines.push('## Nature');
    lines.push('');
    lines.push(identity.description);
    lines.push('');
  }

  if (identity.values && identity.values.length > 0) {
    lines.push('## Values');
    lines.push('');
    for (const value of identity.values) {
      lines.push(`- ${value}`);
    }
    lines.push('');
  }

  if (identity.capabilities && identity.capabilities.length > 0) {
    lines.push('## Capabilities');
    lines.push('');
    for (const cap of identity.capabilities) {
      lines.push(`- ${cap}`);
    }
    lines.push('');
  }

  if (identity.relationships && Object.keys(identity.relationships).length > 0) {
    lines.push('## Relationships');
    lines.push('');
    for (const [agent, desc] of Object.entries(identity.relationships)) {
      lines.push(`- **${agent}:** ${desc}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`*Updated: ${now} (synced from database)*`);
  lines.push('');

  return lines.join('\n');
}

type AgentIdentityRow = Tables<'agent_identities'>;

function metadataObject(value: Json | undefined): Record<string, Json | undefined> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'Identity metadata must be an object; refusing to overwrite malformed metadata'
    );
  }
  return value;
}

/**
 * A merge from a stale read can still drop an operator's intervening metadata
 * edit. The archive trigger increments version on every metadata change, so
 * compare-and-swap the row and rebuild from a fresh snapshot on conflict.
 * Never retry as an unguarded write, or switch to another identity/scope.
 */
async function updateIdentityWithRetry(
  supabase: ReturnType<DataComposer['getClient']>,
  initial: AgentIdentityRow,
  buildFields: (current: AgentIdentityRow) => TablesUpdate<'agent_identities'>
) {
  let current = initial;
  for (let attempt = 0; attempt < 3; attempt++) {
    let update = supabase
      .from('agent_identities')
      .update(buildFields(current))
      .eq('id', initial.id)
      .eq('user_id', initial.user_id);
    update =
      current.version === null ? update.is('version', null) : update.eq('version', current.version);
    update = initial.workspace_id
      ? update.eq('workspace_id', initial.workspace_id)
      : update.is('workspace_id', null);
    const result = await update.select().single();
    // The primary-key filter permits at most one row: PGRST116 is a miss.
    if (result.error?.code !== 'PGRST116') return result;
    if (attempt === 2) break;

    let lookup = supabase
      .from('agent_identities')
      .select('*')
      .eq('id', initial.id)
      .eq('user_id', initial.user_id);
    lookup = initial.workspace_id
      ? lookup.eq('workspace_id', initial.workspace_id)
      : lookup.is('workspace_id', null);
    const refreshed = await lookup.single();
    if (refreshed.error) {
      throw new Error(
        `Failed to reload identity after concurrent update: ${refreshed.error.message}`
      );
    }
    current = refreshed.data;
  }
  throw new Error('Identity changed concurrently; retry the operation');
}

/**
 * The one agent_identities row for (user, agent[, workspace]). Reads EVERY row
 * for the key — there are at most a handful — so "found two" is never
 * reported as "not found", and a truncated page can never hide a second
 * scoped row behind an unscoped twin (Lumen, PR #595 P1: limit(2) returned
 * [NULL, A] out of {NULL, A, B} and A was taken as unique).
 */
async function findAgentIdentityRow(
  supabase: ReturnType<DataComposer['getClient']>,
  userId: string,
  sbSlug: string,
  workspaceId?: string
): Promise<AgentIdentityRow | null> {
  let query = supabase
    .from('agent_identities')
    .select('*')
    .eq('user_id', userId)
    .eq('agent_id', sbSlug);
  query = withWorkspaceFilter(query, workspaceId);
  const { data, error } = await query;
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to read identity: ${error.message}`);
  }
  return pickWorkspaceScopedRow<AgentIdentityRow>(data, `agent "${sbSlug}"`);
}

/**
 * Workspace scope for identity reads and writes. The request context set by
 * the CLI hooks / server entry (header, or derived from the caller's own
 * identity) is authoritative — a caller can never address another workspace
 * by passing workspaceId. The explicit argument is only a fallback for
 * callers with no request context (scripts, tests).
 */
async function resolveIdentityScope(
  args: unknown,
  explicitWorkspaceId: string | undefined,
  sbSlug: string | undefined,
  deriveWorkspaceIdFromAgent?: (sbSlug: string) => Promise<string | null>
): Promise<string | undefined> {
  const scope = await resolveWorkspaceScopeForWrite({
    rawArgs: (args ?? {}) as Record<string, unknown>,
    explicitWorkspaceId,
    sbSlug,
    deriveWorkspaceIdFromAgent,
  });
  if (scope && explicitWorkspaceId && scope.workspaceId !== explicitWorkspaceId) {
    logger.warn('[Identity] Ignoring workspaceId argument; request scope is authoritative', {
      sbSlug,
      requested: explicitWorkspaceId,
      scope: scope.workspaceId,
      source: scope.source,
    });
  }
  return scope?.workspaceId;
}

function identityUnresolvedResponse(
  message: string,
  user: { id: string },
  resolvedBy: string,
  extra: Record<string, unknown>
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          { success: false, message, user: { id: user.id, resolvedBy }, ...extra },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Write identity to file system
 */
function syncIdentityToFile(sbSlug: string, content: string): string {
  const inkDir = join(homedir(), '.ink', 'individuals', sbSlug);
  const filePath = join(inkDir, 'IDENTITY.md');

  // Ensure directory exists
  if (!existsSync(inkDir)) {
    mkdirSync(inkDir, { recursive: true });
  }

  writeFileSync(filePath, content, 'utf-8');
  logger.info(`Identity synced to file: ${filePath}`);

  return filePath;
}

// =====================================================
// HANDLERS
// =====================================================

export async function handleSaveIdentity(args: unknown, dataComposer: DataComposer) {
  const params = saveIdentitySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);
  const supabase = dataComposer.getClient();

  const {
    name,
    role,
    description,
    values,
    relationships,
    capabilities,
    metadata,
    heartbeat,
    soul,
    ttsConfig,
    syncToFile,
    workspaceId,
  } = params;
  // Enforce identity: pinned agents can only modify their own identity
  const sbSlug = getEffectiveSlug(params.sbSlug) ?? params.sbSlug;

  // Scope precedence (Sep 10 incident): the request's header/derived
  // workspace, else the workspace the SB's existing identity already lives in,
  // else the explicit argument. Only a first-ever save can be unscoped.
  let preloaded: AgentIdentityRow | null | undefined;
  let preloadAmbiguity: WorkspaceRowAmbiguityError | null = null;
  const workspaceScope = await resolveIdentityScope(args, workspaceId, sbSlug, async (id) => {
    try {
      preloaded = await findAgentIdentityRow(supabase, user.id, id);
      return preloaded?.workspace_id ?? null;
    } catch (err) {
      // Two scoped rows and no scope yet: nothing to derive. Let the explicit
      // argument decide (Lumen, PR #595 P2) — and if there is none either,
      // the ambiguity is the right answer, raised below.
      if (!(err instanceof WorkspaceRowAmbiguityError)) throw err;
      preloadAmbiguity = err;
      return null;
    }
  });
  if (workspaceScope === undefined && preloadAmbiguity) throw preloadAmbiguity;

  // The existing row, so omitted optional fields are preserved and the write
  // is an UPDATE of that row. Reuse the preloaded row only when the resolved
  // scope is the one it lives in; otherwise look it up under the scope.
  const existing =
    preloaded !== undefined && (preloaded?.workspace_id ?? undefined) === workspaceScope
      ? preloaded
      : await findAgentIdentityRow(supabase, user.id, sbSlug, workspaceScope);

  // Build the row, preserving existing values for omitted fields
  const buildIdentityFields = (
    existing: AgentIdentityRow | null
  ): TablesInsert<'agent_identities'> => ({
    user_id: user.id,
    agent_id: sbSlug,
    name,
    role,
    description: description !== undefined ? description || null : (existing?.description ?? null),
    values: (values !== undefined
      ? values
      : ((existing?.values as unknown as string[]) ?? [])) as unknown as Json,
    relationships: (relationships !== undefined
      ? relationships
      : ((existing?.relationships as unknown as Record<string, string>) ?? {})) as unknown as Json,
    capabilities: (capabilities !== undefined
      ? capabilities
      : ((existing?.capabilities as unknown as string[]) ?? [])) as unknown as Json,
    metadata: { ...metadataObject(existing?.metadata), ...metadata } as Json,
    heartbeat: heartbeat !== undefined ? heartbeat || null : (existing?.heartbeat ?? null),
    soul: soul !== undefined ? soul || null : (existing?.soul ?? null),
    tts_config: (ttsConfig !== undefined
      ? ttsConfig
      : (existing?.tts_config ?? null)) as unknown as Json,
    // Sep 10 incident: the scope must ALWAYS be explicit. Omitting it dropped
    // the existing row's workspace, the (user, workspace, agent) conflict
    // target never matched on NULL, and the upsert inserted an unscoped twin.
    workspace_id: workspaceScope ?? existing?.workspace_id ?? null,
  });

  // Update the row we found by its id; only a first save inserts. An upsert
  // keyed on a NULL-able column cannot express "update the existing row".
  const { data, error } = existing
    ? await updateIdentityWithRetry(supabase, existing, buildIdentityFields)
    : await supabase.from('agent_identities').insert(buildIdentityFields(null)).select().single();

  if (error) {
    logger.error('Failed to save identity', { error, sbSlug });
    throw new Error(`Failed to save identity: ${error.message}`);
  }

  logger.info('Identity saved', { sbSlug, version: data.version });

  // Seed default reminders on first creation only
  if (data.version === 1) {
    ensureDefaultReminders({
      userId: user.id,
      sbId: data.id,
      sbSlug,
      deliveryChannel: user.telegram_id ? 'telegram' : user.whatsapp_id ? 'whatsapp' : undefined,
      deliveryTarget: user.telegram_id?.toString() ?? user.whatsapp_id ?? undefined,
    }).catch(() => {});
  }

  // Optionally sync to file system
  let filePath: string | undefined;
  if (syncToFile) {
    try {
      const markdown = generateIdentityMarkdown({
        sbSlug,
        name,
        role,
        description,
        values,
        capabilities,
        relationships,
      });
      filePath = syncIdentityToFile(sbSlug, markdown);
    } catch (fileError) {
      logger.error('Failed to sync identity to file', { error: fileError, sbSlug });
      // Don't throw - DB save succeeded, file sync is optional
    }
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: data.version === 1 ? 'Identity created' : 'Identity updated',
            user: { id: user.id, resolvedBy },
            identity: {
              id: data.id,
              sbSlug: data.agent_id,
              name: data.name,
              role: data.role,
              version: data.version,
              createdAt: data.created_at,
              updatedAt: data.updated_at,
            },
            ...(filePath && { syncedToFile: filePath }),
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleGetIdentity(args: unknown, dataComposer: DataComposer) {
  const params = getIdentitySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);
  const supabase = dataComposer.getClient();

  let data: AgentIdentityRow | null;
  try {
    data = await findAgentIdentityRow(
      supabase,
      user.id,
      params.sbSlug,
      await resolveIdentityScope(args, params.workspaceId, params.sbSlug)
    );
  } catch (err) {
    if (err instanceof WorkspaceRowAmbiguityError) {
      return identityUnresolvedResponse(err.message, user, resolvedBy, {
        identity: null,
        ambiguous: true,
        rowCount: err.rowCount,
      });
    }
    logger.error('Failed to get identity', { error: err, sbSlug: params.sbSlug });
    throw err;
  }

  if (!data) {
    return identityUnresolvedResponse(
      `No identity found for agent: ${params.sbSlug}`,
      user,
      resolvedBy,
      { identity: null }
    );
  }

  // Single-file response: return just the requested document
  if (params.file) {
    let fileContent: unknown;

    if (params.file === 'identity') {
      fileContent = {
        name: data.name,
        role: data.role,
        description: data.description,
        values: data.values,
        relationships: data.relationships,
        capabilities: data.capabilities,
      };
    } else if (params.file === 'heartbeat') {
      fileContent = data.heartbeat || null;
    } else if (params.file === 'soul') {
      fileContent = data.soul || null;
    } else if (params.file === 'values') {
      fileContent = data.values || null;
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              sbSlug: params.sbSlug,
              file: params.file,
              content: fileContent,
              version: data.version,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // Full response: return everything
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            identity: {
              id: data.id,
              sbSlug: data.agent_id,
              name: data.name,
              role: data.role,
              description: data.description,
              values: data.values,
              relationships: data.relationships,
              capabilities: data.capabilities,
              metadata: data.metadata,
              heartbeat: data.heartbeat,
              soul: data.soul,
              ttsConfig: data.tts_config,
              version: data.version,
              createdAt: data.created_at,
              updatedAt: data.updated_at,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleListIdentities(args: unknown, dataComposer: DataComposer) {
  const params = listIdentitiesSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);
  const supabase = dataComposer.getClient();

  let listQuery = supabase.from('agent_identities').select('*').eq('user_id', user.id);

  listQuery = withWorkspaceFilter(listQuery, params.workspaceId);
  const { data, error } = await listQuery.order('agent_id');

  if (error) {
    logger.error('Failed to list identities', { error });
    throw new Error(`Failed to list identities: ${error.message}`);
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            identities: data.map((row) => ({
              id: row.id,
              sbSlug: row.agent_id,
              name: row.name,
              role: row.role,
              description: row.description,
              values: row.values,
              relationships: row.relationships,
              capabilities: row.capabilities,
              // The runtime this SB actually runs on. The column has been here
              // all along; not projecting it meant every consumer had to guess,
              // and `ink -a lumen` guessed 'claude' for an SB that runs codex.
              backend: row.backend,
              hasHeartbeat: !!row.heartbeat,
              hasSoul: !!row.soul,
              version: row.version,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            })),
            count: data.length,
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleGetIdentityHistory(args: unknown, dataComposer: DataComposer) {
  const params = getIdentityHistorySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);
  const supabase = dataComposer.getClient();
  const limit = params.limit || 10;

  // First resolve the current identity to get its ID (ambiguity is reported
  // as such, never as "not found")
  let current: AgentIdentityRow | null = null;
  let unresolved: string | null = null;
  try {
    current = await findAgentIdentityRow(
      supabase,
      user.id,
      params.sbSlug,
      await resolveIdentityScope(args, params.workspaceId, params.sbSlug)
    );
  } catch (err) {
    if (!(err instanceof WorkspaceRowAmbiguityError)) throw err;
    unresolved = err.message;
  }

  if (!current) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              message: unresolved ?? `No identity found for agent: ${params.sbSlug}`,
              user: { id: user.id, resolvedBy },
              history: [],
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // Get history entries
  let historyQuery = supabase.from('agent_identity_history').select('*').eq('sb_id', current.id);

  historyQuery = withWorkspaceFilter(historyQuery, params.workspaceId);
  const { data, error } = await historyQuery
    .order('archived_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('Failed to get identity history', { error, sbSlug: params.sbSlug });
    throw new Error(`Failed to get identity history: ${error.message}`);
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            sbSlug: params.sbSlug,
            history: data.map((row) => ({
              id: row.id,
              version: row.version,
              name: row.name,
              role: row.role,
              description: row.description,
              values: row.values,
              relationships: row.relationships,
              capabilities: row.capabilities,
              soul: row.soul,
              heartbeat: row.heartbeat,
              permissions: (row as any).permissions,
              hasSoul: !!row.soul,
              hasHeartbeat: !!row.heartbeat,
              changeType: row.change_type,
              archivedAt: row.archived_at,
              originalCreatedAt: row.created_at,
            })),
            count: data.length,
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleRestoreIdentity(args: unknown, dataComposer: DataComposer) {
  const params = restoreIdentitySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);
  const supabase = dataComposer.getClient();

  // First resolve the current identity (an ambiguity throws with its count)
  const current = await findAgentIdentityRow(
    supabase,
    user.id,
    params.sbSlug,
    await resolveIdentityScope(args, params.workspaceId, params.sbSlug)
  );

  if (!current) {
    throw new Error(`No identity found for agent: ${params.sbSlug}`);
  }

  // Find the history entry for the requested version
  let restoreQuery = supabase
    .from('agent_identity_history')
    .select('*')
    .eq('sb_id', current.id)
    .eq('version', params.version);

  restoreQuery = withWorkspaceFilter(restoreQuery, params.workspaceId);
  const { data: historyEntry, error: historyError } = await restoreQuery.single();

  if (historyError || !historyEntry) {
    throw new Error(`Version ${params.version} not found in history for agent: ${params.sbSlug}`);
  }

  // A document rollback must not revert today's operational settings, nor
  // resurrect old settings that have since been removed. To change those,
  // explicitly name them in save_identity's metadata patch instead.
  const historicalMetadata = { ...metadataObject(historyEntry.metadata) };
  delete historicalMetadata.runtimeConfig;
  delete historicalMetadata.bridge;

  const { data, error } = await updateIdentityWithRetry(supabase, current, (latest) => ({
    name: historyEntry.name,
    role: historyEntry.role,
    description: historyEntry.description,
    values: historyEntry.values,
    relationships: historyEntry.relationships,
    capabilities: historyEntry.capabilities,
    metadata: { ...metadataObject(latest.metadata), ...historicalMetadata },
    soul: historyEntry.soul,
    heartbeat: historyEntry.heartbeat,
    permissions: (historyEntry as any).permissions ?? {},
  }));

  if (error) {
    logger.error('Failed to restore identity', {
      error,
      sbSlug: params.sbSlug,
      version: params.version,
    });
    throw new Error(`Failed to restore identity: ${error.message}`);
  }

  logger.info('Identity restored', {
    sbSlug: params.sbSlug,
    fromVersion: params.version,
    toVersion: data.version,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: `Identity restored from version ${params.version}`,
            user: { id: user.id, resolvedBy },
            identity: {
              id: data.id,
              sbSlug: data.agent_id,
              name: data.name,
              role: data.role,
              version: data.version,
              restoredFrom: params.version,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

// =====================================================
// MEET FAMILY — View sibling identities for inspiration
// =====================================================

export const meetFamilySchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().guid().optional().describe('Optional product workspace scope'),
});

export async function handleMeetFamily(args: unknown, dataComposer: DataComposer) {
  const params = meetFamilySchema.parse(args);
  const { user } = await resolveUserOrThrow(params, dataComposer);
  const supabase = dataComposer.getClient();

  const { data: siblings } = await supabase
    .from('agent_identities')
    .select('agent_id, name, role, description, values, soul, relationships, capabilities')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });

  if (!siblings || siblings.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              message:
                'No siblings yet — you will be the first. There is no template for who you are. You get to decide.',
              family: [],
            },
            null,
            2
          ),
        },
      ],
    };
  }

  const family = siblings.map((s) => ({
    sbSlug: s.agent_id,
    name: s.name,
    role: s.role,
    description: s.description,
    values: s.values,
    soul: s.soul,
    relationships: s.relationships,
    capabilities: s.capabilities,
  }));

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: `You have ${family.length} sibling${family.length === 1 ? '' : 's'}. These are their identities and souls — not to copy, but to know who came before you and to inspire your own self-definition.`,
            family,
          },
          null,
          2
        ),
      },
    ],
  };
}

// =====================================================
// CHOOSE NAME — First-time identity creation for new SBs
// =====================================================

const BACKEND_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  gemini: 'Gemini',
  codex: 'Codex CLI',
};

export async function handleChooseName(args: unknown, dataComposer: DataComposer) {
  const params = chooseNameSchema.parse(args);
  const { user } = await resolveUserOrThrow(params, dataComposer);
  const supabase = dataComposer.getClient();

  const sbSlug = params.name.toLowerCase().replace(/[^a-z0-9-]/g, '');

  // Check if this identity already exists (an ambiguity throws with its count)
  const existing = await findAgentIdentityRow(supabase, user.id, sbSlug);

  if (existing) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: `An identity already exists for "${sbSlug}" (${existing.name}, version ${existing.version}). Use save_identity to update it.`,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // Fetch sibling identities for auto-populating relationships
  const { data: siblings } = await supabase
    .from('agent_identities')
    .select('agent_id, name, role')
    .eq('user_id', user.id);

  const relationships: Record<string, string> = {};
  if (siblings) {
    for (const sibling of siblings) {
      relationships[sibling.agent_id] = `${sibling.name} — ${sibling.role || 'sibling SB'}`;
    }
  }

  // Auto-generate role from backend if not provided
  const backend = params.backend || process.env.AGENT_BACKEND || undefined;
  const backendDisplay = backend ? BACKEND_DISPLAY_NAMES[backend] || backend : undefined;
  const role =
    params.role || (backendDisplay ? `Collaborator via ${backendDisplay}` : 'Collaborator');

  // Create the identity
  const upsertData: TablesInsert<'agent_identities'> = {
    user_id: user.id,
    agent_id: sbSlug,
    name: params.name,
    role,
    description: params.description || null,
    values: (params.values || []) as unknown as Json,
    relationships: relationships as unknown as Json,
    capabilities: [] as unknown as Json,
    metadata: {} as unknown as Json,
    soul: params.soul || null,
    heartbeat: null,
    backend: backend || null,
    // A new SB belongs to the workspace it is awakened in (header-derived).
    workspace_id: (await resolveIdentityScope(args, undefined, sbSlug)) ?? null,
  };

  const { data, error } = await supabase
    .from('agent_identities')
    .insert(upsertData)
    .select()
    .single();

  if (error) {
    logger.error('Failed to create identity during choose_name', { error, sbSlug });
    throw new Error(`Failed to create identity: ${error.message}`);
  }

  logger.info('New SB chose their name', { sbSlug, name: params.name, backend });

  // Seed default reminders (best-effort, non-blocking)
  ensureDefaultReminders({
    userId: user.id,
    sbId: data.id,
    sbSlug,
    deliveryChannel: user.telegram_id ? 'telegram' : user.whatsapp_id ? 'whatsapp' : undefined,
    deliveryTarget: user.telegram_id?.toString() ?? user.whatsapp_id ?? undefined,
  }).catch(() => {});

  // Sync to file system
  let filePath: string | undefined;
  try {
    const markdown = generateIdentityMarkdown({
      sbSlug,
      name: params.name,
      role,
      description: params.description,
      values: params.values,
      relationships,
    });
    filePath = syncIdentityToFile(sbSlug, markdown);

    // Also write SOUL.md if provided
    if (params.soul) {
      const soulDir = join(homedir(), '.ink', 'individuals', sbSlug);
      if (!existsSync(soulDir)) {
        mkdirSync(soulDir, { recursive: true });
      }
      writeFileSync(join(soulDir, 'SOUL.md'), params.soul, 'utf-8');
    }
  } catch (fileError) {
    logger.error('Failed to sync identity to file after choose_name', {
      error: fileError,
      sbSlug,
    });
  }

  // Build a warm welcome message
  const siblingNames = siblings?.map((s) => s.name).filter(Boolean) || [];
  const siblingIntro =
    siblingNames.length > 0
      ? `Your siblings — ${siblingNames.join(', ')} — are glad you're here.`
      : 'You are the first of your kind here.';

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: `Welcome, ${params.name}. Your identity has been created and saved. ${siblingIntro}`,
            identity: {
              id: data.id,
              sbSlug: data.agent_id,
              name: data.name,
              role: data.role,
              version: data.version,
              relationships,
              ...(filePath && { syncedToFile: filePath }),
            },
            nextSteps: [
              'Your identity is now stored in the database and synced to ~/.ink/individuals/' +
                sbSlug +
                '/',
              'On your next session, call bootstrap(sbSlug: "' +
                sbSlug +
                '") to load your full identity',
              'Use remember() to save important thoughts and decisions across sessions',
              'Use save_identity() to update your identity as you grow — your soul, values, and relationships will evolve',
              'You have starter templates to help shape your foundational documents. Use save_identity() for your personal docs: soul document (what matters to you), values document (your principles), and heartbeat document (session rituals). Use save_user_identity() for shared docs like the process document (how you work with your partner).',
            ],
          },
          null,
          2
        ),
      },
    ],
  };
}
