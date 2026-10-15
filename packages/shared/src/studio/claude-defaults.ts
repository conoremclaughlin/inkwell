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
 * Deny rules: force pushes, refused even in a fully auto-approved studio.
 * Backstops (see the module comment).
 *
 * The destructive local commands (`rm -rf`, `git reset --hard`, `git
 * clean`, `git checkout -- .`) were denied here until 2026-10-13. A deny
 * cannot be approved by anyone, so they are now decided by the PreToolUse
 * hook (`destructive-commands.ts`), which allows a delete inside the
 * session's own studio and asks for anything else. See
 * RETIRED_DENY_RULES.
 */
export const DEFAULT_CLAUDE_DENY_RULES: readonly string[] = [
  'Bash(git push --force *)',
  'Bash(git push -f *)',
];

/**
 * Denies that earlier profiles carried and the current ones lift. A deny
 * wins over every allow and every hook answer, so while one of these stays
 * in a studio's settings the studio cannot do what its profile now allows.
 * `ink permissions sync --apply` removes them, exactly as spelled here and
 * nothing else, and only where the studio's own profile no longer denies
 * them (a reviewer keeps its PR and SQL denies).
 *
 *   - the destructive local commands, which the PreToolUse hook now
 *     decides (spec automated-turn-permissions §3.4);
 *   - opening or updating a PR and running SQL, which the builder now
 *     allows (Conor, 2026-10-15). Spelled here rather than spread from
 *     GITHUB_PR_TOOLS and SUPABASE_SQL_TOOLS, which are declared below;
 *   - dependency installs, which both profiles now allow (Conor,
 *     2026-10-15). A session already runs its checkout's code through its
 *     tests, so an install's scripts are not a new kind of trust;
 *   - merging a pull request, which the builder now allows (Conor,
 *     2026-10-15, 2:05 PM). Sibling review and green CI before a merge are
 *     the process rule (AGENTS.md), not a permission.
 */
export const RETIRED_DENY_RULES: readonly string[] = [
  'Bash(rm -rf *)',
  'Bash(git reset --hard *)',
  'Bash(git clean -fd *)',
  'Bash(git clean -f *)',
  'Bash(git checkout -- .)',
  'mcp__github__create_pull_request',
  'mcp__github__update_pull_request',
  'mcp__github__update_pull_request_branch',
  'mcp__supabase__execute_sql',
  'Bash(yarn)',
  'Bash(yarn install*)',
  'Bash(yarn add *)',
  'Bash(npm install*)',
  'Bash(npm ci*)',
  'Bash(pnpm add *)',
  'Bash(pnpm install*)',
  'mcp__github__merge_pull_request',
  'Bash(gh pr merge*)',
  'Bash(gh * pr merge*)',
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
 * GitHub MCP tools that change a repository or a branch outside a push and
 * a PR: writing files or branches directly (these can name main), creating,
 * forking or deleting a repository. Denied in both studio profiles.
 */
export const GITHUB_PUBLISH_TOOLS: readonly string[] = [
  'mcp__github__create_branch',
  'mcp__github__create_or_update_file',
  'mcp__github__create_repository',
  'mcp__github__delete_file',
  'mcp__github__delete_repository',
  'mcp__github__fork_repository',
  'mcp__github__push_files',
];

/**
 * GitHub MCP tools that open or update a pull request. A builder works on
 * its own branch, so its PR is its own work, and Conor allowed it on
 * 2026-10-15. The builder allows them and the reviewer denies them.
 */
export const GITHUB_PR_TOOLS: readonly string[] = [
  'mcp__github__create_pull_request',
  'mcp__github__update_pull_request',
  'mcp__github__update_pull_request_branch',
];

/**
 * Merging a pull request, by the GitHub tool or `gh pr merge`. Conor,
 * 2026-10-15: every builder session can merge its PR. Sibling review and
 * green CI first are the process rule (AGENTS.md); no permission rule can
 * tell whether they happened. The builder allows the tool, and its
 * `Bash(*)` already covers `gh`; the reviewer denies both, because merging
 * is the author's step.
 */
export const GITHUB_MERGE_TOOLS: readonly string[] = ['mcp__github__merge_pull_request'];
export const GH_MERGE_DENY_RULES: readonly string[] = [
  'Bash(gh pr merge*)',
  'Bash(gh * pr merge*)',
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

/**
 * Applying a migration through the Supabase tool. Denied everywhere: the
 * tool records the apply time as the version and the ledger drifts, so
 * migrations go through `yarn db:migrate` (AGENTS.md).
 */
export const SUPABASE_MIGRATION_TOOLS: readonly string[] = ['mcp__supabase__apply_migration'];

/**
 * Arbitrary SQL, writes included. The builder allows it, as Conor did on
 * 2026-10-15; the reviewer denies it.
 */
export const SUPABASE_SQL_TOOLS: readonly string[] = ['mcp__supabase__execute_sql'];

/** Supabase MCP tools that can write: a migration, or arbitrary SQL. */
export const SUPABASE_WRITE_TOOLS: readonly string[] = [
  ...SUPABASE_MIGRATION_TOOLS,
  ...SUPABASE_SQL_TOOLS,
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
 * Every push, by the spellings a rule can name. The reviewer profile denies
 * them all. Backstops: `Bash(git push *)` also matches a bare `git push`,
 * but no rule matches every spelling (Claude Code's documentation names
 * `git -C . push` and `git -c push.default=current push`), so the `-C` and
 * `--git-dir` forms are listed and the rest stay possible with `Bash(*)`.
 */
export const PUSH_DENY_RULES: readonly string[] = [
  'Bash(git push *)',
  'Bash(git -C * push *)',
  'Bash(git --git-dir* push *)',
];

/** The push spellings the restricted denies are written for. */
const PUSH_PREFIXES = ['git push', 'git -C * push'] as const;

/**
 * The builder's push policy, in one place. Design v4 (Conor, 2026-10-02:
 * "it's working on its own branch"; Lumen agreed): a studio pushes its own
 * feature branch normally, so push is a plain allow, and the forms that
 * rewrite or bypass are denied. Nothing here lifts a deny: the blanket push
 * denies are simply not in the builder's list, because deny beats allow and
 * they would forbid every push.
 *
 * Denied, as backstops (a `*` in a Bash rule spans spaces, so each one
 * matches its flag or destination anywhere after `push`):
 *   - force: `--force`, `--force-with-lease`, `-f`, and a `+` refspec;
 *   - the default branch as the destination: `main`, `HEAD:main`, `:main`,
 *     `refs/heads/main`;
 *   - `--no-verify`, which skips the pre-push hook;
 *   - pushes that rewrite or delete refs wholesale: `--mirror` (force-
 *     updates and deletes every ref, main included), `--all`, `--prune`,
 *     and `--delete` / `-d`.
 * Other spellings get through: `-uf`, `git -c … push`, a script, a
 * `--git-dir` push, and git's unique long-option prefixes (`--no-veri`,
 * `--mirr`, `--forc`), which no glob can enumerate. So does a push to some
 * other branch: a deny cannot say "any branch but this one". And the
 * `git -C <dir> push` forms over-match: the `*` standing for the directory
 * also spans spaces, so `git -C . commit -m "do not push --force"` is
 * refused too. That is kept on purpose, because SBs push with `git -C` routinely,
 * and the force backstop matters more there than the rare false refusal.
 * Branch ownership is not enforced
 * here or by the pre-push hook. The hook (`.husky/pre-push` →
 * `scripts/check-push.sh`, shared by every worktree through
 * `core.hooksPath`) scans content: passing it means nothing matched, not
 * that the push is clean. The session that pushes still checks that the
 * repository, the remote and the destination ref are the studio's
 * assigned ones, runs the preview, reads every message back and checks
 * authors. Opening and merging PRs stay behind review and Conor's OK; the
 * GitHub tools for them are denied in `GITHUB_PUBLISH_TOOLS`.
 */
export const STUDIO_PUSH_RULES: StudioRuleSet = {
  allow: ['Bash(git push *)'],
  deny: PUSH_PREFIXES.flatMap((push) => [
    `Bash(${push} *--force*)`,
    `Bash(${push} -f *)`,
    `Bash(${push} * -f *)`,
    `Bash(${push} * -f)`,
    `Bash(${push} * +*)`,
    `Bash(${push} * main)`,
    `Bash(${push} * main *)`,
    `Bash(${push} * *:main)`,
    `Bash(${push} * *:main *)`,
    `Bash(${push} * *refs/heads/main)`,
    `Bash(${push} * *refs/heads/main *)`,
    `Bash(${push} *--no-verify*)`,
    `Bash(${push} *--mirror*)`,
    `Bash(${push} *--all*)`,
    `Bash(${push} *--prune*)`,
    `Bash(${push} *--delete*)`,
    `Bash(${push} -d *)`,
    `Bash(${push} * -d *)`,
  ]),
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
 * An SB slug that is safe to put in a path rule: lowercase letters, digits,
 * `-` and `_`, starting with a letter or digit. Anything else (`*`, `/`,
 * `..`) would widen the rule beyond the SB's own directories.
 */
export const SB_SLUG_FOR_RULES = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * The SB's own scratch and screenshot directories, which every studio
 * session may read and write. `~/` is Claude Code's home-relative anchor,
 * so the rule names the directory without baking a home path into the
 * file. `Edit` covers every built-in tool that writes a file; a `Write`
 * path rule is accepted but never consulted, and warns at startup (Claude
 * Code docs, permissions, "Read and Edit"). `Read` is needed because
 * `Read(*)` is anchored at the working directory. Throws on a slug that
 * would widen the rule.
 */
export function scratchPathRules(sbSlug: string): string[] {
  if (!SB_SLUG_FOR_RULES.test(sbSlug)) {
    throw new Error(`not a slug that can name a scratch path: ${JSON.stringify(sbSlug)}`);
  }
  const dirs = [`~/.ink/files/${sbSlug}-scratch/**`, `~/.ink/files/${sbSlug}-screenshots/**`];
  return dirs.flatMap((dir) => [`Read(${dir})`, `Edit(${dir})`]);
}

/**
 * The builder profile: a development session in its own studio. Edits
 * anywhere in its checkout, commits locally and pushes its own branch
 * (STUDIO_PUSH_RULES), opens and updates its pull request, reads GitHub,
 * runs SQL, installs dependencies, merges its pull request, and is not
 * pre-approved to force-push, push to main, skip the pre-push hook, write
 * a branch through the GitHub API, or apply a migration through the
 * Supabase tool.
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
    'Bash(*)',
    'WebFetch(*)',
    'WebSearch',
    'mcp__inkwell__*',
    'mcp__playwright__*',
    ...GITHUB_READ_TOOLS,
    ...GITHUB_PR_TOOLS,
    ...GITHUB_MERGE_TOOLS,
    ...SUPABASE_READ_TOOLS,
    ...SUPABASE_SQL_TOOLS,
    ...STUDIO_PUSH_RULES.allow,
  ],
  deny: [
    ...DEFAULT_CLAUDE_DENY_RULES,
    ...STUDIO_PUSH_RULES.deny,
    ...GITHUB_PUBLISH_TOOLS,
    ...SUPABASE_MIGRATION_TOOLS,
  ],
};

/**
 * The reviewer profile: a detached checkout of code under review. Reads
 * everything, writes only its SB's scratch directories, posts its review,
 * and is not pre-approved to stage, commit or push, merge, or use any
 * other write tool. Its `Bash(*)` is kept for running tests, and installing the
 * dependencies they need, so every Bash deny here is a backstop too: a
 * subprocess can still write the checkout.
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
    ...COMMIT_DENY_RULES,
    ...PUSH_DENY_RULES,
    ...GITHUB_PUBLISH_TOOLS,
    ...GITHUB_PR_TOOLS,
    ...GITHUB_MERGE_TOOLS,
    ...GH_MERGE_DENY_RULES,
    ...GITHUB_OTHER_WRITE_TOOLS,
    ...SUPABASE_WRITE_TOOLS,
  ],
};

/**
 * The rules a studio gets for a profile, with the SB's scratch paths
 * expanded. Each list is deduplicated: the profiles compose overlapping
 * groups (the default force-push denies and the push policy's).
 */
export function studioPermissionRules(
  profile: StudioPermissionProfile,
  sbSlug: string
): ClaudePermissionRules {
  const base = profile === 'reviewer' ? STUDIO_REVIEWER_RULES : STUDIO_BUILDER_RULES;
  return {
    allow: [...new Set([...base.allow, ...scratchPathRules(sbSlug)])],
    deny: [...new Set(base.deny)],
  };
}

// ============================================================================
// Automated turns: yolo with ironclad denies (spec automated-turn-permissions)
// ============================================================================

/**
 * Skipping the hooks on a commit: `--no-verify`, or its short form `-n`.
 * Backstops: a combined short flag (`-an`) or a script still gets through.
 */
export const NO_VERIFY_COMMIT_DENY_RULES: readonly string[] = [
  'git commit',
  'git -C * commit',
].flatMap((commit) => [
  `Bash(${commit} *--no-verify*)`,
  `Bash(${commit} -n *)`,
  `Bash(${commit} * -n *)`,
  `Bash(${commit} * -n)`,
]);

/**
 * The rules no automated turn is pre-approved to break, yolo included.
 * Conor, 2026-10-06: "yolo should keep these ironclad rules about no push to
 * main, no force-push, and no merging PRs without review still apply."
 * AGENTS.md adds `--no-verify`, and migrations go through `yarn db:migrate`.
 * On 2026-10-15 he narrowed it: builders merge their PRs, and the intent of
 * the rules is no deletes in random places and no push or force-push to
 * main. A merge is no longer denied here; review first stays a process
 * rule, and a reviewer launch still denies merging through its profile.
 *
 *   - the builder's push denies: force, a `+` refspec, main as the
 *     destination, `--no-verify`, and the wholesale ref rewrites;
 *   - `--no-verify` on a commit;
 *   - writing a branch or a repository without a push or a PR: the GitHub
 *     tools that write files directly, or delete a repository;
 *   - applying a migration through the Supabase tool. SQL itself is not
 *     denied (Conor, 2026-10-15).
 *
 * Backstops, like every Bash deny here (see the module comment).
 */
export const IRONCLAD_DENY_RULES: readonly string[] = [
  ...new Set([
    ...STUDIO_PUSH_RULES.deny,
    ...NO_VERIFY_COMMIT_DENY_RULES,
    'mcp__github__push_files',
    'mcp__github__create_or_update_file',
    'mcp__github__delete_file',
    'mcp__github__delete_repository',
    ...SUPABASE_MIGRATION_TOOLS,
  ]),
];

/**
 * An MCP server name that can be put in an `mcp__<server>__*` rule. Claude
 * Code has no cross-server wildcard, so each configured server is named.
 */
export const MCP_SERVER_NAME_FOR_RULES = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The rules an automated turn gets when the server runs yolo
 * (`INK_AUTOMATED_TURNS=yolo`): no prompt for the everyday tools, the shell,
 * reads and edits anywhere, the web, every MCP server the launch connects,
 * and the ironclad denies. A reviewer launch keeps the reviewer's own denies
 * as well, because the code under review must not be able to commit or push
 * through it. Stored denies in the checkout's settings still apply beside
 * these (deny wins across sources; documented, not measured).
 *
 * `Read(//**)` and `Edit(//**)` are absolute already, so the launch file
 * keeps them as written. A reviewer gets no `Edit(//**)`: it edits only its
 * SB's scratch directories, as its profile does. Throws on an MCP server
 * name that would not form a server-scoped rule, and on a reviewer with no
 * owner.
 */
export function automatedLaunchRules(options: {
  profile?: StudioPermissionProfile;
  /** Whose scratch paths a reviewer may edit; required for a reviewer. */
  owner?: string;
  mcpServers: readonly string[];
}): ClaudePermissionRules {
  const reviewer = options.profile === 'reviewer';
  if (reviewer && options.owner === undefined) {
    throw new Error('a reviewer launch needs the SB whose scratch paths it may edit');
  }
  for (const server of options.mcpServers) {
    if (!MCP_SERVER_NAME_FOR_RULES.test(server)) {
      throw new Error(`not an MCP server name that can form a rule: ${JSON.stringify(server)}`);
    }
  }
  // A reviewer edits only its SB's scratch, as its profile does: yolo removes
  // prompts, not the reviewer's read-only stance on the code under review
  // (Lumen, #853).
  const allow = [
    'Bash(*)',
    'Read(//**)',
    ...(reviewer ? scratchPathRules(options.owner as string) : ['Edit(//**)']),
    'WebFetch(*)',
    'WebSearch',
    ...options.mcpServers.map((server) => `mcp__${server}__*`),
  ];
  const deny = [...IRONCLAD_DENY_RULES, ...(reviewer ? STUDIO_REVIEWER_RULES.deny : [])];
  return { allow: [...new Set(allow)], deny: [...new Set(deny)] };
}

/** The studio record fields the profile is read from. */
export interface StudioProfileRecord {
  branch?: string | null;
  metadata?: unknown;
  roleTemplate?: string | null;
  threadKey?: string | null;
}

/** `pr:<n>` or `<project>:pr:<n>`, the thread shapes a PR review runs on. */
function isPullRequestThreadKey(threadKey: string | null | undefined): boolean {
  if (typeof threadKey !== 'string') return false;
  const segments = threadKey.split(':');
  if (segments.length < 2 || segments.length > 3) return false;
  return segments[segments.length - 2] === 'pr' && /^\d+$/.test(segments[segments.length - 1]);
}

const PULL_REQUEST_REF = /^origin\/pr\/\d+$/;

/**
 * Which profile a studio gets, from its server-side record only: never
 * from anything in the checkout, which may be the code under review.
 *
 * A reviewer is a studio whose row says so (`roleTemplate: 'reviewer'`),
 * or a PR-review checkout: detached, and pinned to a pull request's head
 * (`metadata.checkout.ref` or the `detached:<ref>` branch sentinel naming
 * `origin/pr/<n>`) or created for a PR thread (`threadKey`), which also
 * covers a review whose PR fetch failed and fell back to the base branch.
 * Every other studio is a builder, an ordinary overflow studio detached at
 * the base included: it does write work, and the reviewer profile would
 * leave it unable to edit.
 *
 * No record means no profile (undefined): callers write no permissions
 * rather than guess, because a guessed profile is kept by every later run.
 */
export function studioPermissionProfile(
  record: StudioProfileRecord | null | undefined
): StudioPermissionProfile | undefined {
  if (!record) return undefined;
  if (record.roleTemplate === 'reviewer') return 'reviewer';
  const metadata =
    record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : {};
  const checkout =
    metadata.checkout && typeof metadata.checkout === 'object'
      ? (metadata.checkout as Record<string, unknown>)
      : null;
  const sentinel =
    typeof record.branch === 'string' && record.branch.startsWith('detached:')
      ? record.branch.slice('detached:'.length)
      : null;
  const detached = checkout?.mode === 'detached' || sentinel !== null;
  if (!detached) return 'builder';
  const pinnedToPullRequest =
    (typeof checkout?.ref === 'string' && PULL_REQUEST_REF.test(checkout.ref)) ||
    (sentinel !== null && PULL_REQUEST_REF.test(sentinel));
  return pinnedToPullRequest || isPullRequestThreadKey(record.threadKey) ? 'reviewer' : 'builder';
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
