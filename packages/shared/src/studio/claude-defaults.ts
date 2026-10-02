/**
 * Claude Code permissions: the full-auto defaults, and the profiles a new
 * studio worktree is given.
 *
 * One list per profile, owned here so that the CLI (`ink init` and
 * `ink permissions`, which write them) and the server (which picks a
 * studio's profile from its row) read the same rules. Until task c3b34be8
 * the server generated them and the CLI never did, which was one of the
 * ways a CLI-created studio came up partial.
 *
 * Every Bash deny below is a POLICY BACKSTOP, not enforced isolation. The
 * profiles keep `Bash(*)`, and Claude Code's own documentation says a Bash
 * rule does not match another spelling of the same command (`git -C .
 * push`, `git 'push'`, a script that runs it). These rules stop the common
 * spellings and record what the profile does not pre-approve; they cannot
 * make any action impossible. That boundary is the sandbox, which is
 * separate work. A studio profile is a trusted-developer convenience, not a
 * consumer or hostile-code boundary.
 */

/**
 * Deny rules: destructive commands that always require confirmation, even
 * in a fully auto-approved studio. Backstops (see the module comment).
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
 * Allow rules: the full-auto defaults `ink permissions auto` writes. Broad
 * on purpose, and NOT a studio profile: they approve every GitHub and
 * Supabase tool. Each MCP server is listed explicitly because Claude Code
 * does not support cross-server wildcards like `mcp__*`; only server-scoped
 * patterns (`mcp__inkwell__*`) are matched by the permission engine.
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

// ============================================================================
// MCP tools by name — the studio profiles never use a GitHub or Supabase
// wildcard, so what they approve is readable here.
// ============================================================================

/** GitHub MCP tools that only read: get, list, search. */
export const GITHUB_READ_TOOLS: readonly string[] = [
  'mcp__github__get_commit',
  'mcp__github__get_file_contents',
  'mcp__github__get_label',
  'mcp__github__get_latest_release',
  'mcp__github__get_me',
  'mcp__github__get_release_by_tag',
  'mcp__github__get_tag',
  'mcp__github__get_team_members',
  'mcp__github__get_teams',
  'mcp__github__issue_read',
  'mcp__github__list_branches',
  'mcp__github__list_commits',
  'mcp__github__list_issue_fields',
  'mcp__github__list_issue_types',
  'mcp__github__list_issues',
  'mcp__github__list_pull_requests',
  'mcp__github__list_releases',
  'mcp__github__list_repository_collaborators',
  'mcp__github__list_tags',
  'mcp__github__pull_request_read',
  'mcp__github__search_code',
  'mcp__github__search_commits',
  'mcp__github__search_issues',
  'mcp__github__search_pull_requests',
  'mcp__github__search_repositories',
  'mcp__github__search_users',
];

/**
 * GitHub MCP tools that publish code or change a repository, a branch or a
 * pull request's state: opening, merging, closing or retargeting a PR,
 * writing files or branches directly, creating, forking or deleting a
 * repository. Denied in both studio profiles.
 */
export const GITHUB_PUBLISH_TOOLS: readonly string[] = [
  'mcp__github__create_branch',
  'mcp__github__create_or_update_file',
  'mcp__github__create_pull_request',
  'mcp__github__create_repository',
  'mcp__github__delete_file',
  'mcp__github__delete_repository',
  'mcp__github__fork_repository',
  'mcp__github__merge_pull_request',
  'mcp__github__push_files',
  'mcp__github__update_pull_request',
  'mcp__github__update_pull_request_branch',
];

/**
 * GitHub MCP tools that post a review or a comment. A review is a
 * reviewer's output, and the team posts every review round to GitHub, so
 * the reviewer profile allows these. The builder profile neither allows nor
 * denies them.
 */
export const GITHUB_REVIEW_TOOLS: readonly string[] = [
  'mcp__github__add_comment_to_pending_review',
  'mcp__github__add_issue_comment',
  'mcp__github__add_reply_to_pull_request_comment',
  'mcp__github__pull_request_review_write',
];

/**
 * The remaining GitHub MCP tools that write: issues, issue comments,
 * review requests. Neither profile allows them; the reviewer profile
 * denies them.
 */
export const GITHUB_OTHER_WRITE_TOOLS: readonly string[] = [
  'mcp__github__issue_write',
  'mcp__github__request_copilot_review',
  'mcp__github__sub_issue_write',
  'mcp__github__update_issue_comment',
];

/** Supabase MCP tools that only read. */
export const SUPABASE_READ_TOOLS: readonly string[] = [
  'mcp__supabase__generate_typescript_types',
  'mcp__supabase__get_advisors',
  'mcp__supabase__get_logs',
  'mcp__supabase__get_project_url',
  'mcp__supabase__get_publishable_keys',
  'mcp__supabase__list_extensions',
  'mcp__supabase__list_migrations',
  'mcp__supabase__list_tables',
  'mcp__supabase__search_docs',
];

/** Supabase MCP tools that can write: a migration, or arbitrary SQL. */
export const SUPABASE_WRITE_TOOLS: readonly string[] = [
  'mcp__supabase__apply_migration',
  'mcp__supabase__execute_sql',
];

// ============================================================================
// Bash backstops
// ============================================================================

/** An allow list and a deny list, as they are written into a settings file. */
export interface StudioRuleSet {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

/**
 * Dependency installs. Backstops: a studio profile does not pre-approve an
 * install, which runs code the package manager chooses.
 */
export const INSTALL_DENY_RULES: readonly string[] = [
  'Bash(yarn)',
  'Bash(yarn install*)',
  'Bash(yarn add *)',
  'Bash(npm install*)',
  'Bash(npm ci*)',
  'Bash(pnpm add *)',
  'Bash(pnpm install*)',
];

/**
 * Push, in one place. Design v3 (Conor, 2026-10-02): a studio does not
 * push; publishing goes through a separately authorized session after
 * review. Every rule is a backstop: `Bash(git push *)` also matches a bare
 * `git push`, but no rule matches every spelling (Claude Code's
 * documentation names `git -C . push` and `git -c push.default=current
 * push`), so the `-C` and `--git-dir` forms are listed and the rest stay
 * possible with `Bash(*)`.
 *
 * `allow` is empty by design. A v4 that lets a studio push its own branch
 * changes this constant and nothing else here; it would also need the
 * branch name, which the profile does not take today.
 */
export const STUDIO_PUSH_RULES: StudioRuleSet = {
  allow: [],
  deny: ['Bash(git push *)', 'Bash(git -C * push *)', 'Bash(git --git-dir* push *)'],
};

/** Local commits: the reviewer profile does not stage or commit. Backstops. */
export const COMMIT_DENY_RULES: readonly string[] = [
  'Bash(git add *)',
  'Bash(git commit *)',
  'Bash(git -C * add *)',
  'Bash(git -C * commit *)',
];

// ============================================================================
// The studio profiles
// ============================================================================

export type StudioPermissionProfile = 'builder' | 'reviewer';

export interface ClaudePermissionRules {
  allow: string[];
  deny: string[];
}

/**
 * The SB's own scratch and screenshot directories, which every studio
 * session may write. `~/` is Claude Code's home-relative anchor, so the
 * rule names the directory without baking a home path into the file.
 */
export function scratchPathRules(sbSlug: string): string[] {
  const dirs = [`~/.ink/files/${sbSlug}-scratch/**`, `~/.ink/files/${sbSlug}-screenshots/**`];
  return dirs.flatMap((dir) => [`Edit(${dir})`, `Write(${dir})`]);
}

/**
 * The builder profile: a development session in its own studio. Edits
 * anywhere in its checkout, commits locally on its own branch, reads
 * GitHub and Supabase, and is not pre-approved to push, install, open or
 * merge a pull request, or write the database.
 *
 * `Edit(/**)`: a single leading slash anchors at the session's primary
 * working directory when the rule lives in `.claude/settings.local.json`,
 * so the rule covers this studio's checkout and nothing beside it. The
 * scratch directories are added per SB by `studioPermissionRules`.
 */
export const STUDIO_BUILDER_RULES: StudioRuleSet = {
  allow: [
    'Read(*)',
    'Edit(/**)',
    'Write(/**)',
    'Bash(*)',
    'WebFetch(*)',
    'WebSearch',
    'mcp__inkwell__*',
    'mcp__playwright__*',
    ...GITHUB_READ_TOOLS,
    ...SUPABASE_READ_TOOLS,
    ...STUDIO_PUSH_RULES.allow,
  ],
  deny: [
    ...DEFAULT_CLAUDE_DENY_RULES,
    ...INSTALL_DENY_RULES,
    ...STUDIO_PUSH_RULES.deny,
    ...GITHUB_PUBLISH_TOOLS,
    ...SUPABASE_WRITE_TOOLS,
  ],
};

/**
 * The reviewer profile: a detached checkout of code under review. Reads
 * everything, writes only its SB's scratch directories, posts its review,
 * and is not pre-approved to stage, commit or push, install, or use any
 * other write tool. Its `Bash(*)` is kept for running tests, so every
 * Bash deny here is a backstop too: a subprocess can still write the
 * checkout.
 */
export const STUDIO_REVIEWER_RULES: StudioRuleSet = {
  allow: [
    'Read(*)',
    'Bash(*)',
    'WebFetch(*)',
    'WebSearch',
    'mcp__inkwell__*',
    'mcp__playwright__*',
    ...GITHUB_READ_TOOLS,
    ...GITHUB_REVIEW_TOOLS,
    ...SUPABASE_READ_TOOLS,
  ],
  deny: [
    ...DEFAULT_CLAUDE_DENY_RULES,
    ...INSTALL_DENY_RULES,
    ...COMMIT_DENY_RULES,
    ...STUDIO_PUSH_RULES.deny,
    ...GITHUB_PUBLISH_TOOLS,
    ...GITHUB_OTHER_WRITE_TOOLS,
    ...SUPABASE_WRITE_TOOLS,
  ],
};

/** The rules a studio gets for a profile, with the SB's scratch paths expanded. */
export function studioPermissionRules(
  profile: StudioPermissionProfile,
  sbSlug: string
): ClaudePermissionRules {
  const base = profile === 'reviewer' ? STUDIO_REVIEWER_RULES : STUDIO_BUILDER_RULES;
  return { allow: [...base.allow, ...scratchPathRules(sbSlug)], deny: [...base.deny] };
}

/**
 * Which profile a studio gets, from its server-side record only: never
 * from anything in the checkout, which may be the code under review. A
 * checkout the server recorded as detached (an overflow studio, a PR
 * review) has no branch of its own to commit to, so it gets the reviewer
 * profile; every other studio is a builder. The record carries the fact
 * twice, as the `detached:<ref>` branch sentinel and as the checkout pin in
 * `metadata.checkout`; either one is enough.
 */
export function studioPermissionProfile(
  record: { branch?: string | null; metadata?: unknown } | null | undefined
): StudioPermissionProfile {
  if (!record) return 'builder';
  if (typeof record.branch === 'string' && record.branch.startsWith('detached:')) {
    return 'reviewer';
  }
  const metadata = record.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const checkout = (metadata as Record<string, unknown>).checkout;
    if (
      checkout &&
      typeof checkout === 'object' &&
      (checkout as Record<string, unknown>).mode === 'detached'
    ) {
      return 'reviewer';
    }
  }
  return 'builder';
}

/**
 * One line describing an authored `permissions` object, for the checklist
 * and the completion report. Every object is someone's policy, including
 * an empty one or `defaultMode` alone.
 */
export function describePermissions(permissions: Record<string, unknown>): string {
  const count = (key: string) =>
    Array.isArray(permissions[key]) ? (permissions[key] as unknown[]).length : 0;
  const parts = (['allow', 'deny', 'ask'] as const)
    .filter((key) => count(key) > 0)
    .map((key) => `${count(key)} ${key}`);
  if (typeof permissions.defaultMode === 'string') {
    parts.push(`defaultMode ${permissions.defaultMode}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'empty permissions object';
}
