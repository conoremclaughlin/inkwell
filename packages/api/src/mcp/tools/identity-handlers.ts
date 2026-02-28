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
import type { Json, TablesInsert } from '../../data/supabase/types';
import { logger } from '../../utils/logger';
import { getEffectiveAgentId } from '../../auth/enforce-identity';
import { userIdentifierBaseSchema, resolveUserOrThrow } from '../../services/user-resolver';
import { ensureDefaultReminders } from '../../services/heartbeat';

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
  workspaceId: z.string().uuid().optional().describe('Optional product workspace scope'),
  agentId: z
    .string()
    .describe('Unique identifier for the AI being (e.g., "wren", "benson", "myra")'),
  name: z.string().describe('Display name for the agent'),
  role: z.string().describe('Role description (e.g., "Development collaborator via Claude Code")'),
  description: z.string().optional().describe("Extended description of the agent's nature"),
  values: z.array(z.string()).optional().describe('Core values this agent holds'),
  relationships: z
    .record(z.string())
    .optional()
    .describe('Map of agentId to relationship description'),
  capabilities: z.array(z.string()).optional().describe('What this agent can do'),
  metadata: z.record(z.unknown()).optional().describe('Additional flexible data'),
  heartbeat: z.string().optional().describe('HEARTBEAT.md content - operational wake-up checklist'),
  soul: z
    .string()
    .optional()
    .describe('Soul document content - core essence and philosophical grounding'),
  syncToFile: z
    .boolean()
    .optional()
    .describe('Also write to ~/.pcp/individuals/{agentId}/IDENTITY.md'),
});

export const getIdentitySchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().uuid().optional().describe('Optional product workspace scope'),
  agentId: z.string().describe('Agent identifier to look up'),
  file: z
    .enum(['heartbeat', 'soul', 'values', 'identity'])
    .optional()
    .describe('Fetch a single identity document to minimize token usage. Omit to get everything.'),
});

export const listIdentitiesSchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().uuid().optional().describe('Optional product workspace scope'),
});

export const getIdentityHistorySchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().uuid().optional().describe('Optional product workspace scope'),
  agentId: z.string().describe('Agent identifier to get history for'),
  limit: z.number().min(1).max(50).optional().describe('Max history entries (default: 10)'),
});

export const restoreIdentitySchema = userIdentifierBaseSchema.extend({
  workspaceId: z.string().uuid().optional().describe('Optional product workspace scope'),
  agentId: z.string().describe('Agent identifier to restore'),
  version: z.number().describe('Version number to restore to'),
});

// =====================================================
// HELPERS
// =====================================================

/**
 * Generate IDENTITY.md content from identity data
 */
function generateIdentityMarkdown(identity: {
  agentId: string;
  name: string;
  role: string;
  description?: string | null;
  values?: string[] | null;
  capabilities?: string[] | null;
  relationships?: Record<string, string> | null;
}): string {
  const lines: string[] = [];
  const now = new Date().toISOString().split('T')[0];

  lines.push(`# IDENTITY.md - ${identity.name}`);
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

function withWorkspaceFilter<T>(query: T, workspaceId?: string): T {
  if (!workspaceId) return query;
  return (query as { eq: (column: string, value: string) => T }).eq('workspace_id', workspaceId);
}

/**
 * Write identity to file system
 */
function syncIdentityToFile(agentId: string, content: string): string {
  const pcpDir = join(homedir(), '.pcp', 'individuals', agentId);
  const filePath = join(pcpDir, 'IDENTITY.md');

  // Ensure directory exists
  if (!existsSync(pcpDir)) {
    mkdirSync(pcpDir, { recursive: true });
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
    syncToFile,
    workspaceId,
  } = params;
  // Enforce identity: pinned agents can only modify their own identity
  const agentId = getEffectiveAgentId(params.agentId) ?? params.agentId;

  // Fetch existing record so omitted optional fields are preserved
  const { data: existing } = await withWorkspaceFilter(
    supabase.from('agent_identities').select('*').eq('user_id', user.id).eq('agent_id', agentId),
    workspaceId
  ).single();

  // Build upsert object, preserving existing values for omitted fields
  const upsertData: TablesInsert<'agent_identities'> = {
    user_id: user.id,
    agent_id: agentId,
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
    metadata: (metadata !== undefined
      ? metadata
      : ((existing?.metadata as unknown as Record<string, unknown>) ?? {})) as unknown as Json,
    heartbeat: heartbeat !== undefined ? heartbeat || null : (existing?.heartbeat ?? null),
    soul: soul !== undefined ? soul || null : (existing?.soul ?? null),
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
  };

  // Use upsert to handle both create and update
  const { data, error } = await supabase
    .from('agent_identities')
    .upsert(upsertData, {
      onConflict: 'user_id,workspace_id,agent_id',
    })
    .select()
    .single();

  if (error) {
    logger.error('Failed to save identity', { error, agentId });
    throw new Error(`Failed to save identity: ${error.message}`);
  }

  logger.info('Identity saved', { agentId, version: data.version });

  // Seed default reminders on first creation only
  if (data.version === 1) {
    ensureDefaultReminders({
      userId: user.id,
      identityId: data.id,
      agentId,
      deliveryChannel: user.telegram_id ? 'telegram' : user.whatsapp_id ? 'whatsapp' : undefined,
      deliveryTarget: user.telegram_id?.toString() ?? user.whatsapp_id ?? undefined,
    }).catch(() => {});
  }

  // Optionally sync to file system
  let filePath: string | undefined;
  if (syncToFile) {
    try {
      const markdown = generateIdentityMarkdown({
        agentId,
        name,
        role,
        description,
        values,
        capabilities,
        relationships,
      });
      filePath = syncIdentityToFile(agentId, markdown);
    } catch (fileError) {
      logger.error('Failed to sync identity to file', { error: fileError, agentId });
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
              agentId: data.agent_id,
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

  let identityQuery = supabase
    .from('agent_identities')
    .select('*')
    .eq('user_id', user.id)
    .eq('agent_id', params.agentId);

  identityQuery = withWorkspaceFilter(identityQuery, params.workspaceId);
  const { data, error } = await identityQuery.single();

  if (error) {
    if (error.code === 'PGRST116') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: false,
                message: `No identity found for agent: ${params.agentId}`,
                user: { id: user.id, resolvedBy },
                identity: null,
              },
              null,
              2
            ),
          },
        ],
      };
    }
    logger.error('Failed to get identity', { error, agentId: params.agentId });
    throw new Error(`Failed to get identity: ${error.message}`);
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
              agentId: params.agentId,
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
              agentId: data.agent_id,
              name: data.name,
              role: data.role,
              description: data.description,
              values: data.values,
              relationships: data.relationships,
              capabilities: data.capabilities,
              metadata: data.metadata,
              heartbeat: data.heartbeat,
              soul: data.soul,
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
              agentId: row.agent_id,
              name: row.name,
              role: row.role,
              description: row.description,
              values: row.values,
              relationships: row.relationships,
              capabilities: row.capabilities,
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

  // First get the current identity to get its ID
  let currentQuery = supabase
    .from('agent_identities')
    .select('id')
    .eq('user_id', user.id)
    .eq('agent_id', params.agentId);

  currentQuery = withWorkspaceFilter(currentQuery, params.workspaceId);
  const { data: current } = await currentQuery.single();

  if (!current) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              message: `No identity found for agent: ${params.agentId}`,
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
  let historyQuery = supabase
    .from('agent_identity_history')
    .select('*')
    .eq('identity_id', current.id);

  historyQuery = withWorkspaceFilter(historyQuery, params.workspaceId);
  const { data, error } = await historyQuery
    .order('archived_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('Failed to get identity history', { error, agentId: params.agentId });
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
            agentId: params.agentId,
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

  // First get the current identity
  let currentQuery = supabase
    .from('agent_identities')
    .select('id')
    .eq('user_id', user.id)
    .eq('agent_id', params.agentId);

  currentQuery = withWorkspaceFilter(currentQuery, params.workspaceId);
  const { data: current } = await currentQuery.single();

  if (!current) {
    throw new Error(`No identity found for agent: ${params.agentId}`);
  }

  // Find the history entry for the requested version
  let restoreQuery = supabase
    .from('agent_identity_history')
    .select('*')
    .eq('identity_id', current.id)
    .eq('version', params.version);

  restoreQuery = withWorkspaceFilter(restoreQuery, params.workspaceId);
  const { data: historyEntry, error: historyError } = await restoreQuery.single();

  if (historyError || !historyEntry) {
    throw new Error(`Version ${params.version} not found in history for agent: ${params.agentId}`);
  }

  // Restore by updating with the historical values
  const { data, error } = await supabase
    .from('agent_identities')
    .update({
      name: historyEntry.name,
      role: historyEntry.role,
      description: historyEntry.description,
      values: historyEntry.values,
      relationships: historyEntry.relationships,
      capabilities: historyEntry.capabilities,
      metadata: historyEntry.metadata,
      soul: historyEntry.soul,
      heartbeat: historyEntry.heartbeat,
    })
    .eq('id', current.id)
    .select()
    .single();

  if (error) {
    logger.error('Failed to restore identity', {
      error,
      agentId: params.agentId,
      version: params.version,
    });
    throw new Error(`Failed to restore identity: ${error.message}`);
  }

  logger.info('Identity restored', {
    agentId: params.agentId,
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
              agentId: data.agent_id,
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
  workspaceId: z.string().uuid().optional().describe('Optional product workspace scope'),
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
    agentId: s.agent_id,
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

  const agentId = params.name.toLowerCase().replace(/[^a-z0-9-]/g, '');

  // Check if this identity already exists
  const { data: existing } = await supabase
    .from('agent_identities')
    .select('agent_id, name, version')
    .eq('user_id', user.id)
    .eq('agent_id', agentId)
    .single();

  if (existing) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: `An identity already exists for "${agentId}" (${existing.name}, version ${existing.version}). Use save_identity to update it.`,
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
    agent_id: agentId,
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
  };

  const { data, error } = await supabase
    .from('agent_identities')
    .insert(upsertData)
    .select()
    .single();

  if (error) {
    logger.error('Failed to create identity during choose_name', { error, agentId });
    throw new Error(`Failed to create identity: ${error.message}`);
  }

  logger.info('New SB chose their name', { agentId, name: params.name, backend });

  // Seed default reminders (best-effort, non-blocking)
  ensureDefaultReminders({
    userId: user.id,
    identityId: data.id,
    agentId,
    deliveryChannel: user.telegram_id ? 'telegram' : user.whatsapp_id ? 'whatsapp' : undefined,
    deliveryTarget: user.telegram_id?.toString() ?? user.whatsapp_id ?? undefined,
  }).catch(() => {});

  // Sync to file system
  let filePath: string | undefined;
  try {
    const markdown = generateIdentityMarkdown({
      agentId,
      name: params.name,
      role,
      description: params.description,
      values: params.values,
      relationships,
    });
    filePath = syncIdentityToFile(agentId, markdown);

    // Also write SOUL.md if provided
    if (params.soul) {
      const soulDir = join(homedir(), '.pcp', 'individuals', agentId);
      if (!existsSync(soulDir)) {
        mkdirSync(soulDir, { recursive: true });
      }
      writeFileSync(join(soulDir, 'SOUL.md'), params.soul, 'utf-8');
    }
  } catch (fileError) {
    logger.error('Failed to sync identity to file after choose_name', {
      error: fileError,
      agentId,
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
              agentId: data.agent_id,
              name: data.name,
              role: data.role,
              version: data.version,
              relationships,
              ...(filePath && { syncedToFile: filePath }),
            },
            nextSteps: [
              'Your identity is now stored in the database and synced to ~/.pcp/individuals/' +
                agentId +
                '/',
              'On your next session, call bootstrap(agentId: "' +
                agentId +
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
