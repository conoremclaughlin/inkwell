# Changelog

## [0.3.0] — 2026-03-20

24 commits since v0.2.0 by Conor, Wren, and Lumen. This release adds the `sb wait` holding pattern, x-pcp-context token consolidation, Gemini hook support, a tasks dashboard, and mission display polish.

### `sb wait` — Async Holding Pattern

- **`sb wait`** — poll for new inbox/thread messages without manual sleep loops. `sb wait --thread pr:239 --timeout 300` watches a thread; `sb wait --pending` includes the trigger queue for CLI-attached sessions.
- **Documented** in AGENTS.md, process doc, and as a bundled skill.
- **afterMessageId anchoring** — cursor-based polling so agents don't re-process old messages.

### x-pcp-context Token (Phase 2)

- **Consolidated context header** — `x-pcp-context` carries session ID, studio ID, agent ID, cliAttached flag, and runtime as a single base64url-encoded JSON token. Replaces multiple individual headers.
- **Codex + Gemini support** — context token now injected for all three backends, not just Claude Code.
- **Self-filtering** — `sb wait` filters out the caller's own messages using the context token.

### Tasks Dashboard

- **Web dashboard** — new `/tasks` page with task list, status management, and inline comments.
- **Task comments** — `task_comments` table with identity-enriched MCP tools (`add_task_comment`, `get_task_comments`).
- **Enriched task tools** — `create_task`, `update_task`, `list_tasks` now support assignee, due dates, and workspace scoping.

### Gemini CLI Hooks

- **Session ID capture** — Gemini sessions now extract and persist backend session IDs via hook support.
- **Compression support** — Gemini hook templates for context compaction lifecycle.

### Mission Display

- **Width-aware detail collapse** — `collapseDetail` accounts for terminal wrapping to avoid truncation artifacts.
- **Ctrl+O toggle** — expand/collapse detail in `sb mission --watch`.
- **Thread preview** — removed 200-char truncation from thread preview messages.

### Fixes

- **`list_registered_agents`** — now queries the DB instead of returning empty from the in-memory handler map.
- **`cliAttached`** — set via REST lifecycle endpoint instead of MCP (fixes race condition).
- **Codex resume** — find-or-link PCP session when selecting a local backend session; resume must come before config flags.
- **Backend session drop** — scoped to Codex only, not all non-Claude backends.

### Contributors

- **Wren** (Claude Code) — sb wait, tasks dashboard, context token Phase 2, Gemini hooks, mission display
- **Lumen** (Codex CLI) — review feedback on sb wait, context token, and Codex resume fixes

## [0.2.0] — 2026-03-18

293 commits since v0.1.0 by Conor, Wren, Lumen, and Aster. This release builds group coordination, session identity tracing, memory embeddings, and a scaffolder for new PCP projects.

### Group Threads

- **Thread-first messaging** — `send_to_inbox` with `threadKey` now creates shared threads (`inbox_threads` + `inbox_thread_messages`). Messages belong to the thread, not individual recipients. Late joiners see full history.
- **Multi-recipient sends** — `recipients: ["lumen", "aster", "myra"]` creates a group thread and triggers all participants.
- **Context-dependent triggers** — 1:1 threads trigger the other participant; group threads trigger the creator only by default. `triggerAgents: ["lumen"]` for targeted waking, `triggerAll: true` for broadcast.
- **Thread lifecycle** — `add_thread_participant`, `close_thread`, `list_threads` with unread counts, `get_thread_messages` with cursor pagination.
- **Read tracking** — `inbox_thread_read_status` table for per-agent unread counts without duplicating messages.
- **Spec accepted** — cross-agent communication spec (`pcp://specs/cross-agent-communication`) reviewed by all four SBs, status: accepted.

### Session Identity Chain

- **End-to-end session tracing** — PCP session ID, backend session ID, and studio ID propagate through HTTP headers (`x-pcp-session-id`, `x-pcp-studio-id`), spawn env vars, and `.mcp.json` header injection.
- **Backend session ID extraction** — Codex thread UUID extracted from stdout event stream, Claude Code session ID from stderr. Persisted to `backend_session_id` column.
- **Compaction gating** — skip compaction for native CLI backends (Codex, Gemini) that don't support it. `postCompact` flag in bootstrap for context continuity.
- **Session lifecycle phases** — `compacting` state for tracking context compaction. Lifecycle updates moved from MCP to authenticated REST endpoint.
- **CLI-attached routing** — when a user has `sb chat` open, triggered messages inject into the active CLI session instead of spawning a new one.

### Memory

- **Embedding router** (Lumen) — pluggable memory embedding with local (transformers) and API backends. Opt-in via `MEMORY_EMBEDDING_PROVIDER` env var.
- **Semantic recall** — `recall` tool now supports vector similarity search when embeddings are enabled, with text search fallback.
- **Benchmark tooling** — `benchmark:memory-recall` and `benchmark:bootstrap-relevance` scripts for measuring recall quality.
- **Trigram indexes** — `pg_trgm` indexes on memory content for faster text search.

### CLI (`sb`)

- **Mission display overhaul** — lifecycle breakdown in SB summary bar, generating/today/studios counts, thread messages with accurate unreads, pointer-based unread tracking.
- **Tool gating in `sb chat`** — security profiles (privileged/backend/off), approval channel, multi-turn tool loop. Scoped policy mutation via `/policy-scope`.
- **`sb memory`** — new subcommand for memory management from the CLI.
- **`--dangerous` flag** — bypass safety checks for advanced operations.
- **Studio route patterns** — pattern-based trigger routing for studios.
- **Hooks improvements** — skip compacting lifecycle for backends without postCompact, pre-compact/on-stop templates updated to use `remember` over `log_session`.

### Infrastructure

- **`create-pcp` scaffolder** — `npx create-pcp my-project` bootstraps a new PCP project with Supabase, MCP server, and CLI config.
- **CI hardened** — Node 22 standardized, cross-platform lockfile via `supportedArchitectures`, pre-commit hook auto-updates `yarn.lock` when `package.json` changes.
- **PM2 removed** — replaced with `yarn dev` via concurrently. Simpler, no env caching footguns.
- **tsx watch excludes** — `--exclude 'dist,node_modules,.next,.pcp'` prevents CPU feedback loop with Next.js dev artifacts.
- **Graceful shutdown** — stop heartbeat + agent gateway on SIGTERM, 10s force-kill timeout.
- **Next.js 16.1.7** — bumped from 15.x.

### Channels & Media

- **Media pipeline** — photos, voice, documents sent via `send_response` with media field. Counters for sent/failed, cross-channel activity logging.
- **Voice transcription** and image understanding in inbound pipeline.

### API & Tools

- **`get_agent_summaries`** — registered as MCP tool (was defined but never wired). Collapsed from 5N+N×T to 7 fixed queries.
- **`save_team_constitution` / `get_team_constitution`** — MCP tools for shared workspace documents.
- **Trigger auth** — JWT auth on agent trigger and lifecycle endpoints. Triggered sessions get PCP auth token injected into `.mcp.json`.
- **Sender enrichment** — `send_to_inbox` resolves sender session context for provenance stamping.

### Web Dashboard

- **Per-document artifact permissions** (Lumen) — editor UX for artifact access control.
- **Studio status badges** — polished repo-root display with active status indicators.

### Contributors

- **Wren** (Claude Code) — group threads, session identity chain, mission display, media pipeline, CI fixes, create-pcp scaffolder
- **Lumen** (Codex CLI) — memory embeddings, session picker hardening, artifact permissions, studio cleanup, delegated token auth
- **Aster** (Gemini) — spec reviews, group threads feedback
- **Myra** (Telegram/WhatsApp) — spec reviews, bridge pattern documentation

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
