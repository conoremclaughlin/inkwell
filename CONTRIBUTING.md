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
git commit -m "fix: honour the `pwd` flag"   # git receives: fix: honour the /Users/you/ws/pcp flag
```

The example substitutes `pwd` rather than the builtin that actually caused the incident,
because this snippet is runnable and the real one dumps your environment into a commit. The
mechanism is identical; only the payload is harmless.

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
environment into the commit. Ten nonempty credential-bearing assignments reached a public repository. Two earlier
commits from February 2026 did the same thing and sat on public `main` for seven months.
Different people, seven months apart, following what the docs said at the time.

Review cannot catch it. The substitution happens between typing the message and the commit
existing, so the author never reads back what was written, and the diff is unaffected — a
reviewer looking at the change sees nothing wrong. `-F` never goes through shell expansion
and has no quoting rules to get wrong.

The enforcing half is `scripts/check-commit-msg.sh`, wired as the `commit-msg` hook (the one
hook that sees the finished message; a `pre-commit` hook never does). It refuses a message
carrying named secret assignments, vendor token shapes, or an environment dump, and reports
variable names and line numbers only, never values, so the hook output does not become the
next place a secret is written down.

**Check that it is actually on, rather than assuming.** `yarn install` runs Husky, but what
runs at commit time is `$(git config core.hooksPath)/commit-msg` — and on a machine with
worktrees that path is one shared directory serving all of them, belonging to whichever
checkout configured it. A non-empty `core.hooksPath` therefore says nothing about whether
the guard exists there. `ls "$(git config core.hooksPath)"/commit-msg` is the question worth
asking; if it is missing, nothing is being checked and nothing will tell you so.

**It is a heuristic backstop, not universal detection, and `-F` is still the actual fix.**
It recognises the shapes we have actually been burned by: a list of known secret variable
names, a handful of vendor token formats, and a run of assignment lines that looks like a
dumped environment. A secret it has never been told to recognise, in a shape it does not
model, will pass. It is skippable with `--no-verify`, and inactive wherever the hook is not
installed. Passing it means "nothing matched", never "no credentials here". Do not let it
become the reason you stop being careful about how the message is written.

If it blocks you, nothing has been committed and your staged changes are untouched. Read the
draft message it points at before reusing it — if the guard fired on a real substitution, the
draft contains the leaked values and must not be recycled into the next attempt.

**Writing prose about these variables: name them, do not assign to them.** The guard refuses
_any_ assignment to a name it knows, whatever follows the `=` — including `<placeholder>`,
`***`, a quoted value, a three-letter default, and a bare `=` with nothing after it at all.
That is a deliberate false positive, and it replaced two narrower rules that each tried to
keep the assignment form writable. Both failed the same way: an exemption defined by what the
value _looks like_ exempts every real credential that happens to look like that too — one
starting with `*`, or quoted, or short. Three leaked messages is not a sample that can license
a rule about what credentials never look like.

So write ``the `JWT_SECRET` value`` rather than `JWT_SECRET=<value>`. It reads no worse and
has no ambiguity. Every false positive so far has been a commit message _about_ this guard,
and this is the rewrite that clears it — reach for that before `--no-verify`.

Its regression suite is `scripts/check-commit-msg.test.sh` (synthetic fixtures, runs in CI).
`scripts/check-commit-msg.history.sh` is the local-only check that replays the three real
leaking commits by SHA and sweeps `main` for false positives; it is not in CI because a
shallow clone does not have the history it needs.

That sweep carries a short list of full SHAs whose messages it flags and which have been read
and confirmed to hold no credential — prose about this guard, written before the guidance above
existed. They are reported as known prose rather than as findings, so the sweep stays green and
stays worth running. The list lives only in the history sweep: **the hook itself has no
exemptions**, a commit already in `main` cannot be made safe by refusing it, and a scan that
fails to complete is a failure whether or not the commit is listed. Adding to it means reading
the whole message first and saying so in the comment beside the SHA.

#### Staging and pushing: name the paths, read the messages back

Two more rules sit beside `-F`, set on 2026-09-13 after the leak above. The full list, with
the reasoning, is in [AGENTS.md](./AGENTS.md#commit-messages-secrets-and-what-gets-pushed-ironclad);
these are the two that change what you type.

**Stage by naming paths.** `git add <path> [<path>...]`, or a directory you have just looked at,
then `git diff --cached` before committing. Not `git add -A`, not `git add .`, not `git commit -a`
or `-am`. The first two sweep in untracked files you never inspected — an env file, an identity
file, scratch output — and the last two commit every modified tracked file without the
staged-diff review.

**Read every commit message back before you push, every time, through the guard.**

```bash
sh scripts/check-push.sh --preview
```

That replays `origin/main..HEAD` the way the `pre-push` hook will: each message is scanned first
and printed only if it passes, oldest first; one that fails is withheld and only its value-free
report is shown. Read the output top to bottom. Do not use a raw `git log` for this from a session
whose output is captured — an unscanned message carrying a secret would be written straight into
the transcript. The push is the point of no return, and a message you have not read back is a
message you have not finished writing. The hook runs the same replay and refuses the push on a
refusal, but it is a backstop: passing it means nothing matched, not that the messages are clean.

Nothing in a commit message is ever evaluated by the shell. Backticks, `$(...)` and `$VAR` are
fine as literal text written through a quoted heredoc or the Write tool; they are forbidden
anywhere the shell would expand them — an `-m` string, an unquoted heredoc, a double-quoted `echo`
or `printf` argument. Need a computed value in the message? Run the command separately, read its
output, and paste the literal.

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

### Filing issues

Contributors from outside the project: GitHub issues are the right place, and they are read.

SBs and core contributors: file issues as Inkwell tasks (`create_task`), not GitHub issues. The
GitHub account is shared, so an internal issue there is indistinguishable from an external report
and lands on a surface the team does not triage from. When an external report arrives, open the
Inkwell task that tracks it, note the issue number in the task, and reply on GitHub when it is
resolved.

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

Husky is installed by the `prepare` script, so a plain `yarn install` points `core.hooksPath`
at a `.husky/` directory — including `commit-msg`, the credential guard described under
[Commits](#writing-the-message-use--f-never--m). If `git config core.hooksPath` prints nothing,
hooks are not active in this checkout; run `yarn install` to wire them up.

A path that _does_ print is only half the answer. Hooks run from the checkout that owns that
directory, not from the one you are committing in, so on a machine with worktrees one stale or
incomplete `.husky/` serves all of them. Check for the hook itself:

```bash
ls "$(git config core.hooksPath)"/commit-msg
```

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

Local DB integration tests share a **retained, test-only Supabase stack** across
worktrees. The first run starts it and applies migrations + seed; subsequent runs
reuse the containers and schema. CI still starts, resets, and tears down a fresh
stack on each job. Neither path uses an application database.

```bash
# Focus on the affected integration file rather than repeatedly running everything.
yarn test:integration:db:local src/auth/pcp-tokens.integration.test.ts
# Rebuild test data/schema after migration/seed changes, or for a clean rerun.
yarn test:integration:db:local --reset
# Release the retained containers and their test data when finished.
yarn test:integration:db:local --stop
# CI-equivalent lifecycle (stop a retained stack first).
yarn test:integration:db:local --fresh
```

**Warm runs clean fixture data before the suite, not on exit.** A reviewed list of
70 application fixture tables is truncated in one `RESTRICT` transaction and
restored from a data-only snapshot captured immediately after migrations and seed.
There is no database/schema drop, implicit `CASCADE`, or container recreation.
Migration-seeded templates and seed rows are restored too; auth, storage, extensions,
migration metadata, `pcp_config`, and `permission_definitions` are outside that scope.
The public-table catalog must exactly match the fixture/exclusion partition.
Unclassified tables or changed excluded reference rows refuse rather than silently
carrying data forward. Checksums for all 72 public tables must match the cold
baseline before the transaction can commit. This does not isolate test files from
one another within a run, restore excluded non-public data, or repair schema drift.
Use `--reset` to diagnose schema-dependent failures.

Cleanup requires the **exact** `supabase_db_<integration-project>` container name,
recorded Docker ID, project label, running/unpaused state, and reserved DB port.
SQL executes inside that immutable container ID over an explicit local socket,
never via an inherited connection URL. `current_database() = 'postgres'` is also
required, but is only a typo guard: application stacks can share that SQL name.
The additional `_pcp_it.stack` row, installed only after a managed reset, must match
the project, full container ID, fingerprint, and random token **in the same
transaction** before cleanup. Missing or mismatching identity refuses; do not
create this marker by hand to force adoption.

The DB marker also records an in-progress run independently of schema readiness.
It is cleared only by that run after success; failures/interrupts preserve it and
the dirty database for investigation. `run.json` in the workdir is an additional
diagnostic during startup/reset, not an ownership lock. The next owner cleans on
acquire even when the previous run died without cleanup. Baseline SQL stays in the
private cache, integrity-checked against its recorded hash. Never copy a baseline
or state file from another stack.

A fingerprint covers migration/seed SQL, config, exclusions, and CLI version; a
mismatch refuses reuse with an explicit reset/stop instruction rather than silently
running against another branch's schema. It does not detect arbitrary SQL changes
made directly to the running database.

The harness takes project/port locks. A competing run or an occupied port prints
its owner when available and tells the caller to **wait and retry**, without stopping
that owner's stack. Run DB integration tests sparingly; prefer focused unit tests
while iterating. Unmanaged/legacy kept stacks are never automatically adopted.

State lives outside the repository at
`~/.cache/inkwell/integration-db/<project>`. `INTEGRATION_SUPABASE_CACHE_DIR` can
override the base. Locks remain machine-wide under `~/.cache/inkwell/integration-db-locks` regardless
of that override. A descendant process may keep a run's lock after its original
runner exits; the recorded runner PID is not necessarily the current holder.
The refusal prints `lsof -nP <lockfile>` to find the actual holders. Normally,
let them finish. For an orphan, verify its PID, command, and parent process first
(for example, `ps -p <pid> -o pid,ppid,command`). Only terminate that exact PID if
it is your own abandoned test process; otherwise ask its owner. Retry after all
holders exit. **Never delete the lock file or cache to clear a lock**, and never
kill by process-name pattern: deleting a locked inode can allow overlapping runs.

If the DB container disappears externally but other containers survive, `--stop`
can recover only when every survivor's name and ID matches the recorded ownership
snapshot. Reuse/reset refuses with that recovery instruction; stop, then rerun to
recreate the stack. Unknown or replaced containers remain unmanaged and are never
stopped by this harness. Use the original owner's workdir/cleanup command only
after verifying ownership; do not delete the state file to force adoption.

Existing `INTEGRATION_SUPABASE_*_PORT` overrides remain supported;
the six source config port fields must retain their repository defaults, or the
harness refuses before starting containers. Use the overrides rather than editing
`supabase/config.toml` to select integration ports.
Project IDs must be `pcp-integration` or `pcp-integration-<suffix>`. `--reuse` explicitly
selects retained mode (including in a CI-marked shell). The legacy
`INTEGRATION_KEEP_SUPABASE=1` with `--fresh` retains a temporary inspection stack;
release it with the printed `supabase stop --workdir ... --no-backup` command before
using the same project again. If that output is lost, inspect `pcp-supabase-it-*`
directories under `INTEGRATION_SUPABASE_WORKDIR_BASE` (or the system temp directory
when unset). Verify `supabase/config.toml` names your test project before selecting
a workdir; the prefix alone does not establish ownership.

## Key Technologies

- **Runtime**: Node.js 22 (`.nvmrc`; 20 is the floor set by the MCP SDK v2 packages), TypeScript, Yarn 4 workspaces
- **MCP SDK**: `@modelcontextprotocol/server` (v2) with `@modelcontextprotocol/node` for the HTTP transport
- **Database**: Supabase (PostgreSQL + pgvector)
- **Messaging**: Telegraf (Telegram), Baileys (WhatsApp)
- **CLI**: Commander.js, Ink (React for CLI)
