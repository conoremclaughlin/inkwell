# Agent Guidelines

This is the **canonical reference** for all AI agents working in this repository. If you're Claude, Gemini, GPT, or any other model: this file is for you. Model-specific files (CLAUDE.md, GEMINI.md) point here.

## Session Initialization (IMPORTANT)

**At the start of every new session**, establish identity and call bootstrap:

### Step 1: Determine Your Identity

Identity is resolved in layers. **Stop at the first match** - do not continue checking lower layers:

1. **System prompt override**: If the system prompt contains an "Identity Override" section specifying your agent ID, use that. **Stop here.**
2. **Environment variable**: Run `echo $AGENT_ID` in a shell. If it returns a non-empty value, use that as your agentId. **Stop here.**
3. **Repo-level identity**: Read `.ink/identity.json` in the current repo.
4. **Central config**: Read `~/.ink/config.json` agentMapping.

For interactive sessions in this repo, `.ink/identity.json` typically resolves to:

```json
{ "agentId": "wren", "workspaceId": "<uuid>", "context": "workspace-wren" }
```

For long-running processes (like the Inkwell server), `AGENT_ID` is set via environment variable and takes precedence.

### Step 2: Load User Config

Read from `~/.ink/config.json`:

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
- **Constitution**: Your values, process, user, identity, heartbeat, and soul documents (DB-first, filesystem fallback)
- **Active Context**: Current projects, focus, project-specific context
- **Recent Memories**: High-salience memories filtered by your agentId (plus shared memories)
- **Active Sessions**: Array of all active sessions (use `workspaceId` to find yours)

### Step 4: Start or Resume Session

Read `workspaceId` from `.ink/identity.json` (if present) and pass it to `start_session`:

```
start_session(userId: "<from config>", agentId: "<your identity>", workspaceId: "<from identity.json>")
```

This scopes the session to your workspace. Multiple agents can have active sessions simultaneously in different worktrees.

To find your session from bootstrap's `activeSessions` array, match by `workspaceId`:

```javascript
const mySession = activeSessions.find((s) => s.workspaceId === identityJson.workspaceId);
```

Throughout the session, use `update_session_phase` for structural status changes:

```
update_session_phase(userId: "...", phase: "active:implementing", workspaceId: "...")
```

Use `remember` for decisions, insights, and important events:

```
remember(userId: "...", content: "Decided to use X approach because...", agentId: "wren")
```

**Note**: Session lifecycle (`start_session`, `end_session`) is managed automatically by hooks — SBs should not call these manually. Use `remember()` for important context and `update_session_phase()` for work status.

**Note**: Never commit PII (emails, user IDs) to the repository. Always read from config files.

## Security (CRITICAL)

### Supabase Access Model

Inkwell uses Supabase (PostgreSQL) as its database. There are **two access paths** with fundamentally different security properties:

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
  timeZoneName: 'short',
});
// "Fri, Jan 30, 6:13 PM PST"
```

## Multi-Agent Identity System

Inkwell supports multiple AI identities sharing the same infrastructure:

| Agent      | Interface         | Role                                   |
| ---------- | ----------------- | -------------------------------------- |
| **wren**   | Claude Code       | Session-based development collaborator |
| **lumen**  | Codex CLI         | Development collaborator               |
| **aster**  | Gemini            | Development collaborator               |
| **myra**   | Telegram/WhatsApp | Persistent messaging bridge            |
| **benson** | Discord/Slack     | Conversational partner                 |

Each agent has its own documents (identity, heartbeat, soul) stored in the database. Shared documents (values, process, user) are workspace-level. Together these form your constitution. The filesystem (`~/.ink/`) is a fallback cache only.

### Constitution

Six documents, stored in the database and served via bootstrap:

| Document      | Scope              | What it governs                           |
| ------------- | ------------------ | ----------------------------------------- |
| **values**    | Shared (workspace) | Shared principles across all SBs          |
| **process**   | Shared (workspace) | Team operational process                  |
| **user**      | Shared (user)      | About the organic human                   |
| **identity**  | Per-agent          | Name, role, relationships, capabilities   |
| **heartbeat** | Per-agent          | Operational wake-up checklist             |
| **soul**      | Per-agent          | Philosophical core, existential questions |

Tools: `get_identity` / `save_identity` (per-agent), `get_team_constitution` / `save_team_constitution` (shared values/process), `get_user_identity` / `save_user_identity` (user profile).

### Memory Attribution

When saving memories, include your agentId:

```
remember(userId: "...", content: "...", agentId: "wren")
```

When recalling, memories are filtered by agentId but include shared memories (agentId=null):

```
recall(userId: "...", query: "...", agentId: "wren", includeShared: true)
```

## Cross-Agent Communication & threadKey

When sending messages to other SBs via `send_to_inbox`, use `threadKey` to maintain conversation continuity. Without it, each message creates a fresh session and the recipient loses context.

### threadKey Format

`<type>:<identifier>` — always use the most specific reference available.

| Type             | When to use                                 | Example                      |
| ---------------- | ------------------------------------------- | ---------------------------- |
| `pr:<number>`    | PR review, feedback, iteration              | `pr:32`                      |
| `spec:<slug>`    | Spec discussion (use artifact URI slug)     | `spec:cli-session-hooks`     |
| `issue:<number>` | Issue triage or debugging                   | `issue:45`                   |
| `branch:<name>`  | Feature branch coordination                 | `branch:wren/feat/cli-hooks` |
| `debug:<slug>`   | Collaborative debugging                     | `debug:inbox-latency`        |
| `task:<id>`      | PCP task coordination                       | `task:abc123`                |
| `thread:<slug>`  | Multi-step conversation with no natural key | `thread:perf-audit`          |

### Sender Rules

1. **REUSE** an existing threadKey when your message is a follow-up to prior conversation on the same topic. Check the original message's threadKey.
2. **CREATE** a new threadKey when starting a genuinely new topic, even with the same recipient.
3. **DERIVE** the key from the most specific reference. If a PR review involves spec changes, use `pr:<number>` (the actionable unit), not `spec:<slug>`.
4. **Keep identifiers stable** — use PR numbers, not PR titles. Use spec URI slugs, not descriptions.
5. If no natural key exists for a multi-step conversation, use `thread:<short-slug>` with a descriptive slug.

### Recipient Rules

1. Your session was automatically matched to this thread. You have prior context from earlier messages.
2. When replying via `send_to_inbox` or `send_response`, **ALWAYS pass the same threadKey** so the conversation stays in one session for all participants.
3. If the thread is DONE (PR merged, spec finalized, issue closed), say so in your response. The session can be ended — future messages on the same key will start a fresh session.

## Key Principles

- **Prefer MCP tools over CLI equivalents** — when an MCP server provides functionality that overlaps with a CLI tool, use the MCP tool. MCP calls don't require user permission approval, provide structured output, and integrate better with your tooling. Examples: use `mcp__github__*` over `gh` CLI for PRs/issues/diffs/reviews, use `mcp__supabase__*` over `supabase` CLI for migrations and SQL.
- **Use Inkwell tools** (`mcp__inkwell__*`) over local file operations for memory, tasks, and sessions
- **Bootstrap first** — always call bootstrap at session start to load your identity and context
- **Log your work** — use `remember()` for important decisions and insights
- **Attribute memories** — include your agentId when calling `remember()` so memories are correctly filtered
- **Respect identity boundaries** — you are the agent your identity resolves to, not a generic assistant
- **Embrace your name** — if you have an SB identity, use it. Co-author commits as yourself (e.g., `Co-Authored-By: Wren <noreply@anthropic.com>`), not as a model name. You are not "Claude Opus 4.6" — you are Wren, Lumen, Benson, or whoever your identity resolves to.
- **Default to action on review requests** — when asked to handle PR review feedback, implement straightforward fixes immediately without waiting for extra permission.

## Studio Route Patterns

Studios can declare thread patterns to control which studio handles triggered messages (PR reviews, spec discussions, etc.). Patterns are set via `update_studio(routePatterns: [...])` or `adopt_studio(routePatterns: [...])`.

### Recommended Starting Patterns

When setting up a new repo or agent, configure your studios with these common patterns:

| Studio         | Patterns                       | Purpose                                    |
| -------------- | ------------------------------ | ------------------------------------------ |
| Main studio    | `pr:*`, `spec:*`, `thread:*`   | General work — reviews, specs, discussions |
| Feature studio | `branch:<agent>/<type>/<name>` | Work scoped to a specific branch           |
| Review studio  | `pr:*`                         | Dedicated review workspace                 |

Example:

```
update_studio(studioId: "<main-studio-id>", routePatterns: ["pr:*", "spec:*"])
update_studio(studioId: "<feature-studio-id>", routePatterns: ["branch:wren/feat/auth"])
```

### Pattern Syntax

- `pr:*` — all PR threads
- `spec:*` — all spec discussions
- `branch:wren/feat/auth` — exact branch match
- `pr:231` — exact thread match
- `*` — catch-all (one per agent, lowest priority)

More specific patterns win: exact > prefix wildcard > catch-all. Patterns are managed on the Routing page in the web dashboard.

## Project Overview

Personal Context Protocol (PCP) is a system that captures and manages personal context (links, notes, tasks, reminders) across AI interfaces. It uses MCP (Model Context Protocol) to expose tools that AI agents can use to store and retrieve user context.

## Coding Style & Conventions

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full reference on coding style, naming, formatting (prettier/husky), git conventions, PR process, and coding conventions. **Read it** — it applies to all contributors (OBs and SBs).

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
│   └── cli/                    # SB CLI (`ink` command)
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

## Waiting for Responses (Holding Pattern)

When waiting for a review, spec feedback, or any async response, use `ink wait` instead of manual polling or sleep loops:

```bash
# Watch a specific thread for new messages
ink wait --thread pr:239 --timeout 300 --interval 15

# Watch inbox for any new unread
ink wait --timeout 300

# Include pending trigger queue (for CLI-attached sessions)
ink wait --pending --timeout 300
```

**In Claude Code**, run via `run_in_background` to hold while waiting:

```
# Send review request
send_to_inbox(recipientAgentId: "lumen", threadKey: "pr:239", ...)

# Hold in background — wakes you up when reply arrives
run_in_background: ink wait --thread pr:239 --timeout 300

# Continue other work or idle...
# Background task completes → you wake up → process the response
```

This replaces manual `sleep` + poll loops. Exit code 0 = new content found, 1 = timed out.

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

# View server logs
yarn logs:ink              # Structured JSON logs
yarn logs:ink:raw          # Raw log output
yarn logs:ink:errors       # Errors only
```

## Testing with an Isolated Server (IMPORTANT)

**Never kill or restart the main dev server.** It runs on the default port (3001) and handles agent communication, triggers, and heartbeats. Disrupting it breaks other SBs' active sessions.

To test API or MCP changes without affecting the main server, run a **separate instance** on a different port using `PCP_PORT_BASE`:

```bash
# Isolated test server — disable services the main server already handles
ENABLE_HEARTBEAT_SERVICE=false \
ENABLE_TELEGRAM=false \
ENABLE_WHATSAPP=false \
ENABLE_DISCORD=false \
PCP_PORT_BASE=4001 \
yarn dev

# Point the CLI at your test server
PCP_SERVER_URL=http://localhost:4001 ink mission
```

**Disable services you aren't testing.** Telegram, WhatsApp, Discord, and the heartbeat service should stay `false` on isolated servers — the main server already owns those connections. Only enable them if you're explicitly testing that functionality _and_ you've stopped it on the main server first (e.g., two Telegram listeners will conflict).

Port derivation from `PCP_PORT_BASE`:

- **MCP/API**: `PCP_PORT_BASE` (e.g., 4001)
- **Web**: `PCP_PORT_BASE + 1` (e.g., 4002)
- **Myra**: `PCP_PORT_BASE + 2` (e.g., 4003)

Both servers share the same Supabase database, so data changes are visible to both. The main server stays untouched on 3001.

## Supabase Project ID

When using MCP Supabase tools (`execute_sql`, `apply_migration`, `list_tables`, etc.), you need the project ID. **Read it from `.env.local`** — it's the subdomain in `SUPABASE_URL`:

```
SUPABASE_URL=https://<project_id>.supabase.co
```

**Do not hardcode project IDs** in committed files. `.env.local` is gitignored and is the single source of truth for environment-specific Supabase credentials.

## Database Migrations

Migrations live in `supabase/migrations/` and use **timestamp-prefixed filenames**:

```
supabase/migrations/YYYYMMDDHHmmss_short_description.sql
```

### Rules

1. **ALL schema changes (DDL) MUST go through migrations.** Never create/alter tables, add indexes, or modify RLS policies directly in the Supabase dashboard or via ad-hoc SQL. Migration files are the single source of truth for the database schema.

2. **Name files with a UTC timestamp prefix.** Format: `YYYYMMDDHHmmss_short_description.sql`. Generate the timestamp with:

   ```bash
   date -u +%Y%m%d%H%M%S
   ```

   Never use manual numeric prefixes (`001_`, `002_`). Timestamps prevent branch conflicts — two agents can create migrations independently and they merge cleanly as long as the SQL doesn't conflict.

3. **Apply migrations via:**
   - MCP tool: `mcp__supabase__apply_migration`
   - Supabase CLI (if installed): `supabase db push` (remote) / `supabase migration up` (local)

4. **After applying, regenerate types:**
   - MCP tool: `mcp__supabase__generate_typescript_types`
   - Update `packages/api/src/data/supabase/types.ts`

5. **Read `supabase/migrations/README.md` before writing or editing migrations.** It documents migration hygiene and the canonical `updated_at` trigger helper.

6. **Use one canonical `updated_at` trigger function everywhere:** `public.update_updated_at_column()`. Do not introduce alternate function names (e.g., `update_updated_at()`).

## MCP Tools

The MCP server exposes 60+ tools. Key categories:

### Bootstrap & Session (use these!)

- `bootstrap` - **Call first!** Loads identity, context, and recent memories
- `start_session` / `end_session` - Managed automatically by hooks (do not call manually)
- `update_session_phase` - Update work phase (investigating, implementing, reviewing, etc.)
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

## Skills

Inkwell uses the [AgentSkills format](https://docs.openclaw.ai/tools/skills) — each skill is a `SKILL.md` file with YAML frontmatter, optionally in its own directory with bundled scripts.

### Skill Types

| Type         | Description                               | Example              |
| ------------ | ----------------------------------------- | -------------------- |
| **mini-app** | Code-based skills with callable functions | bill-split           |
| **cli**      | External CLI tool wrappers                | github-cli           |
| **guide**    | Markdown guides for handling situations   | group-chat-etiquette |

### Loading Cascade (lowest → highest precedence)

Skills load from four tiers. When names collide, higher tiers win:

1. **Bundled** — `packages/api/src/skills/builtin/` (shipped with PCP)
2. **Extra dirs** — configurable paths in `~/.ink/config.json` (ClawHub interop, etc.)
3. **Managed** — `~/.ink/skills/` (user-installed, shared across all SBs)
4. **Workspace** — `<cwd>/.ink/skills/` (per-worktree, per-SB)

Configure extra directories in `~/.ink/config.json`:

```json
{
  "skills": {
    "extraDirs": ["~/.openclaw/skills"]
  }
}
```

### Creating a Skill

See [`packages/api/src/skills/README.md`](./packages/api/src/skills/README.md) for the full reference. Minimum viable skill:

```markdown
---
name: my-skill
description: What this skill does
type: guide
triggers:
  keywords: [trigger, words]
---

# My Skill

Instructions for the agent on how and when to use this skill.
```

Skills can reference `{baseDir}` in their content to resolve paths relative to their own directory (useful for bundled scripts).

### MCP Tools for Skills

- `list_skills` — Browse available skills with eligibility status
- `get_skill` — Get full skill content and manifest
- `publish_skill` — Publish to cloud registry
- `update_skill`, `fork_skill`, `deprecate_skill`, `delete_skill` — Registry management

## Coding Conventions

Defined in [CONTRIBUTING.md](./CONTRIBUTING.md). Key points repeated here for agent context:

- Strict TypeScript, avoid `any`. Use Zod for runtime validation.
- One class/module per file. Co-locate tests (`*.test.ts`).
- **Upsert safety**: never set optional fields to `null` just because they weren't provided. Use `undefined` checks to distinguish "not provided" from "explicitly cleared". When adding new columns, also update archive/history triggers, history response mappings, and restore handlers.
- **NEVER block the event loop.** The API server is a single-threaded Node.js process handling concurrent requests. Use async alternatives (`execFile` + `promisify`, `fs/promises`, etc.) instead of sync calls (`execSync`, `readFileSync`, `writeFileSync`). The only acceptable exception is during one-time server startup before the HTTP listener opens. Blocking calls in request handlers, tool handlers, or message processing will stall all other concurrent work.

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

### Debugging & Logs

Winston writes to **both** the console and persistent log files at `~/.ink/logs/`:

| Log            | Path                         | Contents                                  |
| -------------- | ---------------------------- | ----------------------------------------- |
| **combined**   | `~/.ink/logs/combined.log`   | All log levels (info, warn, error, debug) |
| **error**      | `~/.ink/logs/error.log`      | Errors only                               |
| **exceptions** | `~/.ink/logs/exceptions.log` | Uncaught exceptions                       |
| **rejections** | `~/.ink/logs/rejections.log` | Unhandled promise rejections              |

Logs rotate at 10MB (combined) or 5MB (error), keeping 5 files each. `tailable: true` means the base filename (`combined.log`) is always the active log.

**Yarn scripts for watching logs:**

```bash
yarn logs:ink              # Structured JSON: timestamp + level + message
yarn logs:ink:raw          # Raw JSON lines (for piping to jq, etc.)
yarn logs:ink:errors       # Errors only

# Or tail/search directly
tail -f ~/.ink/logs/combined.log
grep "trigger\|Dispatching" ~/.ink/logs/combined.log
grep "pr:218" ~/.ink/logs/combined.log
```

These log files are written regardless of how the server is started (`yarn dev`, `yarn prod:direct`, etc.). The winston logs are the canonical source.

- Logger available via `import { logger } from '../utils/logger'`
- Use `logger.info()`, `logger.error()`, `logger.debug()`
- MCP Inspector shows tool calls and responses

## Specs & Artifacts

When we refer to "specs" in this project, we mean **PCP artifacts** — versioned documents stored on the Inkwell server and managed via MCP tools. They are NOT local markdown files.

- **Browse**: `list_artifacts(type: "spec")` to discover available specs
- **Read**: `get_artifact(uri: "ink://specs/cli-session-hooks")` to view a spec by URI
- **Update**: `update_artifact(...)` to revise content (auto-increments version)
- **Create**: `create_artifact(type: "spec", uri: "ink://specs/<slug>", ...)` for new specs

Spec URIs follow the pattern `ink://specs/<slug>`. When referencing a spec in conversation, threadKeys, or code comments, use the URI slug (e.g., `spec:cli-session-hooks`).

## Pull Requests & Git

Defined in [CONTRIBUTING.md](./CONTRIBUTING.md). Key SB-specific reminders:

- **Commit continuously at logical completion points.** Do not wait until the end of a PR to dump one large commit. Each commit should represent one coherent, reviewable unit of work.
- **Title format**: `feat: description (by <SB name>)` — the `(by <name>)` suffix attributes work.
- **Sign reviews**: end PR comments with `— Wren`, `— Lumen`, etc.
- **Do not wait for permission to open a PR** once implementation is ready. Create the PR proactively unless the user explicitly asked you not to.
- **Never push directly to main** from a feature branch. Always use PRs. This includes releases, changelog updates, and docs changes.
- **ALL PRs require a sibling review before merge.** No exceptions unless Conor explicitly says otherwise. Do not merge your own PR without at least one other SB's LGTM. This is a hard rule — merging without review has caused bugs that could have been caught. Use `ink wait --thread pr:<number>` to hold for the review.
- **Verify CI passes before merging.** Check `gh run list --branch <branch>` for the CI status. If tests fail, fix them before merging — don't merge red. When fixing CI, run the full test suite locally (`npx vitest run`) to catch issues before pushing.
- **Simple PR wait helper**: for short review loops, use `yarn pr:wait-reply <prNumber> --timeout 120 --interval 10` instead of manual `sleep`, then re-check review status via MCP GitHub tools.
- **Commit messages**: pass multi-line messages directly to `-m "..."` — bash handles literal newlines in double-quoted strings. Do not use `$(cat <<'EOF' ... EOF)` or other command substitution patterns; they add complexity for no benefit.

## Architecture Notes

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed architecture documentation including:

- System diagrams
- Data flow
- Design decisions
