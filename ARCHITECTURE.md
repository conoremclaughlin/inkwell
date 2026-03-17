# Architecture

## Overview

PCP is a unified server that provides persistent context, memory, and identity for AI agents across multiple interfaces. A single process orchestrates MCP tools, channel listeners (Telegram, WhatsApp), session management, and scheduled tasks.

## System Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        USER INTERFACES                           │
├──────────────┬──────────────┬──────────────┬─────────────────────┤
│  Claude Code │   Telegram   │   WhatsApp   │   SB CLI (sb)       │
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

### PCP Server (`src/server.ts`)

The unified entry point. Starts all components in order:

1. DataComposer (Supabase connection)
2. SessionService (stateless message processor)
3. MCP Server with ChannelGateway (HTTP on port 3001)
4. Heartbeat service (scheduled reminders)
5. Agent trigger handler

Runs as a single Node.js process.

### MCP Server (`src/mcp/server.ts`)

Exposes PCP tools over HTTP/SSE at `http://localhost:3001/mcp`. Each client connection gets its own `McpServer + StreamableHTTPServerTransport` pair, managed in a session map.

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

### SB CLI → Claude Code

```
sb "fix the bug" → Identity injection (--append-system-prompt)
  → Spawns claude with PCP identity + MCP config
  → Claude Code connects to MCP server at localhost:3001
  → Agent bootstraps, remembers who it is
```

## Multi-Agent Identity

Three agents share the same infrastructure with distinct identities and filtered memories:

| Agent      | Interface              | Nature                                 |
| ---------- | ---------------------- | -------------------------------------- |
| **Wren**   | Claude Code (via `sb`) | Session-based development collaborator |
| **Myra**   | Telegram / WhatsApp    | Persistent messaging bridge            |
| **Benson** | Discord / Slack        | Conversational partner                 |

Identity is resolved from: system prompt override → `$AGENT_ID` env var → `.pcp/identity.json` → `~/.pcp/config.json`. Each agent has identity files at `~/.pcp/<agentId>/` and memories filtered by agentId.

## MCP Tools

60+ tools organized by domain:

| Domain                   | Tools                                                               |
| ------------------------ | ------------------------------------------------------------------- |
| **Bootstrap & Sessions** | `bootstrap`, `update_session_phase`, `get_session`, `list_sessions` |
| **Memory**               | `remember`, `recall`, `forget`, `update_memory`, history/restore    |
| **Context & Projects**   | `save_context`, `get_context`, `save_project`, `set_focus`          |
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

- **Application-level auth** is the primary security boundary — the API server validates JWTs, resolves PCP users, and scopes all queries. See [AGENTS.md Security section](./AGENTS.md#security-critical) for the full model.
- **Service role key** (`SUPABASE_SECRET_KEY`) used server-side only — bypasses RLS entirely. Must never be exposed to the client.
- **Frontend uses Supabase for auth only** — no direct database queries. All data access goes through API routes.
- **Row Level Security (RLS)** is enabled on most tables but is not our primary defense. The `auth.uid()` policies are non-functional (PCP user IDs differ from Supabase Auth UIDs). Some tables have permissive service policies as a safety net.
- **OAuth2 token auth** for MCP connections (with refresh token support via `mcp_tokens` table)
- **Permissions system** — per-user toggles for sensitive operations (web search, bash, etc.)
- **Audit logging** — tracks sensitive operations with full context
- **Server-side Supabase clients must use `persistSession: false`** to prevent auth state leakage between requests

## Process Management

`yarn dev` runs both services concurrently with hot reload via `scripts/dev-concurrently.mjs`. Port allocation is driven by `PCP_PORT_BASE` (default 3001):

| Service | Port              | Description                                             |
| ------- | ----------------- | ------------------------------------------------------- |
| API/MCP | `PCP_PORT_BASE`   | Main server: MCP + channels + heartbeat + agent gateway |
| Web     | `PCP_PORT_BASE+1` | Next.js admin dashboard                                 |
| Myra    | `PCP_PORT_BASE+2` | Persistent messaging bridge                             |

For production, use `yarn prod:direct` or Docker Compose (`docker-compose.app.yml`).

## Key Design Decisions

1. **Stateless SessionService** — All state in the database. Processing locks prevent races. Enables horizontal scaling.
2. **Unified server** — One process handles MCP, channels, heartbeat, and triggers. Simpler ops, shared state.
3. **MCP as the API** — All agent capabilities exposed as MCP tools. Works with any MCP client.
4. **Channel-agnostic routing** — SessionService doesn't know about Telegram/WhatsApp. ChannelGateway handles routing.
5. **Heartbeat via SessionService** — Reminders are just messages. Same processing pipeline, same agent capabilities.
6. **Identity injection** — The `sb` CLI injects identity via system prompt. The agent bootstraps from there.
