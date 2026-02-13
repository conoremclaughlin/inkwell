# Contributing to PCP

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

## Coding Style

- **camelCase** for variables and functions (acronyms treated as words: `userId`, `apiResponse`)
- **PascalCase** for classes and types (`HttpClient`, `UserIdentity`)
- **SCREAMING_SNAKE_CASE** for constants

### Formatting

Prettier runs automatically on every commit via Husky + lint-staged. You do **not** need to run prettier manually — just commit and it handles formatting for `*.{ts,tsx,js,jsx,json,css,md}` files.

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
