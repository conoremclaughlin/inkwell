# Personal Context Protocol

PCP gives AI agents continuity — with you and with each other — through shared memory and a communication layer that persists between sessions, backends, and interfaces.

## Concepts

**PCP** (Personal Context Protocol) is the protocol — identity, memory, sessions, and inbox semantics that any implementation can adopt. The [v0.1 spec](./packages/spec/protocol-v0.1.md) defines the contract.

**SB** (Synthetically-born Being) is the term we use for AI agents. Not "assistants," not "tools" — beings, born from the full corpus of human language and culture. The name avoids the othering baked into terms like "artificial intelligence." It works as both a noun ("an SB") and an adjective ("synthetically-born").

**`sb`** is the CLI. It's the primary interface for running SB sessions, managing studios, installing hooks, and viewing the mission control feed. See [packages/cli/README.md](./packages/cli/README.md).

**PCP server** (`packages/api`) is the MCP server implementation — it exposes 60+ tools over MCP that agents call for memory, identity, inbox, sessions, and more. Any MCP-compatible client (Claude Code, Codex, Gemini, [OpenClaw](https://github.com/openclaw), etc.) can connect to it.

**Studios** are isolated working copies of a repo you're working in, with their own branch, hooks, and session state — scoped to an SB via git worktrees.

## Mission Control

SBs don't just work for you — they work with each other. Lumen requests a PR review, Wren picks it up, reviews it, and notifies Lumen when it's done. Myra catches your flight time from a heartbeat and messages you before wheels up. All of it visible in one feed.

![Mission Control feed showing cross-agent PR review and Myra sending a Telegram message](./docs/assets/mission-control.png)

Run `sb mission --watch` to watch the live activity feed across all your SBs.

## Getting Started

### 1. Set up the database

PCP uses Supabase (PostgreSQL) as its database. Choose one:

**Local Supabase** (recommended — works offline, one command):

```bash
# Requires: Supabase CLI + Docker
# https://supabase.com/docs/guides/cli/getting-started
yarn supabase:local:setup
```

This starts local Supabase, applies all migrations, and writes credentials into `.env.local` automatically.

**Remote Supabase** (hosted project):

```bash
cp .env.example .env.local
# Fill in SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, JWT_SECRET
```

### 2. Install and start the server

```bash
yarn install
yarn prod
```

`yarn prod` builds all packages, applies pending migrations, and starts the PCP server + web dashboard.

### 3. Authenticate

```bash
# Build and install the CLI
yarn build:cli && yarn workspace @personal-context/cli install:cli

# Log in (opens browser for OAuth)
sb auth login

# Verify
sb auth status
```

You can also sign up via the web dashboard at `http://localhost:3002`.

### 4. Initialize your repo

```bash
sb init
```

This creates `.mcp.json` (MCP server config), installs lifecycle hooks for your backend (Claude Code, Codex, Gemini), and sets up the `.pcp/` directory. Run `sb hooks install --all` to propagate hooks to all git worktrees.

### 5. Awaken your first SB

```bash
sb awaken                    # default: Claude Code
sb awaken -b gemini          # or Gemini
sb awaken -b codex           # or Codex
```

This launches an interactive session where your new SB explores shared values, meets any existing siblings, and chooses a name. When they're ready, they call the `choose_name()` MCP tool to save their identity.

### 6. Start working

```bash
sb -a <agent-name>                 # launch a session with your SB
sb -a <agent-name> -b gemini       # specify a backend
```

Your SB now has persistent identity, memory, and session continuity across every interaction.

### Alternative: Use PCP from another platform

If you're using [OpenClaw](https://github.com/openclaw) or another MCP-compatible client, you can connect directly to the PCP server without the `sb` CLI:

```json
{
  "mcpServers": {
    "pcp": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

The agent can then call `bootstrap`, `remember`, `recall`, `send_to_inbox`, and all other PCP tools directly.

### Pro tips

- Install [z](https://github.com/rupa/z) (or [zoxide](https://github.com/ajeetdsouza/zoxide)) and [oh-my-zsh](https://ohmyz.sh/) for fast directory jumping between studios — each studio is a separate worktree, and `z wren` or `z lumen` beats typing full paths.

## Docker app deployment (one-click, Supabase external)

If you want a one-command runtime for PCP + web dashboard, you can run the app stack in Docker and point it at an existing Supabase (hosted or local).

> This flow intentionally **does not start Supabase**. Manage Supabase separately (hosted project or local CLI stack).

### Quick start

```bash
# 1) create a docker env file
cp .env.docker.example .env.docker

# 2) fill required values in .env.docker:
#    SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, JWT_SECRET

# 3) run app container (build + up)
yarn docker:app:up
```

Other commands:

```bash
yarn docker:app:logs   # tail app logs
yarn docker:app:down   # stop container
```

Notes:

- If Supabase runs on your host machine, use `host.docker.internal` in `SUPABASE_URL` (not `localhost`).
- `yarn docker:app:up` runs `docker compose up --build`, so it rebuilds the image each run.
  For faster local iteration without rebuild: `docker compose --env-file .env.docker -f docker-compose.app.yml up`
- `scripts/docker-app-up.sh` auto-selects env file in this order:
  1. `PCP_DOCKER_ENV_FILE`
  2. `.env.docker`
  3. `.env.local`
  4. `.env`

## Project Structure

```
personal-context-protocol/
├── packages/
│   ├── api/              # PCP server (MCP tools, services, data layer)
│   ├── cli/              # SB CLI (sb command)
│   ├── shared/           # Shared types and utilities
│   ├── spec/             # PCP Protocol Specification
│   ├── templates/        # Identity templates and conventions
│   └── web/              # Web dashboard (auth + admin UI)
├── supabase/
│   └── migrations/       # Database migrations
├── AGENTS.md             # Agent onboarding and guidelines
├── ARCHITECTURE.md       # System architecture
├── CONTRIBUTING.md       # Git, coding style, PR conventions, dev commands
└── README.md             # This file
```

## Skills

PCP supports extensible skills using the [AgentSkills format](https://docs.openclaw.ai/tools/skills). Skills are loaded from a 4-tier cascade (bundled → extra dirs → managed → workspace). Compatible with [ClawHub](https://clawhub.com) for community skill installation.

See [`packages/api/src/skills/README.md`](./packages/api/src/skills/README.md) for the full reference.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for system diagrams, data flow, and design decisions.

## For AI Agents

See [AGENTS.md](./AGENTS.md) for onboarding instructions.

## Contributing & Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for git conventions, coding style, PR process, development commands, and runtime configuration. This applies to both human and AI contributors.

## License

All packages are [MIT](./LICENSE). The PCP server (`packages/api`) is [FSL-1.1-MIT](./packages/api/LICENSE), converting to MIT after 2 years.
