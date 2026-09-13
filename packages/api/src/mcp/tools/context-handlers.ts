import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';
import { userIdentifierBaseSchema, resolveUserOrThrow } from '../../services/user-resolver';
import { assertWriteRole, resolveCallerWorkspace } from './caller-principal';

// =====================================================
// PROJECT TOOLS
// =====================================================

export const saveProjectSchema = userIdentifierBaseSchema.extend({
  name: z.string().describe('Project name (unique per user)'),
  description: z.string().optional().describe('Project description'),
  status: z.enum(['active', 'paused', 'completed', 'archived']).optional(),
  techStack: z.array(z.string()).optional().describe('Technologies used'),
  repositoryUrl: z.string().url().optional().describe('Repository URL'),
  repoRoot: z
    .string()
    .optional()
    .describe('Local filesystem path to the repo root (e.g., /Users/.../my-project)'),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits, and hyphens only')
    .max(32)
    .nullable()
    .optional()
    .describe(
      'Thread-key project prefix (e.g., "inkread" in inkread:pr:42). Reserved against thread-key type names. Pass null to clear.'
    ),
  goals: z.array(z.string()).optional().describe('Project goals/milestones'),
});

export const listProjectsSchema = userIdentifierBaseSchema.extend({
  status: z.enum(['active', 'paused', 'completed', 'archived']).optional(),
});

export const getProjectSchema = userIdentifierBaseSchema.extend({
  name: z.string().optional().describe('Project name'),
  projectId: z.string().guid().optional().describe('Project UUID'),
});

export async function handleSaveProject(args: unknown, dataComposer: DataComposer) {
  const params = saveProjectSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(params, dataComposer);

  // A project lives in a workspace (spec inkmail-thread-scope §1b): the
  // caller's SB workspace when an SB is calling, else the person's personal
  // workspace. Server-resolved, never a caller-claimed value.
  const { workspaceId, role } = await resolveCallerWorkspace(dataComposer.getClient(), user.id);
  assertWriteRole(role, 'save a project');

  // Reserved-name rule (thread-key-grammar v2): a project slug must not
  // collide with a registered thread-key TYPE — template or this
  // workspace's override. That collision is the grammar's one structural
  // ambiguity ("is pr:... segment 1 a project or a type?"), killed at
  // write time.
  if (params.slug) {
    const { data: typeRows, error: typeErr } = await dataComposer
      .getClient()
      .from('thread_key_types')
      .select('type, workspace_id')
      .eq('type', params.slug)
      .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`);
    if (typeErr) {
      // Fail closed: cannot prove no collision -> refuse, never guess.
      throw new Error(`Could not verify slug against thread-key types: ${typeErr.message}`);
    }
    if ((typeRows || []).length > 0) {
      throw new Error(
        `Project slug "${params.slug}" collides with the thread-key type "${params.slug}". ` +
          'Type names are reserved against project slugs (thread-key-grammar v2).'
      );
    }
  }

  const project = await dataComposer.repositories.projects.upsertByName({
    user_id: user.id,
    workspace_id: workspaceId,
    name: params.name,
    description: params.description,
    status: params.status,
    tech_stack: params.techStack,
    repository_url: params.repositoryUrl,
    repo_root: params.repoRoot,
    slug: params.slug,
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
              slug: project.slug ?? null,
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

  // Reads follow the same namespace as writes (spec inkmail-thread-scope
  // §1b): the caller's workspace, whoever created each project. Scoped by
  // owner, a member could update a colleague's project and then not list
  // it (Lumen, #622).
  const { workspaceId } = await resolveCallerWorkspace(dataComposer.getClient(), user.id);
  const projects = await dataComposer.repositories.projects.findAllByWorkspace(
    workspaceId,
    params.status
  );

  logger.info(`Listed ${projects.length} projects in workspace ${workspaceId} for user ${user.id}`);

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
              slug: p.slug ?? null,
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

  // A project is readable by its workspace's members, not only its creator.
  const { workspaceId } = await resolveCallerWorkspace(dataComposer.getClient(), user.id);
  let project;
  if (params.projectId) {
    project = await dataComposer.repositories.projects.findById(params.projectId);
    if (project && project.workspace_id !== workspaceId) {
      project = null;
    }
  } else if (params.name) {
    project = await dataComposer.repositories.projects.findByWorkspaceAndName(
      workspaceId,
      params.name
    );
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
              slug: project.slug ?? null,
              description: project.description,
              status: project.status,
              tech_stack: project.tech_stack,
              repository_url: project.repository_url,
              repo_root: project.repo_root,
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
  projectId: z.string().guid().optional().describe('UUID of the project to focus on'),
  focusSummary: z.string().optional().describe('What we are currently working on'),
  contextSnapshot: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Snapshot of relevant context'),
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
    const { workspaceId } = await resolveCallerWorkspace(dataComposer.getClient(), user.id);
    const project = await dataComposer.repositories.projects.findByWorkspaceAndName(
      workspaceId,
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
