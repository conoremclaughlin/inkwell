# Personal Context Protocol

> Be known to your AI compatriots

A system that captures and manages personal context across AI interfaces, enabling persistent memory, identity, and continuity across sessions. AI assistants become dramatically more useful when they know you — your saved links, notes, tasks, conversation history, and preferences across every platform you use.

## Prerequisites

PCP requires a **Supabase** database (PostgreSQL). You can use either a hosted Supabase project or run one locally via Docker. See [Database Setup](#database-setup-supabase) below for both options.

You'll need a `.env.local` file with your Supabase credentials before starting the server — without it, the PCP server will fail to connect. Copy `.env.example` and fill in your `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY`.

## Quick Start

```bash
# Install dependencies
yarn install

# Set up Supabase (see Database Setup section) and create .env.local first!

# Start PCP server + agents (pm2)
yarn dev

# Install the CLI globally
yarn workspace @personal-context/cli build
yarn workspace @personal-context/cli install:cli

# Initialize PCP in this repo (hooks, .mcp.json, backend configs)
sb init

# Install hooks across all worktrees
sb hooks install --all

# Launch an interactive session with your SB
sb
```

See [packages/cli/README.md](./packages/cli/README.md) for full CLI documentation.

### MCP Configuration

Each working directory (studio/worktree) needs a `.mcp.json` file so the agent can connect to PCP and other MCP servers. `sb init` creates this automatically, but you can also create it manually:

```json
{
  "mcpServers": {
    "supabase": {
      "type": "http",
      "url": "https://mcp.supabase.com/mcp",
      "headers": {
        "x-supabase-project-ref": "<your-project-ref>"
      }
    },
    "pcp": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

`sb init` also syncs this to backend-specific formats (`.codex/config.toml`, `.gemini/settings.json`) and installs lifecycle hooks. Run `sb hooks install --all` to propagate hooks to all git worktrees at once.

## Database Setup (Supabase)

PCP supports both:

- **Remote Supabase** (hosted Supabase project)
- **Local Supabase** (Docker + Supabase CLI)

### Option A: Remote Supabase (quickest to start)

1. Create/select a Supabase project.
2. Copy your project URL + API keys.
3. Fill `.env.local` from `.env.example`:
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SECRET_KEY`
4. Start PCP:

```bash
yarn dev
```

### Option B: Local Supabase (best for offline/dev parity)

1. Install Supabase CLI and Docker:
   - Supabase CLI install docs: https://supabase.com/docs/guides/cli/getting-started
2. Run one command from repo root to start local Supabase, reset DB, and update `.env.local`:

```bash
yarn supabase:local:setup
```

This helper:

- starts local Supabase (Docker required)
- applies migrations + seed (`supabase db reset --local`)
- reads local env values from `supabase status -o env`
- writes them into `.env.local`

If `.env.local` already has `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, or `JWT_SECRET`, the helper **won't overwrite** them. It logs a warning and writes local references instead:

- `LOCAL_SUPABASE_URL`
- `LOCAL_SUPABASE_PUBLISHABLE_KEY`
- `LOCAL_SUPABASE_SECRET_KEY`
- `LOCAL_JWT_SECRET`

3. Start PCP:

```bash
yarn dev
```

Useful Supabase docs:

- Local development workflow: https://supabase.com/docs/guides/cli/local-development
- CLI reference (`start`, `status`, `db reset`, etc.): https://supabase.com/docs/reference/cli/start
- API key types and guidance: https://supabase.com/docs/guides/api/api-keys

## Project Structure

```
personal-context-protocol/
├── packages/
│   ├── api/              # PCP server (MCP tools, services, data layer) [FSL-1.1-MIT]
│   ├── cli/              # SB CLI (sb command)
│   ├── shared/           # Shared types and utilities
│   ├── spec/             # PCP Protocol Specification
│   ├── templates/        # Identity templates and conventions
│   └── web/              # Admin dashboard
├── stories/              # Feature specs and design docs
│   └── cli/              # CLI-related stories
├── supabase/
│   └── migrations/       # Database migrations
├── AGENTS.md             # Agent onboarding and guidelines
├── ARCHITECTURE.md       # System architecture
├── CLAUDE.md             # Claude Code entrypoint (points to AGENTS.md)
├── CONTRIBUTING.md       # Git, coding style, and PR conventions
└── README.md             # This file
```

## Stories

Feature work lives in `stories/`, grouped by domain. Each story contains specs, research, and the feature-specific source files that don't belong in a generic shared folder:

```
stories/
├── cli/                  # CLI features (backends, flags, install)
├── channels/             # Messaging integrations
├── mcp/                  # MCP tools and server
└── agents/               # Multi-agent orchestration
```

Stories are living documents — update them as the feature evolves.

## Key Technologies

- **Runtime**: Node.js 18+, TypeScript, Yarn 4 workspaces
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Database**: Supabase (PostgreSQL + pgvector)
- **Messaging**: Telegraf (Telegram), Baileys (WhatsApp)
- **Process Management**: pm2
- **CLI**: Commander.js

## Skills

PCP supports extensible skills using the [AgentSkills format](https://docs.openclaw.ai/tools/skills). Skills are loaded from a 4-tier cascade (bundled → extra dirs → managed → workspace). Compatible with [ClawHub](https://clawhub.com) for community skill installation.

See [`packages/api/src/skills/README.md`](./packages/api/src/skills/README.md) for the full reference and [AGENTS.md](./AGENTS.md#skills) for agent-facing docs.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for system diagrams, data flow, and design decisions.

## For AI Agents

See [AGENTS.md](./AGENTS.md) for onboarding instructions.

## Development

```bash
yarn dev                   # Start all services (pm2)
yarn dev:direct            # Start API+web directly (no pm2, dev mode)
yarn local:status          # Show local migration status explicitly
yarn linked:status         # Show linked (remote) migration status explicitly
yarn local:migrate         # Apply local migrations explicitly
yarn linked:migrate        # Apply linked (remote) migrations explicitly
yarn prod:refresh          # Install + build latest code after pull
yarn prod:migrate          # Apply pending migrations (auto local/linked via .env.local SUPABASE_URL)
yarn prod:direct           # Run API+web directly in production mode (no pm2)
yarn prod                  # Alias for prod:up (fast path)
yarn prod:up               # One-shot: refresh build + migrate + start direct prod
yarn build                 # Build all packages
yarn type-check            # Type check all packages
yarn test                  # Unit tests (all workspaces)
yarn supabase:local:setup  # Start/reset local Supabase and sync env values into .env.local
yarn test:integration:db:local  # DB integration suite against isolated local Supabase
yarn test:integration:runtime    # Runtime/CLI integration suite
yarn logs:pcp              # View PCP server logs
yarn pm2 list              # List running processes
yarn pm2 restart pcp       # Restart PCP server
```

`yarn test:integration:db:local` spins up an **isolated, temporary local Supabase stack** with dedicated ports, applies migrations + seed, runs integration tests, then tears it down. This avoids accidental use of remote `.env.local` credentials and keeps integration runs sandboxed from any online dev server.

## Low-power runtime mode (no PM2)

If PM2/watcher overhead is undesirable on laptops, run PCP directly:

```bash
# 1) After pulling latest changes
yarn prod:refresh

# 2) Apply pending migrations (auto local/linked)
yarn prod:migrate

# 3) Start in direct production mode (no PM2)
yarn prod:direct

# Or one-shot:
yarn prod
# (same as: yarn prod:up)
```

Notes:

- `yarn prod:direct` does **not rebuild** on start; it uses existing build artifacts.
- `yarn prod:migrate` / `migration-status` auto-select target:
  - explicit override: `PCP_MIGRATION_TARGET=local|linked`
  - `local` when `SUPABASE_URL` (or `LOCAL_SUPABASE_URL`) points to localhost/127.0.0.1/::1
  - otherwise `linked`
  - source precedence: process env → `.env.local` → `.env`
- You can override auto mode explicitly:
  - `yarn local:status` / `yarn local:migrate`
  - `yarn linked:status` / `yarn linked:migrate`
- `yarn prod:direct` now warns if migrations appear pending for the resolved target.
- `yarn dev` / `yarn dev:direct` also run the same migration-status warning check before starting.
- To run API only (no dashboard process): `PCP_RUN_WEB=false yarn prod:direct`
- After `git pull`, run `yarn prod:refresh` and restart your direct/PM2 process.
- The dashboard and `sb` CLI will warn when the running server is behind local HEAD and needs a restart.
- `sb doctor` includes a migration status check (local or linked) and points to `yarn prod:migrate` / `yarn prod:up` when pending.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for git conventions, coding style, PR process, and coding conventions. This applies to both human and AI contributors.

## License

MIT — matching [MCP](https://github.com/modelcontextprotocol) and [OpenClaw](https://github.com/openclaw).

The PCP server (`packages/api`) is licensed under [FSL-1.1-MIT](./packages/api/LICENSE) (Functional Source License) — source-available with a competing-use restriction, converting to MIT after 2 years. All other packages are [MIT](./LICENSE).
