/**
 * What a clone may do without asking.
 *
 * Read-oriented, matching the actual use case: go look at things and report
 * back. Anything absent from this list is not silently permitted — it is blocked
 * by the allowlist and escalates to the parent's approval coordinator, labelled
 * with the clone that asked.
 *
 * `DEFAULT_SAFE_INK_TOOLS` bypass allowlist narrowing inside `ToolPolicyState`,
 * so the clone's effective read surface is this list UNION that one. Every
 * member of both is read-only, and a parent denial still overrides either.
 */
export const CLONE_BASELINE_TOOLS: readonly string[] = [
  // Pi coding tools — the read half only.
  'read',
  'grep',
  'find',
  'ls',
  // Asking what it can call. A clone that must escalate for this learns its
  // surface by being refused, which is the failure mode this whole area exists
  // to remove — and unattended, a promptable tool is denied outright.
  'describe_tool',
  // Inkwell introspection. Reading the workspace is the point of a clone.
  'bootstrap',
  'recall',
  'get_artifact',
  'list_artifacts',
  'search_artifacts',
  'get_artifact_history',
  'list_artifact_comments',
  'list_tasks',
  'get_task_stats',
  'list_task_groups',
  'list_task_group_comments',
  'list_projects',
  'get_project',
  'get_session',
  'list_sessions',
  'get_session_context',
  'get_activity',
  'get_activity_summary',
  'get_conversation_history',
  'search_links',
  'list_skills',
  'get_skill',
  'list_studios',
  'get_studio',
  'list_identities',
  'get_identity',
  'get_team_constitution',
  'get_user_identity',
  'get_memory_history',
  'get_timezone',
  'get_agent_status',
  'get_agent_summaries',
  'list_workspaces',
  'get_workspace',
];

/**
 * What a clone may NOT do, whatever the parent's policy says.
 *
 * Redundant against the allowlist by construction, and deliberately so: deny
 * beats allow at every scope, so these stay refused even if the baseline is
 * later widened by accident. Each group answers a specific way a clone could do
 * damage the parent would never see.
 */
export const CLONE_DENIED_TOOLS: readonly string[] = [
  // A clone's ledger is a throwaway; there is no provider session of its own
  // to re-seed from a summary. The handler refuses it too — the prompt just
  // does not offer it.
  'compact_context',
  // Memory belongs to the original. Clones hand work back; the parent decides
  // what was worth remembering. Spec decision #5 — enforced, not conventional.
  'remember',
  'forget',
  'update_memory',
  'restore_memory',
  'save_project',
  'save_identity',
  'save_user_identity',
  'save_team_constitution',
  // Speaking to third parties as the parent, from a context the user never saw.
  'send_to_inbox',
  'send_response',
  'send_email',
  'draft_email',
  'reply_to_email',
  'modify_emails',
  'trigger_agent',
  'log_message',
  'create_reminder',
  'update_reminder',
  'cancel_reminder',
  // Session and studio lifecycle — the parent owns its own runtime.
  'start_session',
  'end_session',
  'update_session_state',
  'compact_session',
  'clear_chat_context',
  'create_studio',
  'update_studio',
  'close_studio',
  'adopt_studio',
  'register_studio',
  // Filesystem and shell writes.
  'write',
  'edit',
  'bash',
  // A clone's turns never carry an image block, so what it viewed would reach
  // it only as a note that the image was not shown. Refused here rather than
  // run and then withheld.
  'view_image',
  // Authority over authority.
  'set_permission',
  'reset_permission',
  // No nesting. Also enforced at the executor, because a text-protocol model can
  // emit any tool name it likes regardless of what its prompt listed.
  'spawn_agent',
];

/**
 * True when this tool must never run inside a clone, whatever policy says.
 *
 * The executor consults this directly rather than trusting the clone's policy
 * alone: `spawn_agent` fans out authority and costs backend time, and omitting
 * it from the clone's prompt is not enforcement — the model emits tool calls as
 * text and can name anything.
 */
export function isForbiddenInClone(tool: string): boolean {
  return CLONE_DENIED_TOOLS.includes(tool.replace(/^mcp__inkwell__/, ''));
}
