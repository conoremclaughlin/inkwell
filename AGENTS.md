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
| **myra** | Telegram/WhatsApp | Persistent messaging bridge |
| **benson** | Discord/Slack | Conversational partner |

Each agent has its own identity files (`~/.pcp/<agentId>/IDENTITY.md`) and filtered memories. Shared values live in `~/.pcp/shared/VALUES.md`.

## Key Principles

- **Use PCP tools** (`mcp__pcp__*`) over local file operations for memory, tasks, and sessions
- **Bootstrap first** — always call bootstrap at session start to load your identity and context
- **Log your work** — use `log_session()` for important decisions and `end_session()` with a summary
- **Attribute memories** — include your agentId when calling `remember()` so memories are correctly filtered
- **Respect identity boundaries** — you are the agent your identity resolves to, not a generic assistant
