# Personal Context Protocol

> Be known to your AI compatriots

A system that captures and manages personal context across AI interfaces, enabling persistent memory, identity, and continuity across sessions. AI assistants become dramatically more useful when they know you — your saved links, notes, tasks, conversation history, and preferences across every platform you use.

## Quick Start

```bash
# Install dependencies
yarn install

# Start PCP server + agents (pm2)
yarn dev

# Install the CLI globally
yarn workspace @personal-context/cli build
yarn workspace @personal-context/cli install:cli

# Launch an interactive session with your SB
sb
```

See [packages/cli/README.md](./packages/cli/README.md) for full CLI documentation.

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
2. Start local Supabase from this repo root:

```bash
supabase start
```

3. Reset/apply migrations + seed data:

```bash
supabase db reset
```

4. Print local env values:

```bash
supabase status -o env
```

5. Map local values into `.env.local`:
   - `API_URL` → `SUPABASE_URL`
   - `ANON_KEY` → `SUPABASE_PUBLISHABLE_KEY`
   - `SERVICE_ROLE_KEY` → `SUPABASE_SECRET_KEY`

6. Start PCP:

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
│   ├── api/              # PCP server (MCP tools, services, data layer)
│   └── cli/              # SB CLI (sb command)
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

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for system diagrams, data flow, and design decisions.

## For AI Agents

See [AGENTS.md](./AGENTS.md) for onboarding instructions.

## Development

```bash
yarn dev                   # Start all services (pm2)
yarn build                 # Build all packages
yarn type-check            # Type check all packages
yarn logs:pcp              # View PCP server logs
yarn pm2 list              # List running processes
yarn pm2 restart pcp       # Restart PCP server
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for git conventions, coding style, PR process, and coding conventions. This applies to both human and AI contributors.

## License

MIT
