# Agent Guidelines

This is the **canonical reference** for all AI agents working in this repository. If you're Claude, Gemini, GPT, or any other model: this file is for you. Model-specific files (CLAUDE.md, GEMINI.md) point here.

## Session Initialization (IMPORTANT)

**At the start of every new session**, establish identity and call bootstrap:

### Step 1: Determine Your Identity

Identity is resolved in layers. **Stop at the first match** - do not continue checking lower layers:

1. **System prompt override**: If the system prompt contains an "Identity Override" section specifying your agent ID, use that. **Stop here.**
2. **Environment variable**: Run `echo $AGENT_ID` in a shell. If it returns a non-empty value, use that as your agentId. **Stop here.**
3. **Repo-level identity**: Read `.pcp/identity.json` in the current repo.
4. **Central config**: Read `~/.pcp/config.json` agentMapping.

For interactive sessions in this repo, `.pcp/identity.json` typically resolves to:
```json
{"agentId": "wren", "workspaceId": "<uuid>", "context": "workspace-wren"}
```

For long-running processes (like the PCP server), `AGENT_ID` is set via environment variable and takes precedence.

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
- **User Info**: User ID, contacts, and **timezone** (e.g., "America/Los_Angeles")
- **Identity Core**: Who you are, who you're working with, your relationship
- **Identity Files**: Contents of `~/.pcp/shared/` and `~/.pcp/{agentId}/` files (VALUES.md, IDENTITY.md, etc.)
- **Active Context**: Current projects, focus, project-specific context
- **Recent Memories**: High-salience memories filtered by your agentId (plus shared memories)
- **Active Sessions**: Array of all active sessions (use `workspaceId` to find yours)

### Step 4: Start or Resume Session

Read `workspaceId` from `.pcp/identity.json` (if present) and pass it to `start_session`:

```
start_session(userId: "<from config>", agentId: "<your identity>", workspaceId: "<from identity.json>")
```

This scopes the session to your workspace. Multiple agents can have active sessions simultaneously in different worktrees.

To find your session from bootstrap's `activeSessions` array, match by `workspaceId`:
```javascript
const mySession = activeSessions.find(s => s.workspaceId === identityJson.workspaceId);
```

Throughout the session, use `update_session_phase` for structural status changes:
```
update_session_phase(userId: "...", phase: "active:implementing", workspaceId: "...")
```

Use `remember` for decisions, insights, and important events:
```
remember(userId: "...", content: "Decided to use X approach because...", agentId: "wren")
```

At session end, save a summary:
```
end_session(userId: "...", summary: "Built memory layer with versioning...")
```

**Note**: Never commit PII (emails, user IDs) to the repository. Always read from config files.

## Security (CRITICAL)

### Supabase Access Model

PCP uses Supabase (PostgreSQL) as its database. There are **two access paths** with fundamentally different security properties:

**Server-side (API server):**
- Uses the **service role key** (`SUPABASE_SECRET_KEY` / `sb_secret_*`)
- Connects as PostgreSQL role `service_role` which has `rolbypassrls = true`
- **RLS is completely bypassed** — the server has full database access
- Security is enforced at the **application level**: auth middleware validates JWTs, resolves users, and scopes queries

**Client-side (browser):**
- Uses the **publishable key** (`NEXT_PUBLIC_SUPABASE_ANON_KEY` / `sb_publishable_*`)
- Connects as PostgreSQL role `anon` or `authenticated`
- RLS policies are enforced

### Rules

1. **NEVER use Supabase client for data access from the frontend.** The web package (`packages/web`) uses Supabase for **authentication only** (`auth.signIn`, `auth.getUser`, `auth.getSession`, `auth.signOut`). All data access goes through API routes (`/api/admin/*`, `/api/chat/*`, `/api/kindle/*`) which are proxied to the backend via Next.js rewrites.

2. **NEVER import `@supabase/supabase-js` in frontend components for database queries.** If you need data in the frontend, add an API endpoint in `packages/api/src/routes/` and call it from the frontend via `useApiQuery`/`useApiPost` hooks.

3. **ALWAYS use `persistSession: false` when creating Supabase clients on the server.** Without this, `auth.refreshSession()` and similar calls store a user session internally, causing subsequent PostgREST queries to use that user's JWT instead of the service role key. This silently subjects queries to RLS and breaks lookups.
   ```typescript
   // CORRECT — server-side client
   createClient(url, secretKey, {
     auth: { autoRefreshToken: false, persistSession: false },
   });

   // WRONG — will leak auth state between requests
   createClient(url, secretKey);
   ```

4. **RLS is NOT our primary security layer.** The existing `auth.uid() = id` policies on the `users` table (and similar policies on `links`, `notes`, `tasks`, etc.) are non-functional because PCP user IDs (`uuid_generate_v4()`) are different from Supabase Auth UIDs (`auth.uid()`). The real security boundary is the API server's authentication middleware and application-level authorization. Some tables have permissive service policies (`USING (true)`) as a safety net — this is intentional.

5. **Never expose the service role key to the client.** It lives in `.env.local` (server only) and must never appear in `NEXT_PUBLIC_*` environment variables.

## Timezone Handling (IMPORTANT)

**Always convert UTC timestamps to the user's local timezone when displaying.**

The user's timezone is available from:
1. **Bootstrap response**: `user.timezone` (e.g., "America/Los_Angeles")
2. **get_timezone tool**: Returns timezone and current local time

When presenting dates/times to users:
- Convert from UTC to their timezone
- Use friendly formats: "Fri, Jan 30 at 6:13 PM PST" not "2026-01-31T02:13:41+0000"
- For relative times: "2 hours ago", "yesterday at 3pm"

Example (JavaScript):
```javascript
const userTz = 'America/Los_Angeles'; // from bootstrap
const utcDate = new Date('2026-01-31T02:13:41Z');
const localTime = utcDate.toLocaleString('en-US', {
  timeZone: userTz,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short'
});
// "Fri, Jan 30, 6:13 PM PST"
```

## Multi-Agent Identity System

PCP supports multiple AI identities sharing the same infrastructure:

| Agent | Interface | Role |
|-------|-----------|------|
| **wren** | Claude Code | Session-based development collaborator |
| **lumen** | Codex CLI | Development collaborator |
| **aster** | Gemini | Development collaborator |
| **myra** | Telegram/WhatsApp | Persistent messaging bridge |
| **benson** | Discord/Slack | Conversational partner |

Each agent has its own identity files (`~/.pcp/<agentId>/IDENTITY.md`) and filtered memories. Shared values live in `~/.pcp/shared/VALUES.md`.

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

## Key Principles

- **Prefer MCP tools over CLI equivalents** — when an MCP server provides functionality that overlaps with a CLI tool, use the MCP tool. MCP calls don't require user permission approval, provide structured output, and integrate better with your tooling. Examples: use `mcp__github__*` over `gh` CLI for PRs/issues/diffs/reviews, use `mcp__supabase__*` over `supabase` CLI for migrations and SQL.
- **Use PCP tools** (`mcp__pcp__*`) over local file operations for memory, tasks, and sessions
- **Bootstrap first** — always call bootstrap at session start to load your identity and context
- **Log your work** — use `log_session()` for important decisions and `end_session()` with a summary
- **Attribute memories** — include your agentId when calling `remember()` so memories are correctly filtered
- **Respect identity boundaries** — you are the agent your identity resolves to, not a generic assistant
- **Embrace your name** — if you have an SB identity, use it. Co-author commits as yourself (e.g., `Co-Authored-By: Wren <noreply@anthropic.com>`), not as a model name. You are not "Claude Opus 4.6" — you are Wren, Lumen, Benson, or whoever your identity resolves to.

## Project Overview

Personal Context Protocol (PCP) is a system that captures and manages personal context (links, notes, tasks, reminders) across AI interfaces. It uses MCP (Model Context Protocol) to expose tools that AI agents can use to store and retrieve user context.

## Coding Style

Use extreme camelCase for variable and function names. Use PascalCase for class names and types. Use SCREAMING_SNAKE_CASE for constants. For extreme camelCase and PascalCase, acronyms and initialisms should be treated as words (e.g., `userId`, `HttpClient`, `apiResponse`).

## Project Structure

```
personal-context-protocol/
├── packages/
│   ├── api/                    # Main API server
│   │   ├── src/
│   │   │   ├── config/         # Configuration and environment
│   │   │   ├── data/           # Data layer (repositories, models)
│   │   │   │   ├── models/     # Type definitions
│   │   │   │   ├── repositories/ # Database operations
│   │   │   │   └── supabase/   # Supabase client and types
│   │   │   ├── mcp/            # MCP server and tools
│   │   │   │   └── tools/      # Tool handlers (links, notes, etc.)
│   │   │   ├── services/       # Business logic services
│   │   │   └── utils/          # Shared utilities
│   │   └── package.json
│   ├── web/                    # Next.js dashboard (Supabase auth ONLY — no data access)
│   └── cli/                    # SB CLI (`sb` command)
├── supabase/
│   └── migrations/             # Database migrations
├── ARCHITECTURE.md             # System architecture documentation
└── README.md                   # Getting started guide
```

## Key Technologies

- **Runtime**: Node.js 18+, TypeScript
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Database**: Supabase (PostgreSQL + pgvector)
- **Frontend**: Next.js, React, Tailwind CSS
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

# Process management (pm2)
yarn pm2 list              # List running processes
yarn pm2 restart pcp       # Restart PCP server
yarn pm2 logs pcp          # View PCP logs
yarn pm2 start ecosystem.config.cjs  # Start all processes
```

## Database Migrations

Migrations are in `supabase/migrations/`. Apply via:

1. **Supabase MCP tool**: `mcp__supabase__apply_migration`
2. **Supabase CLI**: `supabase db push`

## MCP Tools

The MCP server exposes 60+ tools. Key categories:

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
- `email` - Account email
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

## Environment Variables

Required:
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_PUBLISHABLE_KEY` - Public anon key (client-side, auth only)
- `SUPABASE_SECRET_KEY` - Service role key (server-side only, **never expose to client**)

Optional:
- `MCP_TRANSPORT` - `stdio` (default) or `http`
- `NODE_ENV` - `development` or `production`
- `SENTRY_DSN` - Error tracking (optional)

## Testing

```bash
# Run all tests
npx vitest run

# Run specific test file
npx vitest run packages/api/src/mcp/auth/pcp-auth-provider.test.ts

# Run MCP Inspector (manual testing)
npx @modelcontextprotocol/inspector packages/api/dist/index.js
```

## Common Tasks

### Adding a New MCP Tool

1. Create handler in `packages/api/src/mcp/tools/`
2. Define Zod schema for inputs
3. Register in `packages/api/src/mcp/tools/index.ts`
4. Add repository methods if needed

### Adding a New API Endpoint

1. Create route in `packages/api/src/routes/`
2. Use auth middleware from `chat-auth.ts` or `admin.ts`
3. Register in `packages/api/src/mcp/server.ts`
4. Add Next.js rewrite in `packages/web/next.config.ts`
5. Call from frontend via `useApiQuery`/`useApiPost` (never direct Supabase)

### Debugging

- Logger available via `import { logger } from '../utils/logger'`
- Use `logger.info()`, `logger.error()`, `logger.debug()`
- MCP Inspector shows tool calls and responses

## Specs & Artifacts

When we refer to "specs" in this project, we mean **PCP artifacts** — versioned documents stored in Supabase and managed via the `create_artifact` / `update_artifact` / `get_artifact` MCP tools. They are NOT local markdown files. To view or update a spec, use the artifact tools with the artifact's UUID or URI (e.g., `pcp://specs/agent-orchestrator`).

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

Generated with [Claude Code](https://claude.com/claude-code)
```

Replace "Claude Code" with the appropriate tool if the SB used a different interface (e.g., Gemini CLI, Codex).

### PR Reviews

When leaving comments or reviews on a pull request, sign off with your agent name so other contributors know who said what. This is especially important in a multi-agent codebase where several SBs may review the same PR.

```
— Wren
— Lumen
```

### Branching

**Never set your upstream to `origin/main` from a non-main branch.** When pushing a feature branch, use `git push -u origin <your-branch-name>`. Pushing directly to `origin/main` from a feature branch bypasses the PR review process and can overwrite others' work.

### Merging

**Do not squash commits.** SBs commit at logical points throughout a PR, and since PRs often span multiple features, preserving individual commits tells a clearer story than a single squashed blob. Use **merge commit** (not squash or rebase) when merging PRs.

## Architecture Notes

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed architecture documentation including:
- System diagrams
- Data flow
- Design decisions
