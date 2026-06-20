# Architecture

## Overview

Inkwell is a unified server that provides persistent context, memory, and identity for AI agents across multiple interfaces. A single process orchestrates MCP tools, channel listeners (Telegram, WhatsApp), session management, and scheduled tasks.

## System Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        USER INTERFACES                           │
├──────────────┬──────────────┬──────────────┬─────────────────────┤
│  Claude Code │   Telegram   │   WhatsApp   │   Ink CLI (ink)       │
│  (MCP/HTTP)  │  (Telegraf)  │  (Baileys)   │  (spawns Claude)    │
└──────┬───────┴──────┬───────┴──────┬───────┴──────────┬──────────┘
       │              │              │                   │
       │              └──────┬───────┘                   │
       │                     │                           │
       ▼                     ▼                           ▼
┌─────────────┐   ┌──────────────────┐         ┌──────────────┐
│  MCP Server │   │  Channel Gateway │         │ Identity     │
│  (HTTP/SSE) │   │  (Listeners)     │         │ Injection    │
└──────┬──────┘   └────────┬─────────┘         │ (system      │
       │                   │                   │  prompt)     │
       │                   ▼                   └──────┬───────┘
       │          ┌──────────────────┐                │
       │          │  Session Service │◄───────────────┘
       │          │  (Stateless)     │
       │          └────────┬─────────┘
       │                   │
       ▼                   ▼
┌─────────────────────────────────────┐
│         MCP Tool Handlers           │
│  (memory, tasks, sessions, links,   │
│   inbox, calendar, email, skills)   │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│     Supabase (PostgreSQL)           │
│     + pgvector + RLS                │
└─────────────────────────────────────┘
```

## Core Components

### Inkwell Server (`src/server.ts`)

The unified entry point. Starts all components in order:

1. DataComposer (Supabase connection)
2. SessionService (stateless message processor)
3. MCP Server with ChannelGateway (HTTP on port 3001)
4. Heartbeat service (scheduled reminders)
5. Agent trigger handler

Runs as a single Node.js process.

### MCP Server (`src/mcp/server.ts`)

Exposes Inkwell tools over HTTP/SSE at `http://localhost:3001/mcp`. Each client connection gets its own `McpServer + StreamableHTTPServerTransport` pair, managed in a session map.

Additional HTTP endpoints:

- `/health` — service health check
- OAuth2 endpoints (`/authorize`, `/token`, `/register`)

### Channel Gateway (`src/channels/gateway.ts`)

Manages messaging integrations. Currently supports:

- **TelegramListener** — polling-based via Telegraf
- **WhatsAppListener** — WhatsApp Web via Baileys

Messages are optionally buffered (default 2s for grouping related messages), then routed to SessionService. Responses from agents are routed back to the originating channel.

### Session Service (`src/services/sessions/session-service.ts`)

Stateless, horizontally scalable message processor. All state lives in the database.

**Processing flow:**

1. Get or create session from DB
2. Acquire processing lock (per agent+session)
3. If locked, queue the message (FIFO)
4. Process via ClaudeRunner (Claude API with context)
5. Execute MCP tool calls from the response
6. Route responses through ChannelGateway
7. Release lock, process next queued message

**Key property:** Processing locks prevent race conditions when the same session receives concurrent messages.

### Heartbeat Service (`src/services/heartbeat.ts`)

Processes scheduled reminders on a cron interval (default: every 5 minutes).

1. Query DB for due reminders (`next_run_at <= now`, `status = 'active'`)
2. Check quiet hours
3. Deliver via SessionService (treated as an agent-channel message)
4. Update state: increment `run_count`, calculate next `next_run_at`, or mark completed

Reminders flow through the same SessionService pathway as user messages — the agent processes the reminder context and responds naturally.

### Agent Gateway (`src/channels/agent-gateway.ts`)

Handles inter-agent communication. When agent A triggers agent B:

1. `send_to_inbox` stores the message in `agent_inbox` table
2. `trigger_agent` HTTP POSTs to `/api/agent/trigger`
3. AgentGateway dispatches to the target agent's handler
4. Default handler builds a trigger message and calls SessionService

## Data Flow

### Claude Code → MCP Tools

```
Claude Code → HTTP POST /mcp (OAuth2 token) → MCP Server
  → Tool call dispatched → Handler executes → Supabase query
  → Result returned → Claude processes response
```

### Telegram/WhatsApp → Agent Response

```
User message → Listener → Buffer → ChannelGateway
  → SessionService.handleMessage() → Acquire lock
  → ClaudeRunner (Claude API) → MCP tool calls executed
  → send_response captured → ChannelGateway → User
```

### Agent Trigger (e.g., Wren → Myra)

```
Wren calls send_to_inbox() + trigger: true
  → Message saved in agent_inbox
  → HTTP POST /api/agent/trigger
  → AgentGateway → SessionService.handleMessage(agentId='myra')
  → Myra processes, responds via ChannelGateway
```

### SB CLI → Claude Code (direct backend)

```
sb "fix the bug" → Identity injection (--append-system-prompt)
  → Spawns claude with Inkwell identity + MCP config
  → Claude Code connects to MCP server at localhost:3001
  → Agent bootstraps, remembers who it is
  → Full native tools: Read, Edit, Write, Bash, MCP
```

### Ink Backend → Local Tool Routing (Myra, Benson)

````
InkRunner → ink chat --non-interactive --approval-mode auto-approve
  → ink CLI spawns Claude Code with --allowedTools '' (tools OFF)
  → LLM generates text with ```ink-tool blocks
  → ink CLI extracts + executes via PCP server HTTP
  → Results injected as context → next LLM turn
  → No filesystem access, Inkwell tools only
````

## Multi-Agent Identity

Six agents share the same infrastructure with distinct identities, backends, and filtered memories:

| Agent      | Interface              | Backend     | Provider    | Nature                                 |
| ---------- | ---------------------- | ----------- | ----------- | -------------------------------------- |
| **Wren**   | Claude Code (via `sb`) | claude-code | claude-code | Session-based development collaborator |
| **Lumen**  | Codex CLI              | codex       | codex       | Development collaborator               |
| **Aster**  | Gemini CLI             | gemini      | gemini      | Development collaborator               |
| **Myra**   | Telegram / WhatsApp    | ink         | claude-code | Persistent messaging bridge            |
| **Benson** | Discord / Slack        | claude      | claude      | Conversational partner                 |
| **Echo**   | (test only)            | —           | —           | Integration test agent                 |

Identity is resolved from: system prompt override → `$AGENT_ID` env var → `.ink/identity.json` → `~/.ink/config.json`. Identity documents (SOUL, HEARTBEAT, IDENTITY) live in the database (`agent_identities` table), with `~/.ink/` as a fallback cache. Memories are filtered by agentId (plus shared memories where `agentId` is null).

## MCP Tools

60+ tools organized by domain:

| Domain                   | Tools                                                               |
| ------------------------ | ------------------------------------------------------------------- |
| **Bootstrap & Sessions** | `bootstrap`, `update_session_state`, `get_session`, `list_sessions` |
| **Memory**               | `remember`, `recall`, `forget`, `update_memory`, history/restore    |
| **Context & Projects**   | `save_context`, `get_context`, `save_project`                       |
| **Communication**        | `send_response`, `send_to_inbox`, `trigger_agent`                   |
| **Data**                 | `save_link`, `create_task`, `create_reminder`, calendar, email      |
| **Identity**             | `save_identity`, `get_identity`, permissions, audit log             |
| **Skills**               | `list_skills`, `publish_skill`, `fork_skill`                        |
| **Artifacts**            | `create_artifact`, `update_artifact` (versioned shared docs)        |
| **Workspaces**           | `create_workspace`, `list_workspaces`, `adopt_workspace`            |

## Data Layer

**Database:** Supabase PostgreSQL with pgvector for semantic search and Row Level Security for data isolation.

**Repository pattern** via DataComposer (`src/data/composer.ts`):

- Users, Links, Notes, Tasks, Reminders
- Conversations, Context, Projects
- Memory (with semantic search), Sessions
- Activity Stream, Workspaces

## Security

- **Application-level auth** is the primary security boundary — the API server validates JWTs, resolves Inkwell users, and scopes all queries. See [AGENTS.md Security section](./AGENTS.md#security-critical) for the full model.
- **Service role key** (`SUPABASE_SECRET_KEY`) used server-side only — bypasses RLS entirely. Must never be exposed to the client.
- **Frontend uses Supabase for auth only** — no direct database queries. All data access goes through API routes.
- **Row Level Security (RLS)** is enabled on most tables but is not our primary defense. The `auth.uid()` policies are non-functional (Inkwell user IDs differ from Supabase Auth UIDs). Some tables have permissive service policies as a safety net.
- **OAuth2 token auth** for MCP connections (with refresh token support via `mcp_tokens` table)
- **Permissions system** — per-user toggles for sensitive operations (web search, bash, etc.)
- **Audit logging** — tracks sensitive operations with full context
- **Server-side Supabase clients must use `persistSession: false`** to prevent auth state leakage between requests

## Process Management

`yarn dev` runs both services concurrently with hot reload via `scripts/dev-concurrently.mjs`. Port allocation is driven by `INK_PORT_BASE` (default 3001):

| Service | Port              | Description                                             |
| ------- | ----------------- | ------------------------------------------------------- |
| API/MCP | `INK_PORT_BASE`   | Main server: MCP + channels + heartbeat + agent gateway |
| Web     | `INK_PORT_BASE+1` | Next.js admin dashboard                                 |
| Myra    | `INK_PORT_BASE+2` | Persistent messaging bridge                             |

For production, use `yarn prod:direct` or Docker Compose (`docker-compose.app.yml`).

## Session Runners and Tool Routing (2026-06-15)

The server supports multiple runtime backends. Each agent's `backend` and `provider` columns in `agent_identities` determine which runner and LLM are used.

### Runner Selection

| Backend value | Runner         | What it spawns        | Tool access                             |
| ------------- | -------------- | --------------------- | --------------------------------------- |
| `claude-code` | `ClaudeRunner` | `claude` CLI directly | Native CC tools (Read, Edit, Bash, MCP) |
| `codex-cli`   | `CodexRunner`  | `codex` CLI directly  | Native Codex tools                      |
| `gemini`      | `GeminiRunner` | `gemini` CLI directly | Native Gemini tools                     |
| `ink`         | `InkRunner`    | `ink chat` CLI        | Ink local tool routing (see below)      |

The `provider` column (separate from `backend`) determines which LLM model family is used. For `ink` backend sessions, `provider` selects the underlying CLI (e.g., `provider: 'claude-code'` means `ink chat` spawns Claude Code as its LLM).

### Current Agent Configuration

| Agent  | Backend     | Provider    | sandbox_bypass |
| ------ | ----------- | ----------- | -------------- |
| wren   | claude-code | claude-code | false          |
| myra   | ink         | claude-code | false          |
| lumen  | codex       | codex       | true           |
| benson | claude      | claude      | false          |
| aster  | gemini      | gemini      | false          |

### Ink Backend: Local Tool Routing

When `backend = 'ink'`, the session flows through the ink CLI's local tool routing architecture:

````
InkRunner spawns: ink chat --non-interactive --approval-mode auto-approve
  └─ ink CLI sets toolRouting: 'local' (default)
     └─ Spawns Claude Code with --allowedTools '' (EMPTY — all native tools disabled)
     └─ LLM generates text with fenced ink-tool blocks:
        ```ink-tool
        {"tool":"recall","args":{"query":"..."}}
        ```
     └─ ink CLI extracts blocks, executes via PCP server HTTP
     └─ Results fed back as context for next LLM turn
     └─ Loop repeats (max 5 iterations) until no tool blocks emitted
````

**Key implications:**

- Claude Code's native tools (Read, Edit, Write, Bash, Agent, etc.) are **completely disabled** via `--allowedTools ''`
- The LLM is a pure text generator — no filesystem access, no shell execution
- Available tools are Inkwell MCP tools only: `recall`, `remember`, `send_response`, `get_inbox`, etc.
- `.claude/settings.local.json` permissions are **irrelevant** — the empty allowlist overrides everything
- Tool policy and approval happen at the ink CLI layer, not Claude Code's permission system

### Tool Policy & Profiles

The ink CLI enforces a tool policy system (`ToolPolicyState`) that controls which tools agents can call. Profiles are predefined policy configurations applied via `--profile <name>`:

| Profile         | Mode       | Behavior                                                                 |
| --------------- | ---------- | ------------------------------------------------------------------------ |
| `minimal`       | backend    | Read-only. `group:read` allowed, comms/writes denied. Allowlist narrows. |
| `safe`          | backend    | All tools allowed except comms and writes, which require 2FA approval.   |
| `collaborative` | backend    | Everything allowed. No prompts, no restrictions.                         |
| `full`          | privileged | All tools allowed, policy bypassed entirely.                             |

**Policy decision flow** (`canCallPcpTool`):

1. Deny list → blocked (not promptable)
2. Privileged mode → allowed
3. Session grant → allowed
4. Scoped grant → allowed (one-time use, decrements)
5. Prompt list → blocked, promptable (2FA path)
6. Allow-list narrowing → if allowTools is non-empty and tool isn't in it, blocked+promptable
7. Default → allowed

**Key design property:** `safeTools` (DEFAULT_SAFE_PCP_TOOLS) do NOT create narrowing. Only explicit `allowTools` entries create a whitelist filter. This means profiles like `safe` that have empty `allowSpecs` allow all MCP tools by default — only `promptSpecs` gates specific tools.

**Tool groups** define logical sets expanded at policy application time:

| Group               | Tools                                                  |
| ------------------- | ------------------------------------------------------ |
| `group:ink-safe`    | bootstrap, recall, get_inbox, list_sessions, etc.      |
| `group:ink-comms`   | send_to_inbox, trigger_agent, send_response            |
| `group:ink-memory`  | remember, recall, forget, update_memory, etc.          |
| `group:ink-session` | start_session, update_session_state, end_session, etc. |
| `group:read`        | read, grep, find, ls                                   |
| `group:write`       | edit, write, bash                                      |

InkRunner spawns with `--profile safe --away`, meaning server-spawned agents can read freely, call MCP tools, but must get human approval for file writes and cross-agent communication.

### Tool Approval (2FA)

The ink CLI has a multi-tier approval system for tool calls:

1. **Interactive mode** — TUI prompt when a human is at the terminal
2. **JSONL mode** — Structured protocol for programmatic integrations: `approval_request` on stderr, `approval_response` on stdin
3. **Remote 2FA (away mode)** — Server-routed approval via connected platforms (Telegram, WhatsApp)

#### 2FA Architecture

When `--away` is set, tool calls requiring approval trigger a server-side 2FA flow:

```
Agent calls tool → canCallPcpTool returns promptable
  → CLI creates approval_requests DB record via POST /api/admin/approval-requests
    → Server calls notifyPlatformOfApprovalRequest()
      → Looks up user's trusted_users (Telegram, WhatsApp)
      → Sends formatted notification directly via Telegram Bot API
      → Stores telegramMessageId in request metadata (for reply-to threading)
  → CLI polls GET /api/admin/approval-requests/:requestId/status (every 3s, 5min timeout)
  → User replies on Telegram: "approve" / "deny" / "approve session"
    → approval-interceptor.ts catches reply BEFORE agent routing
      → Matches against pending approval_requests by user + reply-to thread
      → Updates DB: status, action, granted_tools, granted_by, resolved_at
      → Sends ack emoji back to user
  → CLI poll picks up resolution → tool allowed or denied
```

**Security properties:**

- `permission_grant` messages can ONLY originate from the system layer (verified platform identity). Agents cannot forge grants — enforced in `inbox-handlers.ts`.
- No HTTP endpoint for grant resolution — prevents client-side spoofing.
- Optimistic lock on DB updates — prevents double-approval races.
- The approval interceptor runs BEFORE agent routing — the user's "approve" reply never reaches the agent.
- Fails closed: any error during creation or polling results in denial.

**Key files:**

- `packages/cli/src/repl/approval-api.ts` — Shared HTTP client for create + poll
- `packages/api/src/channels/approval-interceptor.ts` — Platform response interception
- `supabase/migrations/20260416232802_approval_requests.sql` — DB schema
- `packages/api/src/routes/admin.ts` — REST endpoints for approval lifecycle
- `packages/cli/src/commands/hooks.ts` — PreToolUse hook (Claude Code integration)
- `packages/cli/src/repl/permission-grant.ts` — Grant payload structure and application

### Model Override

Default model for spawned sessions is controlled by env vars in `.env.local`:

```
DEFAULT_CLAUDE_MODEL=claude-opus-4-6    # Claude Code / ink+claude sessions
DEFAULT_CODEX_MODEL=...                  # Codex sessions
DEFAULT_GEMINI_MODEL=...                 # Gemini sessions
```

When set, these flow through `SessionServiceConfig` → runner config → `--model` flag on the spawned CLI process. When unset, the CLI uses its own default (which can change without warning — set explicitly for stability).

### Pi Coding Tools (2026-06-16)

The ink CLI integrates [@mariozechner/pi-coding-agent](https://github.com/badlogic/pi-mono)'s coding tools in-process, giving ink-backend agents filesystem access through the same local tool routing layer used for Inkwell tools.

````
LLM emits: ```ink-tool {"tool":"read","args":{"path":"src/server.ts"}} ```
  → ink CLI extracts ink-tool block
  → isPiTool("read") → true
  → callPiTool("read", args, cwd) → Pi tool executes in-process
  → Result injected as context → next LLM turn
````

**Available coding tools** (from Pi, scoped to working directory):

| Tool    | What it does                                             |
| ------- | -------------------------------------------------------- |
| `read`  | Read file with offset/limit, line numbers, truncation    |
| `edit`  | Find-and-replace with conflict detection and diff output |
| `write` | Create/overwrite file with directory creation            |
| `bash`  | Execute shell command with timeout and output truncation |
| `grep`  | Search file contents with regex and context lines        |
| `find`  | Find files by pattern, gitignore-aware                   |
| `ls`    | List directory with file sizes and depth control         |

Pi tools are initialized lazily per working directory via `createReadTool(cwd)`, `createEditTool(cwd)`, etc. The tool policy and 2FA approval flow still applies — Pi tools flow through the same `executeToolCalls` pipeline as Inkwell tools.

**Design decision:** Import Pi's tool implementations rather than reimplementing. Pi's tools are battle-tested in OpenClaw production with edge-case handling (encoding detection, binary safety, diff formatting, symlink guards) that would take significant effort to replicate. We only use the tool layer — not Pi's agent loop, session management, or LLM abstraction.

## Key Design Decisions

1. **Stateless SessionService** — All state in the database. Processing locks prevent races. Enables horizontal scaling.
2. **Unified server** — One process handles MCP, channels, heartbeat, and triggers. Simpler ops, shared state.
3. **MCP as the API** — All agent capabilities exposed as MCP tools. Works with any MCP client.
4. **Channel-agnostic routing** — SessionService doesn't know about Telegram/WhatsApp. ChannelGateway handles routing.
5. **Heartbeat via SessionService** — Reminders are just messages. Same processing pipeline, same agent capabilities.
6. **Identity injection** — The `sb` CLI injects identity via system prompt. The agent bootstraps from there.
7. **Local tool routing as default for ink backend** — (2026-06-15) The ink CLI intercepts tool calls at its own layer rather than delegating to the underlying LLM CLI's native tools. This gives the ink CLI control over approval, policy, credential injection, and tool execution.
8. **Pi coding tools over reimplementation** — (2026-06-16) Rather than building filesystem tools from scratch, the ink CLI imports Pi's battle-tested tool implementations in-process. Same local tool routing, different executor for coding tools vs Inkwell tools. Leverages others' effort for the subtleties of code editing (diff formatting, truncation, encoding detection).
