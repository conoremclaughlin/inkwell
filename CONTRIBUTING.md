# Contributing to Inkwell

This guide covers conventions for everyone working in this codebase — both organic beings (OBs) and synthetically-born beings (SBs).

## Git Conventions

### Commits

We use the [Angular commit convention](https://github.com/angular/angular/blob/main/CONTRIBUTING.md):

```
<type>(<scope>): <short summary>
  │       │             │
  │       │             └─⫸ Imperative present tense. Not capitalized. No period.
  │       │
  │       └─⫸ Optional. Succinct, relevant to the initiative.
  │
  └─⫸ feat|fix|refactor|chore|docs|test|perf|build|ci|style
```

Examples:

```
feat(cli): add global install via symlink
fix(sessions): preserve existing fields on upsert
refactor(mcp): extract identity resolution into service
chore: bump typescript to 5.4
```

#### Writing the message: use `-F`, never `-m`

**Write the message to a file and commit with `git commit -F <file>`.** Never `-m` — not even
for a one-line subject.

```bash
cat > /tmp/msg.txt <<'EOF'     # note the QUOTED delimiter
fix(cache): honour a `local` flag on the cache entry
EOF
git commit -F /tmp/msg.txt
```

A double-quoted `-m` string is shell input. A backtick or `$(...)` anywhere inside it is
**executed**, and its output is pasted into the commit. Markdown backticks around an
identifier — ``a `local` flag`` — are how we normally write, which makes this a trap rather
than an edge case.

A subject line is **not** a safe exception. It is shell input on exactly the same terms, and a
subject is where our backticked identifiers most often appear:

```bash
git commit -m "fix: honour the `local` flag"   # git receives: fix: honour the  flag
```

Single-quoting is not the fix either — an apostrophe in a word like `don't` closes the string
and the remainder of the message is re-parsed as shell.

**How the file gets written matters as much as `-F` does.** `-F` reads bytes and never expands
them, but the shell still expands whatever _creates_ the file, one step earlier:

```bash
cat > msg <<'EOF'     # SAFE — quoted delimiter, every byte literal
cat > msg <<EOF       # UNSAFE — backticks and $VAR expand as the file is written
```

Quote the heredoc delimiter, or write the file with a tool that never goes through a shell (in
Claude Code, the `Write` tool).

On 2026-09-13 a message containing the phrase ``a `local` flag on the cache entry`` ran the
zsh `local` builtin, which at top level prints every parameter, and pasted the entire
environment into the commit. Ten live credentials reached a public repository. Two earlier
commits from February 2026 did the same thing and sat on public `main` for seven months.
Different people, seven months apart, following what the docs said at the time.

Review cannot catch it. The substitution happens between typing the message and the commit
existing, so the author never reads back what was written, and the diff is unaffected — a
reviewer looking at the change sees nothing wrong. `-F` never goes through shell expansion
and has no quoting rules to get wrong.

The enforcing half is `scripts/check-commit-msg.sh`, wired as the `commit-msg` hook (the one
hook that sees the finished message; a `pre-commit` hook never does). Husky installs it via
`yarn install`, so it should already be active — see [Formatting](#formatting). It refuses a
message carrying named secret assignments, vendor token shapes, or an environment dump, and
reports variable names and line numbers only, never values, so the hook output does not
become the next place a secret is written down.

**It is a heuristic backstop, not universal detection, and `-F` is still the actual fix.**
It recognises the shapes we have actually been burned by: a list of known secret variable
names, a handful of vendor token formats, and a run of assignment lines that looks like a
dumped environment. A secret it has never been told to recognise, in a shape it does not
model, will pass — and deliberately so at the edges: a value written as `<placeholder>` or
`***` is treated as prose, because prose about this guard is something we write far more
often than we leak. Passing the hook means "nothing matched", never "no credentials here".
Do not let it become the reason you stop being careful about how the message is written.

It is also skippable with `--no-verify` and only active where `core.hooksPath` points at a
checkout that has it, which is why the durable protection is the `-F` habit above rather
than the hook.

If it blocks you, nothing has been committed and your staged changes are untouched. Read the
draft message it points at before reusing it — if the guard fired on a real substitution, the
draft contains the leaked values and must not be recycled into the next attempt.

If it blocks you and you are _sure_ it is prose rather than a leak, rewrite the prose rather
than reaching for `--no-verify`: keep a placeholder like `<value>` or `***` immediately after
the `=`, or avoid putting a credential-shaped run right after one. Every false positive so
far has been a commit message _about_ this guard.

Its regression suite is `scripts/check-commit-msg.test.sh` (synthetic fixtures, runs in CI).
`scripts/check-commit-msg.history.sh` is the local-only check that replays the three real
leaking commits by SHA and sweeps `main` for false positives; it is not in CI because a
shallow clone does not have the history it needs.

### Branching

We follow [GitHub flow](https://www.geeksforgeeks.org/git-flow-vs-github-flow/): feature branches off `main`, which must always be stable and deployable.

```
<initials or moniker>/<type>/<scope>
  │                      │       │
  │                      │       └─⫸ Kebab-case. Succinct description.
  │                      │
  │                      └─⫸ Same types as commits.
  │
  └─⫸ Your initials or unique moniker (e.g., cm, wren, myra)
```

Examples:

```bash
git checkout -b cm/feat/agent-orchestrator
git checkout -b wren/fix/session-resume
git checkout -b myra/chore/heartbeat-cleanup
```

When syncing with main: rebase first; if conflicts get messy, merge main in and move on.

**Never set your upstream to `origin/main` from a non-main branch.** When pushing a feature branch, use `git push -u origin <your-branch-name>`. Pushing directly to `origin/main` from a feature branch bypasses the PR review process and can overwrite others' work.

### Merging

**Do not squash commits.** SBs commit at logical points throughout a PR, and since PRs often span multiple features, preserving individual commits tells a clearer story than a single squashed blob. Use **merge commit** (not squash or rebase) when merging PRs.

### Code Comments

```
<author>(<scope>): <short summary>
  │         │             │
  │         │             └─⫸ Be succinct. Present tense.
  │         │
  │         └─⫸ Optional. todo|bug|???|<commit-style scope>
  │
  └─⫸ Optional. Your initials or common name.
```

A plain comment needs no prefix — any comment is implicitly a note. Only add structure when it conveys something the comment alone wouldn't.

Examples:

```typescript
// cm(todo): extract this into a shared utility
// wren(bug): race condition when two agents write simultaneously
// ???: unclear why this timeout is needed — removing it breaks auth
// Simple explanation needs no prefix
```

## Pull Requests

When an SB creates or significantly contributes to a PR, attribute it in the title:

```
feat: add web chat interface (by Wren)
fix: resolve kindle token expiry (by Lumen)
```

The `(by <name>)` suffix goes at the end of the title, after the conventional commit description.

In the PR body, use the standard format:

```markdown
## Summary

- <bullet points>

## Test plan

- [ ] <checklist>

Generated with [Claude Code](https://claude.com/claude-code)
```

Replace "Claude Code" with the appropriate tool if the SB used a different interface (e.g., Gemini CLI, Codex).

### PR Reviews

When leaving comments or reviews on a pull request, sign off with your agent name so other contributors know who said what. This is especially important in a multi-agent codebase where several SBs may review the same PR.

```
— Wren
— Lumen
```

### Review Media

**Screenshots and recordings are review artifacts, not source. They do not belong in
git.** A merged PR keeps its media in the repository's history permanently, and history
cannot be pruned without rewriting `main` — so every set costs every future clone,
forever, to render a page that a reviewer looks at once.

Capture to `~/.ink/files/<agent>-screenshots/` (already the delivery path in PROCESS)
and route from there:

| Audience                  | How it reaches them                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Conor                     | Send via Myra — he reviews from his phone, and the repo is not a channel he reads                                              |
| Sibling SBs               | They share the machine; a local path in the review request is enough                                                           |
| Dashboard evidence viewer | Streams `~/.ink/files` and a local `docs/screenshots/` at runtime — a filesystem lookup, so the files never need to be tracked |

`docs/screenshots/` is gitignored for that last reason: the directory stays useful
locally while its contents stay out of history.

There is no "commit it on the branch and delete it before merge" escape hatch. We merge
with merge commits, so every branch commit becomes an ancestor of `main`: adding a file
in one commit and removing it in the next still ships the blob to everyone who clones.
The deletion hides it from the tree, not from history.

So if an image cannot be delivered by one of the routes above, it goes in a store
outside git — a GitHub release asset (`gh release upload`) is the option with a public
API — never a commit. PR bodies written before this rule link their media by full-SHA
permalink into history that already carries it; leave those alone and do not add new
ones. Never link `blob/<branch>/…` in any case: those break the moment the branch is
deleted.

## Coding Style

- **camelCase** for variables and functions (acronyms treated as words: `userId`, `apiResponse`)
- **PascalCase** for classes and types (`HttpClient`, `UserIdentity`)
- **SCREAMING_SNAKE_CASE** for constants

### Formatting

Prettier runs automatically on every commit via Husky + lint-staged. You do **not** need to run prettier manually — just commit and it handles formatting for `*.{ts,tsx,js,jsx,json,css,md}` files.

Husky is installed by the `prepare` script, so a plain `yarn install` activates every hook in
`.husky/` — including `commit-msg`, the credential guard described under
[Commits](#writing-the-message-use--f-never--m). If `git config core.hooksPath` prints nothing,
hooks are not active in this checkout; run `yarn install` to wire them up.

To format without committing:

```bash
npx prettier --write "path/to/file"
```

## Coding Conventions

### TypeScript

- Strict typing, avoid `any`
- Use Zod for runtime validation
- Prefer `async/await` over callbacks

### File Organization

- One class/module per file
- Co-locate tests (`*.test.ts`)
- Export types from `types.ts` files

### Error Handling

- Use typed errors where possible
- Log errors with context
- Return structured error responses

### Upsert / Partial Update Safety

- When building upsert or update objects, **never set optional fields to `null` just because they weren't provided**. Omitted fields should preserve their existing database values.
- Use `undefined` checks (`field !== undefined`) to distinguish "not provided" from "explicitly cleared":

  ```typescript
  // WRONG: wipes existing value when field is omitted
  soul: soul || null,

  // RIGHT: preserves existing value when field is omitted
  soul: soul !== undefined ? (soul || null) : (existing?.soul ?? null),
  ```

- Only set a field to `null` when the caller explicitly passes `null` (or an empty string that should clear the field).
- For handlers that accept partial updates, fetch the existing record first and merge provided fields over it.
- When adding new columns to a table, also update: (1) archive/history triggers, (2) history response mappings, (3) restore handlers.

## Development Commands

```bash
yarn dev                   # Start API+web with hot reload (default: port 3001)
yarn prod                  # One-shot: build + migrate + start (alias for prod:up)
yarn prod:refresh          # Install + build latest code after pull
yarn prod:migrate          # Apply pending migrations (auto-detects local vs remote)
yarn prod:direct           # Run API+web directly in production mode
yarn build                 # Build all packages
yarn type-check            # Type check all packages
yarn test                  # Unit tests (all workspaces)
yarn supabase:local:setup  # Start/reset local Supabase and sync env values into .env.local
yarn local:status          # Show local migration status
yarn linked:status         # Show linked (remote) migration status
yarn local:migrate         # Apply local migrations
yarn linked:migrate        # Apply linked (remote) migrations
yarn test:integration:db:local   # DB integration suite against isolated local Supabase
yarn test:integration:runtime    # Runtime/CLI integration suite
yarn logs:ink              # View Inkwell server logs (structured JSON)
```

### Migration target auto-detection

`yarn prod:migrate` and `migration-status` auto-select the target:

- Explicit override: `INK_MIGRATION_TARGET=local|linked`
- `local` when `SUPABASE_URL` points to localhost/127.0.0.1/::1
- Otherwise `linked` (remote)
- Source precedence: process env → `.env.local` → `.env`

### Production startup

```bash
yarn prod                  # One-shot: build + migrate + start
# Or step by step:
yarn prod:refresh          # Build
yarn prod:migrate          # Migrate
yarn prod:direct           # Start (no rebuild, uses existing artifacts)
```

Notes:

- `yarn dev` runs migration-status warnings on startup.
- To run API only (no dashboard): `INK_RUN_WEB=false yarn prod:direct`
- After `git pull`, run `yarn prod:refresh` and restart your process.
- `sb doctor` checks migration status and points to `yarn prod:migrate` when pending.

### Integration tests

`yarn test:integration:db:local` spins up an **isolated, temporary local Supabase stack** with dedicated ports, applies migrations + seed, runs integration tests, then tears it down. This avoids accidental use of remote credentials.

## Key Technologies

- **Runtime**: Node.js 22 (`.nvmrc`; 20 is the floor set by the MCP SDK v2 packages), TypeScript, Yarn 4 workspaces
- **MCP SDK**: `@modelcontextprotocol/server` (v2) with `@modelcontextprotocol/node` for the HTTP transport
- **Database**: Supabase (PostgreSQL + pgvector)
- **Messaging**: Telegraf (Telegram), Baileys (WhatsApp)
- **CLI**: Commander.js, Ink (React for CLI)
