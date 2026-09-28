/**
 * Default Claude Code permissions for a studio worktree.
 *
 * One list, owned here so that the CLI (`ink init`, which writes them) and
 * the server (`applyPermissionOverlay`, which layers session grants on top)
 * read the same rules. Until task c3b34be8 the server generated them and
 * the CLI never did, which was one of the ways a CLI-created studio came up
 * partial.
 */

/**
 * Deny rules — destructive commands that always require confirmation, even
 * in a fully auto-approved studio.
 */
export const DEFAULT_CLAUDE_DENY_RULES: readonly string[] = [
  'Bash(rm -rf *)',
  'Bash(git push --force *)',
  'Bash(git push -f *)',
  'Bash(git reset --hard *)',
  'Bash(git clean -fd *)',
  'Bash(git clean -f *)',
  'Bash(git checkout -- .)',
];

/**
 * Allow rules — broad permissions for automated development work. Each MCP
 * server is listed explicitly because Claude Code does not support
 * cross-server wildcards like `mcp__*`; only server-scoped patterns
 * (`mcp__inkwell__*`) are matched by the permission engine.
 */
export const DEFAULT_CLAUDE_ALLOW_RULES: readonly string[] = [
  'Bash(*)',
  'Edit(*)',
  'Write(*)',
  'Read(*)',
  'WebFetch(*)',
  'WebSearch',
  'mcp__inkwell__*',
  'mcp__supabase__*',
  'mcp__github__*',
  'mcp__playwright__*',
];
