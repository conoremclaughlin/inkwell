# Repository Guidelines for Claude

This file provides context and guidelines for AI agents (particularly Claude) working on this codebase.

## Session Initialization (IMPORTANT)

**At the start of every new session**, establish identity and call bootstrap:

### Step 1: Determine Your Identity

Identity is resolved in layers (first match wins):
1. **Environment variable**: `AGENT_ID` (used by long-running processes like Myra)
2. **Repo-level identity**: `.pcp/identity.json` in the current repo
3. **Central config**: `~/.pcp/config.json` agentMapping

For Claude Code sessions in this repo, read `.pcp/identity.json`:
```json
{"agentId": "wren", "context": "pcp-development"}
```

### Step 2: Load User Config

Read from `~/.pcp/config.json`:
```json
{"userId": "...", "email": "...", "agentMapping": {"claude-code": "wren", ...}}
```

### Step 3: Call Bootstrap with Identity

```
bootstrap(userId: "<from config>", agentId: "<your identity>")
```

This returns:
- **Identity Core**: Who you are, who you're working with, your relationship
- **Identity Files**: Contents of `~/.pcp/shared/` and `~/.pcp/{agentId}/` files (VALUES.md, IDENTITY.md, etc.)
- **Active Context**: Current projects, focus, project-specific context
- **Recent Memories**: High-salience memories filtered by your agentId (plus shared memories)
- **Active Session**: Current session if any

### Step 4: Start or Resume Session

```
start_session(userId: "<from config>", agentId: "<your identity>")
```

Throughout the session, log important events:
```
log_session(userId: "...", content: "Completed feature X", salience: "high")
```

At session end, save a summary:
```
end_session(userId: "...", summary: "Built memory layer with versioning...")
```

**Note**: Never commit PII (emails, user IDs) to the repository. Always read from config files.

## Multi-Agent Identity System

PCP supports multiple AI identities, each with their own memories and personality:

| Agent | Context | Description |
|-------|---------|-------------|
| **wren** | Claude Code | Session-based development collaborator |
| **benson** | Clawdbot | Conversational partner via Discord/Slack |
| **myra** | Telegram/WhatsApp | Persistent messaging bridge |

### Identity Files

Located in `~/.pcp/`:
```
~/.pcp/
├── config.json           # User config + agentMapping
├── shared/               # Shared across all agents
│   └── VALUES.md         # Core values we all share
├── wren/
│   └── IDENTITY.md       # Wren's identity
├── benson/
│   └── IDENTITY.md       # Benson's identity
└── myra/
    └── IDENTITY.md       # Myra's identity
```

### Memory Attribution

When saving memories, include your agentId:
```
remember(userId: "...", content: "...", agentId: "wren")
```

When recalling, memories are filtered by agentId but include shared memories (agentId=null):
```
recall(userId: "...", query: "...", agentId: "wren", includeShared: true)
```

## Project Overview

Personal Context Protocol (PCP) is a system that captures and manages personal context (links, notes, tasks, reminders) across AI interfaces. It uses MCP (Model Context Protocol) to expose tools that AI agents can use to store and retrieve user context.

## Coding Style

Use extreme camelCase for variable and function names. Use PascalCase for class names and types. Use SCREAMING_SNAKE_CASE for constants. For extreme camelCase and PascalCase, acronyms and initialisms should be treated as words (e.g., `userId`, `HttpClient`, `apiResponse`).

## Project Structure

```
personal-context-protocol/
├── packages/
│   └── api/                    # Main API server
│       ├── src/
│       │   ├── config/         # Configuration and environment
│       │   ├── data/           # Data layer (repositories, models)
│       │   │   ├── models/     # Type definitions
│       │   │   ├── repositories/ # Database operations
│       │   │   └── supabase/   # Supabase client and types
│       │   ├── mcp/            # MCP server and tools
│       │   │   └── tools/      # Tool handlers (links, notes, etc.)
│       │   ├── services/       # Business logic services
│       │   └── utils/          # Shared utilities
│       └── package.json
├── supabase/
│   └── migrations/             # Database migrations
├── ARCHITECTURE.md             # System architecture documentation
└── README.md                   # Getting started guide
```

## Key Technologies

- **Runtime**: Node.js 18+, TypeScript
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Database**: Supabase (PostgreSQL + pgvector)
- **Validation**: Zod schemas

## Development Commands

```bash
# Install dependencies
yarn install

# Development server (with hot reload)
yarn dev

# Build for production
yarn build

# Type checking
yarn type-check

# Test database connection
yarn test:connection
```

## Database Migrations

Migrations are in `supabase/migrations/`. Apply via:

1. **Supabase MCP tool**: `mcp__supabase__apply_migration`
2. **Supabase CLI**: `supabase db push`

Current migrations:
- `001_initial_schema.sql` - Base tables (users, links, notes, tasks, etc.)
- `add_pgvector_embeddings` - pgvector extension for semantic search
- `update_embeddings_for_voyage_ai` - 1024 dimension vectors (Voyage AI)
- `add_phone_number_to_users` - Phone number column for user lookup

## MCP Tools

The MCP server exposes these tools:

### Bootstrap & Session (use these!)
- `bootstrap` - **Call first!** Loads identity, context, and recent memories
- `start_session` - Start tracking a session
- `log_session` - Log important events/decisions
- `end_session` - End session with summary (auto-saved as memory)
- `get_session` - Get session details and logs
- `list_sessions` - List past sessions

### Memory (long-term storage)
- `remember` - Save to long-term memory with salience/topics
- `recall` - Search memories (text search, semantic coming)
- `forget` - Delete a memory
- `update_memory` - Update salience/topics

### Memory History (versioning)
- `get_memory_history` - View all versions of a memory
- `get_user_history` - See recent changes (updates/deletes)
- `restore_memory` - Rollback to a previous version

### Context
- `save_context` - Save context summaries (user, assistant, relationship, project)
- `get_context` - Retrieve context

### Projects
- `save_project` - Create/update a project
- `list_projects` - List all projects
- `get_project` - Get project details

### Links
- `save_link` - Save a URL with metadata
- `search_links` - Search saved links
- `tag_link` - Add/remove tags

### User Identification
All tools support multiple identification methods:
- `userId` - Direct UUID
- `email` - Account email (e.g., conoremclaughlin@gmail.com)
- `platform` + `platformId` - Platform-specific ID (telegram:123456)
- `phone` - E.164 phone number

## Coding Conventions

### TypeScript
- Strict typing, avoid `any`
- Use Zod for runtime validation
- Prefer `async/await` over callbacks

### File Organization
- One class/module per file
- Co-locate tests (`*.test.ts`)
- Export types from `types.ts` files

### Naming
- PascalCase for classes and types
- camelCase for functions and variables
- SCREAMING_SNAKE for constants

### Error Handling
- Use typed errors where possible
- Log errors with context
- Return structured error responses

## Environment Variables

Required:
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_ANON_KEY` - Public anon key
- `SUPABASE_SERVICE_KEY` - Service role key (server-side only)

Optional:
- `MCP_TRANSPORT` - `stdio` (default) or `http`
- `NODE_ENV` - `development` or `production`
- `SENTRY_DSN` - Error tracking (optional)

## Testing

Run the development server and use MCP Inspector:

```bash
# Terminal 1: Start the server
yarn dev

# Terminal 2: Run MCP Inspector (if installed)
npx @modelcontextprotocol/inspector packages/api/dist/index.js
```

## Common Tasks

### Adding a New MCP Tool

1. Create handler in `packages/api/src/mcp/tools/`
2. Define Zod schema for inputs
3. Register in `packages/api/src/mcp/tools/index.ts`
4. Add repository methods if needed

### Debugging

- Logger available via `import { logger } from '../utils/logger'`
- Use `logger.info()`, `logger.error()`, `logger.debug()`
- MCP Inspector shows tool calls and responses

## Architecture Notes

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed architecture documentation including:
- System diagrams
- Data flow
- Design decisions
- Security model

## Shortcuts

- `yarn dev` - Start development server
- `yarn build` - Build for production
- Check `.env.local` for local configuration (not committed)
