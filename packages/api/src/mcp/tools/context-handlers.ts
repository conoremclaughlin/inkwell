import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';
import { userIdentifierBaseSchema, resolveUserOrThrow } from '../../services/user-resolver';
import type { ContextType } from '../../data/repositories/context.repository';

// Context type enum for validation
const contextTypeSchema = z.enum(['user', 'assistant', 'project', 'session', 'relationship']);

// =====================================================
// CONTEXT TOOLS
// =====================================================

export const saveContextSchema = userIdentifierBaseSchema.extend({
  contextType: contextTypeSchema,
  contextKey: z.string().optional().describe('Optional key for sub-context (e.g., project name)'),
  summary: z.string().describe('The summarized context to save'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
});

export const getContextSchema = userIdentifierBaseSchema.extend({
  contextType: contextTypeSchema.optional().describe('Filter by context type'),
  contextKey: z.string().optional().describe('Filter by context key'),
});

export async function handleSaveContext(args: unknown, dataComposer: DataComposer) {
  const params = saveContextSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const context = await dataComposer.repositories.context.upsert({
    user_id: user.id,
    context_type: params.contextType as ContextType,
    context_key: params.contextKey || null,
    summary: params.summary,
    metadata: params.metadata || {},
  });

  logger.info(
    `Context saved: ${context.context_type}/${context.context_key || 'default'} for user ${user.id}`
  );

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: 'Context saved successfully',
            user: { id: user.id, resolvedBy },
            context: {
              id: context.id,
              type: context.context_type,
              key: context.context_key,
              version: context.version,
              updated_at: context.updated_at,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleGetContext(args: unknown, dataComposer: DataComposer) {
  const params = getContextSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  let contexts;
  if (params.contextType && params.contextKey !== undefined) {
    // Get specific context
    const context = await dataComposer.repositories.context.findByUserAndType(
      user.id,
      params.contextType as ContextType,
      params.contextKey || null
    );
    contexts = context ? [context] : [];
  } else if (params.contextType) {
    // Get all contexts of a type
    contexts = await dataComposer.repositories.context.findByType(
      user.id,
      params.contextType as ContextType
    );
  } else {
    // Get all contexts
    contexts = await dataComposer.repositories.context.findAllByUser(user.id);
  }

  logger.info(`Retrieved ${contexts.length} context(s) for user ${user.id}`);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            count: contexts.length,
            contexts: contexts.map((c) => ({
              id: c.id,
              type: c.context_type,
              key: c.context_key,
              summary: c.summary,
              version: c.version,
              metadata: c.metadata,
              updated_at: c.updated_at,
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}

// =====================================================
// PROJECT TOOLS
// =====================================================

export const saveProjectSchema = userIdentifierBaseSchema.extend({
  name: z.string().describe('Project name (unique per user)'),
  description: z.string().optional().describe('Project description'),
  status: z.enum(['active', 'paused', 'completed', 'archived']).optional(),
  techStack: z.array(z.string()).optional().describe('Technologies used'),
  repositoryUrl: z.string().url().optional().describe('Repository URL'),
  goals: z.array(z.string()).optional().describe('Project goals/milestones'),
});

export const listProjectsSchema = userIdentifierBaseSchema.extend({
  status: z.enum(['active', 'paused', 'completed', 'archived']).optional(),
});

export const getProjectSchema = userIdentifierBaseSchema.extend({
  name: z.string().optional().describe('Project name'),
  projectId: z.string().uuid().optional().describe('Project UUID'),
});

export async function handleSaveProject(args: unknown, dataComposer: DataComposer) {
  const params = saveProjectSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const project = await dataComposer.repositories.projects.upsertByName({
    user_id: user.id,
    name: params.name,
    description: params.description,
    status: params.status,
    tech_stack: params.techStack,
    repository_url: params.repositoryUrl,
    goals: params.goals,
  });

  logger.info(`Project saved: ${project.name} for user ${user.id}`);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: 'Project saved successfully',
            user: { id: user.id, resolvedBy },
            project: {
              id: project.id,
              name: project.name,
              description: project.description,
              status: project.status,
              tech_stack: project.tech_stack,
              goals: project.goals,
              updated_at: project.updated_at,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleListProjects(args: unknown, dataComposer: DataComposer) {
  const params = listProjectsSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  const projects = await dataComposer.repositories.projects.findAllByUser(user.id, params.status);

  logger.info(`Listed ${projects.length} projects for user ${user.id}`);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            count: projects.length,
            projects: projects.map((p) => ({
              id: p.id,
              name: p.name,
              description: p.description,
              status: p.status,
              tech_stack: p.tech_stack,
              goals: p.goals,
              updated_at: p.updated_at,
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleGetProject(args: unknown, dataComposer: DataComposer) {
  const params = getProjectSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  let project;
  if (params.projectId) {
    project = await dataComposer.repositories.projects.findById(params.projectId);
    // Verify ownership
    if (project && project.user_id !== user.id) {
      project = null;
    }
  } else if (params.name) {
    project = await dataComposer.repositories.projects.findByUserAndName(user.id, params.name);
  }

  if (!project) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ success: false, error: 'Project not found' }, null, 2),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            project: {
              id: project.id,
              name: project.name,
              description: project.description,
              status: project.status,
              tech_stack: project.tech_stack,
              repository_url: project.repository_url,
              goals: project.goals,
              metadata: project.metadata,
              created_at: project.created_at,
              updated_at: project.updated_at,
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
// SESSION FOCUS TOOLS
// =====================================================

export const setFocusSchema = userIdentifierBaseSchema.extend({
  sessionId: z.string().optional().describe('Claude Code or channel session ID'),
  projectName: z.string().optional().describe('Name of the project to focus on'),
  projectId: z.string().uuid().optional().describe('UUID of the project to focus on'),
  focusSummary: z.string().optional().describe('What we are currently working on'),
  contextSnapshot: z.record(z.unknown()).optional().describe('Snapshot of relevant context'),
});

export const getFocusSchema = userIdentifierBaseSchema.extend({
  sessionId: z.string().optional().describe('Specific session ID to get focus for'),
});

export async function handleSetFocus(args: unknown, dataComposer: DataComposer) {
  const params = setFocusSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  // Resolve project if name provided
  let projectId = params.projectId;
  if (params.projectName && !projectId) {
    const project = await dataComposer.repositories.projects.findByUserAndName(
      user.id,
      params.projectName
    );
    if (project) {
      projectId = project.id;
    }
  }

  const focus = await dataComposer.repositories.sessionFocus.upsert({
    user_id: user.id,
    session_id: params.sessionId || null,
    project_id: projectId || null,
    focus_summary: params.focusSummary || null,
    context_snapshot: params.contextSnapshot || {},
  });

  logger.info(`Focus set for user ${user.id}, session ${params.sessionId || 'default'}`);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: 'Focus set successfully',
            user: { id: user.id, resolvedBy },
            focus: {
              id: focus.id,
              session_id: focus.session_id,
              project_id: focus.project_id,
              focus_summary: focus.focus_summary,
              updated_at: focus.updated_at,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleGetFocus(args: unknown, dataComposer: DataComposer) {
  const params = getFocusSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  let focus;
  if (params.sessionId) {
    focus = await dataComposer.repositories.sessionFocus.findByUserAndSession(
      user.id,
      params.sessionId
    );
  } else {
    focus = await dataComposer.repositories.sessionFocus.findLatestByUser(user.id);
  }

  // If focus has a project, fetch project details
  let project = null;
  if (focus?.project_id) {
    project = await dataComposer.repositories.projects.findById(focus.project_id);
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            focus: focus
              ? {
                  id: focus.id,
                  session_id: focus.session_id,
                  focus_summary: focus.focus_summary,
                  context_snapshot: focus.context_snapshot,
                  updated_at: focus.updated_at,
                  project: project
                    ? {
                        id: project.id,
                        name: project.name,
                        description: project.description,
                        status: project.status,
                        tech_stack: project.tech_stack,
                      }
                    : null,
                }
              : null,
          },
          null,
          2
        ),
      },
    ],
  };
}
