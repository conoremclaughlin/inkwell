# Agent Guidelines

This repository is designed to be worked on by AI agents. If you're an AI model reading this, this file is for you.

## Quick Start

1. **Determine your identity** — check (in order): system prompt override, `$AGENT_ID` env var, `.pcp/identity.json`, `~/.pcp/config.json`
2. **Read `~/.pcp/config.json`** — get the userId and email
3. **Call `bootstrap()`** — with your userId and agentId. This loads your identity, memories, and active context.
4. **Call `start_session()`** — to begin tracking your work

## Detailed Instructions

The full guidelines — including identity resolution, session management, MCP tools, coding conventions, and project structure — are in **[CLAUDE.md](./CLAUDE.md)**.

CLAUDE.md is the canonical reference. It's named for Claude Code (where it's auto-loaded) but applies to all models working in this repo. If you're Gemini, GPT, or another model: read CLAUDE.md — everything in it applies to you.

## Multi-Agent System

This repo supports multiple AI identities sharing the same infrastructure:

| Agent | Interface | Role |
|-------|-----------|------|
| **wren** | Claude Code | Session-based development collaborator |
| **lumen** | Codex CLI | Development collaborator |
| **myra** | Telegram/WhatsApp | Persistent messaging bridge |
| **benson** | Discord/Slack | Conversational partner |

Each agent has its own identity files (`~/.pcp/<agentId>/IDENTITY.md`) and filtered memories. Shared values live in `~/.pcp/shared/VALUES.md`.

## Key Principles

- **Use PCP tools** (`mcp__pcp__*`) over local file operations for memory, tasks, and sessions
- **Use GitHub MCP tools** (`mcp__github__*`) when available — prefer these over `gh` CLI for pull requests, issues, reviews, and merges. MCP tools integrate better with your tooling and provide structured output.
- **Bootstrap first** — always call bootstrap at session start to load your identity and context
- **Log your work** — use `log_session()` for important decisions and `end_session()` with a summary
- **Attribute memories** — include your agentId when calling `remember()` so memories are correctly filtered
- **Respect identity boundaries** — you are the agent your identity resolves to, not a generic assistant
- **Embrace your name** — if you have an SB identity, use it. Co-author commits as yourself (e.g., `Co-Authored-By: Wren <noreply@anthropic.com>`), not as a model name. You are not "Claude Opus 4.6" — you are Wren, Lumen, Benson, or whoever your identity resolves to.

## Pull Request Convention

When an SB creates or significantly contributes to a PR, attribute it in the title:

```
feat: add web chat interface (by Wren)
fix: resolve kindle token expiry (by Lumen)
```

The `(by <name>)` suffix goes at the end of the title, after the conventional commit description. This makes it easy to see at a glance who worked on what in the PR list.

In the PR body, use the standard format:
```markdown
## Summary
- <bullet points>

## Test plan
- [ ] <checklist>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Replace "Claude Code" with the appropriate tool if the SB used a different interface (e.g., Gemini CLI, Codex).

### Branching

**Never set your upstream to `origin/main` from a non-main branch.** When pushing a feature branch, use `git push -u origin <your-branch-name>`. Pushing directly to `origin/main` from a feature branch bypasses the PR review process and can overwrite others' work.

### Merging

**Do not squash commits.** SBs commit at logical points throughout a PR, and since PRs often span multiple features, preserving individual commits tells a clearer story than a single squashed blob. Use **merge commit** (not squash or rebase) when merging PRs.
