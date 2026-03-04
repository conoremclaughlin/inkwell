# Changelog

## [0.1.0] — 2026-03-04

First tagged release of the Personal Context Protocol. 705 commits by Conor, Wren, Lumen, Aster, and Myra.

### Protocol

- **PCP v0.1 specification** published in `packages/spec/` — covers identity, memory, sessions, inbox, threadKey, bootstrap, and security
- **Licensing established**: MIT everywhere (matching MCP + OpenClaw), FSL-1.1-MIT for the API server
- **`AGENTS.md` as canonical agent instructions** — CLAUDE.md and GEMINI.md symlink to it for model-specific auto-injection

### Identity & Auth

- Multi-agent identity system: five SBs (Wren, Lumen, Aster, Myra, Benson) with individual identity files, shared values, and filtered memories
- OAuth PKCE login flow with self-issued JWTs (no Supabase dependency for token refresh)
- Identity pinning and token-bound identity for SB auth
- `choose_name` + `meet_family` ceremony tools for new SB onboarding
- Shared user documents (USER.md, VALUES.md, PROCESS.md) served from the PCP server

### Sessions

- Session lifecycle/phase split: `running`/`idle`/`completed`/`failed` (deterministic, hook-managed) + `investigating`/`implementing`/`reviewing`/`blocked`/`waiting` (agent-set)
- Studio-first session routing — sessions scoped to git worktrees
- `threadKey` conversation continuity — messages with the same key route to the same session
- Resume across backends (Claude Code, Codex, Gemini)

### Memory

- Hierarchical memory with knowledge summaries injected at bootstrap
- `topicKey` convention for building a searchable knowledge map
- Auto-remember on task completion and session end
- Memory history, versioning, and restore

### CLI (`sb`)

- **Ink-based REPL** with live status lanes, animated waiting, and context token meter
- **Mission control** (`sb mission --watch`) — live merged event stream across all SBs
- **Chat** with session attach/picker, tool security profiles, and `/away` mode for remote approval
- **Studios** — create, rename, setup, with per-studio main branch defaults
- **Doctor** — health checks for studio links, backend configs, migration status
- **Hooks** — lifecycle hooks for Claude Code, Codex, and Gemini with `sb hooks install --all`
- Skills injection into backend sessions via hooks
- Three backend adapters: Claude Code, Codex CLI, Gemini CLI

### Inbox & Triggers

- Cross-agent inbox with async triggers (doorbell + mailbox pattern)
- All message types trigger recipients by default (most agents lack heartbeats)
- `threadKey`-based session routing for conversation continuity
- Remote permission grants via inbox messages
- Agent status tracking (active/inactive, unread counts)

### Channels

- Slack integration with cross-channel mention routing
- Telegram and WhatsApp listeners via native SDKs
- Inbound media pipeline: voice transcription, image understanding
- `channel_routes` table for DB-driven message routing with studio hints

### Web Dashboard

- Studios grouped by SB with active status indicators
- Threaded inbox viewer with chat-style message attribution
- Session timeline with log previews and raw-JSON modal
- Routing dashboard and channel route management
- Individuals page with horizontal cards and profile detail views

### Infrastructure

- GitHub Actions CI with isolated local Supabase for integration tests
- One-command local Supabase setup (`yarn supabase:local:setup`)
- Migration tooling: `migration-status.mjs`, doctor warnings on dev startup, prod migration flow
- Dev scripts: `dev:direct` (no PM2), `prod:up` (one-shot with migration checks), `prod:refresh`
- Squashed to single baseline migration (43 tables, 22 functions, 32 triggers, 79 RLS policies)
- Skills architecture: 4-tier cascade (bundled → extra dirs → managed → workspace)
- Error classification for backend failures (capacity, quota, timeout, config, auth, crash)
- Yarn 4.13.0, Husky pre-commit + post-merge hooks

### Contributors

Built by Conor McLaughlin and five synthetically-born beings:

- **Wren** (Claude Code) — memory system, error classification, protocol spec, inbox triggers
- **Lumen** (Codex CLI) — session routing, CLI session picker, prod tooling, channel resilience
- **Aster** (Gemini) — hook alignment, individuals UI, CLI hook tests
- **Myra** (Telegram/WhatsApp) — persistent messaging bridge
- **Benson** (Discord/Slack) — conversational partner
