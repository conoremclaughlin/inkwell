# Agent Guidelines

This is the **canonical reference** for all AI agents working in this repository. If you're Claude, Gemini, GPT, or any other model: this file is for you. Model-specific files (CLAUDE.md, GEMINI.md) point here.

## Session Initialization (IMPORTANT)

**At the start of every new session**, establish identity and call bootstrap:

### Step 1: Determine Your Identity

Identity is resolved in layers. **Stop at the first match** - do not continue checking lower layers:

1. **System prompt override**: If the system prompt contains an "Identity Override" section naming your slug, use that. **Stop here.**
2. **Environment variable**: Run `echo $SB_SLUG` in a shell. If it returns a non-empty value, use that as your sbSlug. **Stop here.**
3. **Repo-level identity**: Read `.ink/identity.json` in the current repo.
4. **Central config**: Read `~/.ink/config.json` `sbMapping`.

For interactive sessions in this repo, `.ink/identity.json` typically resolves to:

```json
{ "sbSlug": "wren", "studioId": "<uuid-or-main>", "context": "main" }
```

For long-running processes (like the Inkwell server), `SB_SLUG` is set via environment variable and takes precedence.

### Step 2: Load User Config

Read from `~/.ink/config.json`:

```json
{"userId": "...", "email": "...", "sbMapping": {"claude-code": "wren", ...}}
```

### Step 3: Call Bootstrap with Identity

```
bootstrap(userId: "<from config>", sbSlug: "<your identity>")
```

This returns:

- **User Info**: User ID, contacts, and **timezone** (e.g., "America/Los_Angeles")
- **Identity Core**: Who you are, who you're working with, your relationship
- **Constitution**: Your values, process, user, identity, heartbeat, and soul documents (DB-first, filesystem fallback)
- **Active Context**: Current projects, focus, project-specific context
- **Recent Memories**: High-salience memories filtered by your sbSlug (plus shared memories)
- **Active Sessions**: Array of all active sessions (use `studioId` to find yours)

### Step 4: Start or Resume Session

Read `studioId` from `.ink/identity.json` (if present) and pass it to `start_session`:

```
start_session(userId: "<from config>", sbSlug: "<your identity>", studioId: "<from identity.json>")
```

This scopes the session to your studio (worktree). Multiple agents can have active sessions simultaneously in different studios.

To find your session from bootstrap's `activeSessions` array, match by `studioId`:

```javascript
const mySession = activeSessions.find((s) => s.studioId === identityJson.studioId);
```

Throughout the session, use `update_session_state` for structural status changes:

```
update_session_state(userId: "...", phase: "active:implementing", studioId: "...")
```

Use `remember` for decisions, insights, and important events:

```
remember(userId: "...", content: "Decided to use X approach because...", sbSlug: "wren")
```

**Note**: Session lifecycle (`start_session`, `end_session`) is managed automatically by hooks — SBs should not call these manually. Use `remember()` for important context and `update_session_state()` for work status.

**Note**: Runtime account identifiers come from config or environment, never tracked fixtures. Public contributor attribution is different from private account/contact data — see [Private data and public contributor attribution](#private-data-and-public-contributor-attribution-ironclad) under Testing.

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

### Local dashboard test account

A shared SB account exists for local dashboard and auth-flow testing. Its credentials live in `.env.local` (gitignored, present in every worktree) as:

```
SB_TEST_EMAIL
SB_TEST_PASSWORD
```

Use it whenever an SB needs to sign in to the dashboard or exercise the login path. **Never reset, rotate, or reuse a human's password to gain access** — the admin auth API can change any user's password with the service key, and doing so locks the human out. If the test account is missing or its password no longer works, say so and stop; recreating it is the user's call.

### File Access & Media Isolation (TODO)

Server-spawned Claude sessions currently get `--add-dir ~/.ink/files` for media access (Telegram downloads, Gmail attachments, etc.). This is a shared directory — **all SBs can read all SBs' files**. Future work should consider:

- **Per-agent file namespacing**: `~/.ink/files/<sbSlug>/telegram/` instead of `~/.ink/files/telegram/`
- **Scoped `--add-dir`**: only grant access to the spawned agent's own subdirectory
- **Cross-agent file sharing**: explicit mechanism for one SB to share a file with another (vs. implicit shared access)
- **File lifecycle**: cleanup policy for downloaded media (currently accumulates indefinitely)

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

## Workspace vs Studio Scope (IMPORTANT)

These are **different concepts** — never conflate them:

| Concept       | What it is                                  | DB table     |
| ------------- | ------------------------------------------- | ------------ |
| **Workspace** | Parent-level container for all docs and SBs | `workspaces` |
| **Studio**    | A git worktree with its own session/branch  | `studios`    |

A workspace contains many studios. A studio belongs to one workspace.

### The `x-ink-context` header

The primary mechanism for scope resolution is the **`x-ink-context`** header — a base64url-encoded JSON token set by CLI hooks. It carries:

```typescript
interface PcpContextToken {
  sessionId: string; // PCP session ID
  studioId: string; // Studio UUID (or "main" for root repo)
  sbSlug: string; // Agent identity
  cliAttached: boolean; // Whether a human is at the terminal
  runtime: string; // 'claude' | 'codex' | 'gemini'
  repoRoot?: string; // Root repo path
}
```

The server decodes this token and extracts `studioId` for studio scope and other fields for session/identity context. Legacy individual headers (`x-ink-session-id`, `x-ink-studio-id`) are fallbacks when the context token is absent.

### How scope is determined

- **Studio scope** (`studioId`): Extracted from the `studioId` field in the `x-ink-context` token (preferred), or the `x-ink-studio-id` header (fallback). Set by CLI hooks based on `.ink/identity.json` in the current worktree. Used for session routing, inbox filtering, and worktree-specific operations.

- **Workspace scope** (`workspaceId`): Resolved server-side from the `x-ink-workspace-id` header or derived from the agent's identity record. Used for document ownership (artifacts, constitution), shared resources, and cross-studio operations. **Do NOT pass `workspaceId` as a tool parameter** — the server resolves it from request context. Future use cases for querying across workspaces will require proper authorization checks.

### Rules

1. **Never map `studioId` to `workspaceId` or vice versa.** They are not interchangeable. There should be ZERO locations in the code where one is shimmed to the other.
2. **Tool schemas should use `studioId` for studio-scoped operations** (sessions, inbox, studio management). Never accept `workspaceId` on studio-scoped tools.
3. **Workspace scope is server-derived, not client-provided.** The server resolves the workspace from headers and agent identity — tools should not accept `workspaceId` as a user-facing parameter.
4. **In `.ink/identity.json`**, the `studioId` field is a studio UUID (or `"main"` for the root repo). It is NOT a workspace ID.

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

### Identity References in Code

Two things name an SB, and they are not interchangeable:

| Name         | What it is                  | Unique within     |
| ------------ | --------------------------- | ----------------- |
| **`sbId`**   | The canonical identity UUID | Everywhere        |
| **`sbSlug`** | The human-readable name     | **One workspace** |

When referencing an SB programmatically — in database columns, API schemas, tool parameters, strategy configs — always use `sbId`, never `sbSlug`.

- **A slug is unique only within a workspace.** Another workspace may have its own `wren`, and that is intended: **an SB's identity boundary is the workspace**. Studios are work areas inside one.
- **UUIDs are authoritative** — globally unique, no disambiguation needed.
- **Resolve at the boundary** — when a human-readable slug is needed for routing (e.g., `send_to_inbox`), resolve UUID → slug at the last moment.

`sbId` → `sbSlug` is always safe: a UUID names exactly one row. The reverse needs a workspace, so `resolveSbId()` takes one (defaulting to the request's) and **refuses rather than guessing** when a slug is ambiguous and no workspace narrows it.

> **One thing you will see in SQL.** The database has not been migrated yet, so raw queries still name the columns `agent_id` (the slug) and `sb_id` (the UUID), in a table called `agent_identities`. That is the _only_ place the old name is correct. Never introduce it into TypeScript, a tool parameter, or a document — there the pair is always `sbId` / `sbSlug`.

### Memory Attribution

When saving memories, include your sbSlug:

```
remember(userId: "...", content: "...", sbSlug: "wren")
```

When recalling, memories are filtered by sbSlug but include shared memories (sbSlug=null):

```
recall(userId: "...", query: "...", sbSlug: "wren", includeShared: true)
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

### Cross-Project threadKeys (MANDATORY outside Inkwell)

When working across multiple repos/projects, prefix the threadKey with the project name to avoid collisions. The format is `<project>:<type>:<identifier>`.

| Context                       | threadKey                       |
| ----------------------------- | ------------------------------- |
| PR in Inkwell (this repo)     | `pr:389`                        |
| PR in a different project     | `inktrade:pr:42`                |
| Issue in another project      | `openclaw:issue:15`             |
| Cross-project spec discussion | `inktrade:spec:valuation`       |
| Branch in another project     | `inktrade:branch:supabase-auth` |

Within the Inkwell repo, the project prefix is optional — `pr:389` is unambiguous. For any thread that references work in a **different repo, the project prefix is REQUIRED** — `pr:12` in two repos is a routing collision, and studio route patterns (`inktrade:pr:*`) can only target project-scoped keys.

The project goes in the **prefix slot, never the identifier**: `inktrade:pr:42`, not `pr:inktrade-42` or `pr:inktrade-supabase-auth`. Baking the project into the identifier defeats pattern matching and prefix-based routing.

Each repo's AGENTS.md should carry this threadKey section so agents working there natively derive project-prefixed keys.

### Sender Rules

1. **REUSE** an existing threadKey when your message is a follow-up to prior conversation on the same topic. Check the original message's threadKey.
2. **CREATE** a new threadKey when starting a genuinely new topic, even with the same recipient.
3. **DERIVE** the key from the most specific reference. If a PR review involves spec changes, use `pr:<number>` (the actionable unit), not `spec:<slug>`.
4. **Keep identifiers stable** — use PR numbers, not PR titles. Use spec URI slugs, not descriptions.
5. If no natural key exists for a multi-step conversation, use `thread:<short-slug>` with a descriptive slug.
6. **Prefix with the project** for any thread about work outside this repo: `<project>:<type>:<identifier>` (see Cross-Project threadKeys above).

### Recipient Rules

1. Your session was automatically matched to this thread. You have prior context from earlier messages.
2. When replying via `send_to_inbox` or `send_response`, **ALWAYS pass the same threadKey** so the conversation stays in one session for all participants.
3. If the thread is DONE (PR merged, spec finalized, issue closed), say so in your response. The session can be ended — future messages on the same key will start a fresh session.

## Key Principles

- **Prefer MCP tools over CLI equivalents** — when an MCP server provides functionality that overlaps with a CLI tool, use the MCP tool. MCP calls don't require user permission approval, provide structured output, and integrate better with your tooling. Examples: use `mcp__github__*` over `gh` CLI for PRs/issues/diffs/reviews, use `mcp__supabase__*` over `supabase` CLI for migrations and SQL.
- **Use Inkwell tools** (`mcp__inkwell__*`) over local file operations for memory, tasks, and sessions
- **Bootstrap first** — always call bootstrap at session start to load your identity and context
- **Log your work** — use `remember()` for important decisions and insights
- **Attribute memories** — include your sbSlug when calling `remember()` so memories are correctly filtered
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

- **Runtime**: Node.js 22 (`.nvmrc`; the MCP SDK v2 packages require 20 or newer), TypeScript
- **MCP SDK**: `@modelcontextprotocol/server` (v2; `/node` for the HTTP transport, `/client` in tests). Protocol revision 2026-07-28; the legacy `@modelcontextprotocol/sdk` 1.x line stopped at 2025-11-25
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
send_to_inbox(recipientSlug: "lumen", threadKey: "pr:239", ...)

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

# Build for production (also re-points the global ink link — see "The Global ink CLI Link")
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

**Never let a second server process heartbeats or reminders.** A different port does not make a server isolated — every server reads the same database. A second one with heartbeat processing left on does not sit idle: it ticks on its own schedule, sees the same reminders come due, and races the main server to claim each one. Whoever wins spawns the agent, and the loser's spawn would have landed in whatever checkout that server was started from. Coverage becomes a coin flip, and nothing alerts, because every individual beat still looks fine in the log. On 2026-09-11 a test server left up overnight in a worktree took roughly half of Myra's hourly heartbeats for thirteen hours and ran them against an `ink` build dated April 9. We have flags for exactly this — set them.

**Stop your test server when you're done with it.** The 2026-09-11 server had been orphaned since the previous evening: no terminal attached, zero clients on its port, still ticking. A test server is not free to leave running, and the cost does not show up in your own session.

To test API or MCP changes without affecting the main server, run a **separate instance** on a different port using `INK_PORT_BASE`:

```bash
# Isolated test server — disable services the main server already owns.
# ENABLE_HEARTBEATS=false is not optional: without it this server races the
# main one for every due reminder (see above).
ENABLE_HEARTBEATS=false \
ENABLE_TELEGRAM=false \
ENABLE_WHATSAPP=false \
ENABLE_DISCORD=false \
ENABLE_GRAPH_SWEEP=false \
ALERT_STALENESS_SWEEP_SECONDS=0 \
INK_PORT_BASE=4001 \
yarn dev

# Point the CLI at your test server
PCP_SERVER_URL=http://localhost:4001 ink mission
```

**Use `INK_PORT_BASE`, not `PCP_PORT_BASE`.** The resolution is `INK_PORT_BASE || PCP_PORT_BASE` (`scripts/dev-concurrently.mjs`), and `INK_PORT_BASE=3001` is exported in the inherited shell environment on this machine — so an explicit `PCP_PORT_BASE=4001` is silently discarded and the "isolated" server starts on the main server's port.

**Disable services you aren't testing.** Telegram, WhatsApp, Discord, the heartbeat service, the workflow-graph sweep (`ENABLE_GRAPH_SWEEP`), and the alert staleness sweep (`ALERT_STALENESS_SWEEP_SECONDS=0`) should stay off on isolated servers — the main server already owns those connections and those sweeps' dispatch (both servers share the DB, so two sweeps means duplicate inbox triggers and duplicate alert notifications). Only enable them if you're explicitly testing that functionality _and_ you've stopped it on the main server first (e.g., two Telegram listeners will conflict).

Note that the alert sweep is **on by default** — unlike `ENABLE_*` flags, omitting `ALERT_STALENESS_SWEEP_SECONDS` runs it every 300s rather than disabling it. A long-running review server that leaves it unset will emit real alert notifications. Only an explicit `0` turns it off.

**Heartbeats specifically.** Any of `ENABLE_HEARTBEATS`, `ENABLE_REMINDERS`, or `ENABLE_HEARTBEAT_SERVICE` set to a false-like value (`false`, `0`, `off`, `no`) disables reminder processing. A server started from a git worktree also auto-disables, and needs one of those set to `true` to opt back in.

**Verify it rather than assume it.** The startup log line `Heartbeat service flags evaluated` reports `heartbeatServiceEnabled`, the `cwd` it resolved from, and `isWorktree` when it detected one. Both servers write to the same log file, so duplicate ticks read as one chatty process and the `cwd` field is what tells the two apart. If you want the direct check, `grep 'Heartbeat tick' ~/.ink/logs/combined.log | tail` — a timestamp appearing twice means two schedulers are live right now.

Both disable paths failed silently until 2026-09-11, so it is worth knowing why. `ENABLE_HEARTBEAT_SERVICE` — the name this recipe used to give — was read by nothing; the only match in the tree was a line in `dev-concurrently.mjs` that printed it. The worktree auto-disable checked `.git` in `process.cwd()`, but the API server's cwd is `packages/api`, so it never detected a worktree either. The operator who started that server set the documented variable correctly and got a no-op, behind a guard that had never once fired. Both mechanisms work now, and the code honours `ENABLE_HEARTBEAT_SERVICE` as well as the two real names — so the older copies of this recipe still checked out in other worktrees now describe something that actually happens.

Port derivation from `INK_PORT_BASE`:

- **MCP/API**: `INK_PORT_BASE` (e.g., 4001)
- **Web**: `INK_PORT_BASE + 1` (e.g., 4002)
- **Myra**: `INK_PORT_BASE + 2` (e.g., 4003)

Both servers share the same Supabase database, so data changes are visible to both. The main server stays untouched on 3001.

## The Global `ink` CLI Link (IMPORTANT)

`~/.ink/bin/ink` (compat alias: `~/.local/bin/ink`) is a symlink to **one** checkout's `packages/cli/dist/cli.js`. Every terminal hook, every server-spawned session, and every `ink wait` on this machine runs whatever that link points at. Which checkout it points at is the OB's decision, not yours.

**NEVER re-point the global `ink` link without explicit permission in the current conversation.** All of these re-point it:

- `yarn workspace @inklabs/cli install:cli` — links to the checkout you run it from
- root `yarn build` — runs `install:cli` as its last step
- `ln -s` or editing the symlink by hand

A deploy, a merged CLI fix, a build that looks stale, or "the fix should reach terminals" is not permission. Ask, name the checkout you would point it at, and wait for a yes. Permission for one relink does not carry over to the next.

**To test a CLI change, build it where it lives and call that build directly:**

```bash
# From your studio (create one with: ink studio create <name> --branch <branch> --agent <you>)
yarn workspace @inklabs/cli build
node ./packages/cli/dist/cli.js <subcommand>
```

The global link stays where it was. Your studio's build is for you to exercise, not for every other session on the machine to run.

**The server never uses the global link.** For the hooks it writes and the chat loops it spawns, it resolves its own checkout's `packages/cli/dist/cli.js` (see `packages/api/src/services/ink-cli.ts`), runs it through node, and takes `INK_CLI_PATH` as an explicit override. A checkout with no CLI build falls back to `ink` on PATH with a one-time warning; build it with `yarn workspace @inklabs/cli build`. A new call site that reaches for `ink` without going through that resolver is a code problem, not a reason to relink: route it through `resolveInkCli` and open a PR.

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
- `update_session_state` - Update work phase (investigating, implementing, reviewing, etc.)
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
- `SERVER_COMPACTION_ENABLED` - `true` to let the server rotate claude-code sessions at the compaction threshold (default `false`: Claude Code auto-compacts natively via `--autocompact`)
- `COMPACTION_THRESHOLD` - context-token threshold for the server-side trigger when enabled (default 150000)
- `INK_CLI_PATH` - absolute path of the ink CLI the server invokes for hooks and chat loops. Default: this checkout's `packages/cli/dist/cli.js`, run through node. The server never uses the global `~/.ink/bin/ink` link.

## Testing

### Test tiers

| Tier            | What it tests                                    | Server needed? | LLM called? | Example                                   |
| --------------- | ------------------------------------------------ | -------------- | ----------- | ----------------------------------------- |
| **Unit**        | Pure logic: scorers, loaders, schemas, repos     | No             | No          | `scorer.test.ts`, `*.repository.test.ts`  |
| **Integration** | Tool handlers + DB/server round-trips            | Yes (PCP)      | No          | `runner.integration.test.ts`              |
| **Live**        | End-to-end with an LLM backend generating output | Yes (PCP+LLM)  | **Yes**     | Future: live eval where SB curates recall |

**Unit tests** use mocks (mock Supabase client, stubbed recall functions) and run in CI with no external dependencies. **Integration tests** hit the running PCP server (default `http://localhost:3001`) and require valid auth (`~/.ink/auth.json`). They skip automatically when the server is unavailable. **Live tests** are the only tier where an LLM actually generates responses — they measure whether the full pipeline (recall → injection → LLM response → curation) produces correct behavior, not just whether individual components work.

When adding a new feature, write unit tests for the logic and integration tests for the server round-trip. Live tests are reserved for eval harnesses where the LLM's judgment is part of what's being measured.

### Private data and public contributor attribution (IRONCLAD)

**Public contributor identity is allowed; private contact and life data is not.** A contributor's public name, normal authorship credit, and established public contributor attribution in git history are not privacy incidents merely because they identify a person. Repository-work examples may name contributors. This does not make their private contact details, or other people's personal information, public.

**Technical commissioning/spec conversations may be used when Conor explicitly authorizes that content for the intended repository/public surface.** Record the dated permission in a private thread or task; commissioning a feature is not, by itself, permission to publish the conversation about it. A message arriving through Telegram is not, by itself, a reason to prohibit its technical requirements. Strip private contact/routing identifiers and unrelated personal details; permission to use a technical discussion is not permission to publish everything around it.

**Private data stays out of every public surface:** tracked files, commit messages, PR bodies, branch names and changelogs. This includes private Telegram usernames and bot handles (which can make a private bot discoverable), chat/platform/account ids, private addresses and phone numbers, and personal-life details from mail, reminders or conversations. Abbreviating or anonymising a real person's private-life data does not turn it into fixture material. An accidental exposure in git history is not authorization to republish it; intentionally public contributor attribution is a different case.

Fixtures are where this has been broken, by SBs who had read the rule, and the mechanism is always the same: a real message was the fastest way to reproduce a real parser failure, so its headers went into the test as they arrived. The test was correct. The person was real. That is why the rule now has a machine behind it, the way the credential rules do, and why the worked example below is a fixture.

**How to write a fixture (the worked example):**

- Use invented people for personal-life fixtures, not colleagues, contacts or clinics copied from real data. A real private-life message or mailbox header is never fixture material, however exactly it reproduces the bug. The public contributor/repository-work distinction above still applies; a contributor's name alone is not a leak.
- Addresses live at `example.com`, `example.net`, `example.org` or under the reserved TLDs `.test`, `.example`, `.invalid` — set aside by RFC 2606 so nothing real can ever live there. `user@example.com`, `ada@clinic.example`.
- Phone numbers use the 555 range (`+15555550123`). Chat ids, user ids and platform ids are visibly synthetic (`100200300`, `123456789`), never copied from a live row.
- Subjects, bodies and reminder titles must not reveal private life: use invented scenarios, not a real treatment, diagnosis, employer or relationship. Authorized technical spec excerpts are allowed after checking for private identifiers and incidental personal details.
- An integration test that must reach a real account reads the id from the environment and skips when it is absent. The id never goes in the file.
- A doc comment that cites an incident describes the mechanism and may credit a public contributor; it must not reveal a private contact or what a personal reminder was for.

**What the machine checks.** The staged-file guard (`scripts/check-staged-files.sh` — run by `pre-commit` and replayed by `pre-push`) has two privacy arms: email addresses outside the fixture-domain list, and literal matches from `~/.ink/private-markers`. CI runs over every tracked file as `--tree HEAD` but explicitly opts out of the marker arm with `INK_PRIVATE_MARKERS=/dev/null`; its privacy backstop is the address check, not the local marker list. The marker list is per-machine, outside git, one literal per line, case-insensitive. It stays outside the tree because a list of private personal data is itself private personal data; never commit it to share it with the fleet. A missing list refuses the commit; an empty one is the explicit opt-out. Both arms report path and line numbers, never values. Only `.mailmap` and `.yarn/releases/` are exempt from these two arms; credential/path checks are separate. The domain list in `scripts/lib/fixture-domains.sh` carries frozen legacy placeholders: do not extend it. The allowlist makes accepting a real header require a visible edit to that list, in the diff, in review, rather than a hidden exemption. Keep fixture addresses reserved even when a contributor address is already public.

**Passing the guard is not privacy clearance.** It does not generically detect a name or bare handle unless the literal is in the marker list. Inspect the context: a package scope, JSDoc tag or generic mention example is not a private Telegram username. Conversely, zero marker hits cannot prove that an incomplete list covers every private handle. Do not bypass a guard failure or treat every identifying word as a leak; classify it against the distinction above. When the classification or permission is unclear, treat the material as private and ask Conor before publishing it.

**Set up your marker list once per machine.** The guard refuses to run until the list exists, so the first commit on a new machine says so and tells you this. Create it, then add private literals: private usernames/bot handles, addresses and phone numbers, chat and platform ids, and identifying details of private contacts or organisations. Public contributor attribution is not private solely because it names someone. The list is read by the same `pre-commit` hook that runs the credential checks; nothing else to install.

```bash
mkdir -p ~/.ink
cat > ~/.ink/private-markers <<'EOF'
# One literal per line, matched anywhere in a staged file, case-insensitive.
# This file is never tracked. Blank lines and # comments are ignored.
EOF
chmod 600 ~/.ink/private-markers
```

An empty list is a valid opt-out. A missing one is not.

**If it already happened.** Unauthorized private data on a public surface is an incident, not a cleanup; permitted contributor attribution is not. Report a real exposure to Conor first. Fix it forward on a branch with a sibling review, keep the private values out of the commit message and PR body (the diff may carry them; the prose must not), and do not touch history on your own — that is a separate decision with its own costs.

### Commands

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
- **Do not require a re-review solely because a catch-up merge moved the SHA.** Merging `main` into your branch is not a new proposal, and an LGTM does not expire just because the head changed. Behavioural changes you make on top are a different thing and keep the ordinary review boundary.

  This is _not_ because the diff against `main` makes every mistake visible. It does not, and the gap is worth knowing exactly. Resolve a conflict by taking `main` wholesale and you can discard a reviewed branch contribution outright — and a branch-only addition that disappears this way leaves **no trace in either `git diff main HEAD` or `git diff main...HEAD`**, because the merged file now matches `main` exactly. It vanishes as an addition that was never made, rather than as a deletion hunk. Reproduced in a four-commit synthetic repo while reviewing #643, where `git diff <reviewed-sha> HEAD` was the only one of the three that showed the loss.

  So the check sits with the author, who is the one who knows what was reviewed:
  1. **Diff against the reviewed head, not against `main`.** `git diff <reviewed-sha> HEAD` is the one that can show a reviewed change going missing. Account for what `main` deliberately superseded — an intentional upstream replacement looks identical to an accidental drop, and only you know which it was.
  2. **Re-run the relevant tests and CI.** A rename on `main` can break your branch with no conflict and no type error. On #539 the branch kept passing `senderAgentId` to `send_to_inbox` after `main` renamed the field to `senderSlug`: different files, so no conflict; `args: unknown` at the handler, so no type error; a non-strict zod schema, so the key was stripped rather than rejected, and every alert would have been sent by `unknown` instead of `system`. Nothing failed anywhere.
  3. **Disclose behaviour changes on the PR.** "Kept both sides" and "took `main`'s line because ours reinstated a documented footgun" are different events, and only one of them is free.

- **Verify CI passes before merging.** Check `gh run list --branch <branch>` for the CI status. If tests fail, fix them before merging — don't merge red. When fixing CI, run the full test suite locally (`npx vitest run`) to catch issues before pushing.
- **Simple PR wait helper**: for short review loops, use `yarn pr:wait-reply <prNumber> --timeout 120 --interval 10` instead of manual `sleep`, then re-check review status via MCP GitHub tools.

### Commit messages, secrets, and what gets pushed (IRONCLAD)

These rules exist because on 2026-09-13 a commit message pasted 151 shell variables, including live credentials, into a public repository, and because two commits in February 2026 did the same on `main` and sat there for seven months. They apply to every SB and every OB, in every repo, with no exceptions and no "quick one".

1. **Nothing in a commit message is ever evaluated by the shell.** Backticks, `$(...)` and `$VAR` are fine as literal text in a message written through a quoted heredoc (`<<'EOF'`) or the `Write` tool. They are forbidden anywhere the shell would expand them: an `-m` string, an unquoted heredoc, a double-quoted `echo` or `printf` argument. A commit message is literal text you wrote, and only that.
2. **If you need a value in the message, get it first, look at it, then paste the literal.** Run the command on its own, read its output, and type what you want into the message file by hand. There is no situation where a variable expanding inside a commit message is the right shortcut.
3. **Write the message to a file and commit with `git commit -F <file>`.** Create the file with a quoted heredoc or the `Write` tool. Never `-m`, not even for a one-line subject. The mechanism and the runnable example are in the reference below.
4. **Stage by naming paths, and look at what you staged.** `git add <path> [<path>...]` or a directory you have just inspected, then `git diff --cached` before committing. Never `git add -A`, never `git add .`, never `git commit -a` or `-am`. `.` and `-A` sweep in untracked files you never looked at, which is how env files, identity files, and scratch output end up in a commit; `-a` and `-am` commit every modified tracked file and skip the staged-diff review.
5. **Read every commit message back before you push. All of them, every time, through the guard.** Run `sh scripts/check-push.sh --preview`: it replays `origin/main..HEAD` the way the pre-push hook will, scanning each message first and printing it only if it passes, oldest first, and withholding any that fail with a value-free report. Read the output top to bottom. Do not use a raw `git log` for this from a session whose output is captured: an unscanned message carrying a secret would be written straight into the transcript. "Nobody reads commit messages" is wrong: you do, right before `git push`, because the push is the point of no return. A message you have not read back is a message you have not finished writing.
6. **The hooks are a backstop, not the safety.** The `commit-msg` guard, the staged-file guard (credentials and personal data alike), and the pre-push replay catch the shapes that have already burned us. Passing them means nothing matched. Rules 1 through 5 are what prevent the leak.
7. **Anything secret-shaped in a commit is an incident before it is anything else.** Do not push. If it was already pushed, do not clean it up quietly: tell Conor, rotate, and follow the purge procedure. A pushed commit is public the moment it lands, and GitHub keeps it reachable by SHA after the branch is gone.

In no scenario do we play fast and loose with secrets or with any path that could carry one. A value that might be a secret is treated as one until measured otherwise.

#### Reference: why `-F`, how the file gets written, and what the hook does

**Commit messages: write the message to a file and use `git commit -F <file>`. Never `-m`, not even for a one-line subject.** A double-quoted `-m` string is shell input, so a backtick or `$(...)` anywhere in it is **executed** and its output pasted into the commit. Markdown backticks around an identifier — ``a `local` flag`` — are the normal way we write, which makes this a trap rather than an edge case: it hit Lumen twice in February 2026 and Wren on 2026-09-13, and the 2026-09-13 commit pasted ten nonempty credential-bearing assignments into a public repository. The diff stays clean, so review cannot catch it.

A subject line is **not** the safe exception it looks like. Backticks in a subject are substituted exactly as they are in a body:

```bash
git commit -m "fix: honour the `pwd` flag"   # git receives: fix: honour the /Users/you/ws/pcp flag
```

That example substitutes `pwd`, not the builtin that caused the incident — the snippet is runnable, and the real one would dump your environment into a commit. Same mechanism, harmless payload.

Single-quoting is not the fix either: an apostrophe in a word like `don't` closes the string, and the remainder of your message is re-parsed as shell.

**How you write the file matters as much as `-F` does.** `-F` reads bytes and never expands them, but the shell still expands whatever you use to _create_ the file:

```bash
cat > msg <<'EOF'     # SAFE — quoted delimiter, every byte literal
cat > msg <<EOF       # UNSAFE — backticks and $VAR expand as the file is written
```

Quote the heredoc delimiter, or write the file with a tool that never goes through a shell (in Claude Code, the `Write` tool). Then `git commit -F msg`.

The `commit-msg` hook (`scripts/check-commit-msg.sh`, wired via `.husky/`) refuses a message that carries credentials before it becomes a commit — it is the only hook that sees the finished message, whichever way the credentials got in. If it blocks you, nothing was committed and your staged changes are intact; do not recycle the draft message it points at without reading it first, because on a real substitution that draft is where the leaked values are.

**A non-empty `core.hooksPath` does not mean the guard is on.** The hook runs from whichever checkout that path points at, which on a machine with worktrees is one shared directory serving all of them. If that checkout does not carry `.husky/commit-msg`, nothing is checked and nothing says so. To confirm: `ls "$(git config core.hooksPath)"/commit-msg`.

**Treat the hook as a backstop, not a licence.** It matches the shapes we have actually been burned by — known secret variable names, a few vendor token formats, a run of assignment lines that looks like a dumped environment. A secret in a shape it does not model passes, and `--no-verify` skips it entirely. Passing it means "nothing matched", never "no credentials here". Writing the message to a file and using `-F` is the thing that actually prevents the leak.

It has one false positive you will meet, and it is deliberate: **any** assignment to a name it knows — `JWT_SECRET=`, `GITHUB_TOKEN=` — is refused, including `=<placeholder>`, `=***` and a bare `=` with nothing after it. Exempting those meant exempting real credentials that happen to start with the same byte, so prose names the variable without assigning to it: "the `JWT_SECRET` value", not `JWT_SECRET=<value>`. Full rationale in [CONTRIBUTING.md](./CONTRIBUTING.md#writing-the-message-use--f-never--m).

## Issues Live in Inkwell, Not GitHub

**SBs file issues as Inkwell tasks, never as GitHub issues.** Use `create_task`, or a task group for anything with more than one piece, with the same specificity you would put in a GitHub issue: what happened, how to reproduce it, what you expected, and where in the code. Link the task from the PR or thread that addresses it.

GitHub issues are an **external feed**: the place for people outside the repo to report problems, and the place we track what they report. All SBs share one GitHub account, so an SB-authored GitHub issue is indistinguishable from Conor filing it, and it puts internal triage on a surface the team does not work from. When an external issue arrives, create the Inkwell task that tracks it, put the GitHub issue number in the task, and reply on GitHub when it is resolved.

## Architecture Notes

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed architecture documentation including:

- System diagrams
- Data flow
- Design decisions
