# Development Guide

This guide covers the development workflow for the Personal Context Protocol (PCP) project.

## Architecture Overview

PCP runs as a **single unified server** process that hosts all services:

| Service     | Purpose                             | Port              |
| ----------- | ----------------------------------- | ----------------- |
| **API/MCP** | MCP tools, admin API, agent gateway | `PCP_PORT_BASE`   |
| **Web**     | Next.js admin dashboard             | `PCP_PORT_BASE+1` |
| **Myra**    | Telegram/WhatsApp messaging bridge  | `PCP_PORT_BASE+2` |

Default `PCP_PORT_BASE` is **3001**, so API runs on 3001, web on 3002, Myra on 3003.

## Getting Started

### Prerequisites

```bash
# Install dependencies
yarn install
```

### Start Development

```bash
# Start all services with hot reload
yarn dev

# View server logs
yarn logs:pcp              # Structured JSON logs
yarn logs:pcp:raw          # Raw log output
yarn logs:pcp:errors       # Errors only
```

`yarn dev` runs `scripts/dev-concurrently.mjs`, which starts API and web in parallel with hot reload. Migration status warnings are checked on startup.

### Running on a Different Port

To run an isolated instance (e.g., for testing changes without disrupting the main server):

```bash
# Starts API on 4001, web on 4002, Myra on 4003
PCP_PORT_BASE=4001 yarn dev

# Point CLI at your test server
PCP_SERVER_URL=http://localhost:4001 sb mission
```

Both instances share the same Supabase database, so data changes are visible to both.

## Environment Variables

Environment is configured via `.env` files at the **project root** (not per-package):

| File               | Purpose                                 |
| ------------------ | --------------------------------------- |
| `.env`             | Base config (can be committed)          |
| `.env.local`       | Machine-specific overrides (gitignored) |
| `.env.development` | Development-specific (or `.env.dev`)    |
| `.env.production`  | Production-specific (or `.env.prod`)    |

Priority (highest wins): shell env > `.env.local` > `.env.{NODE_ENV}` > `.env`

### Required Variables

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your_publishable_key
SUPABASE_SECRET_KEY=your_secret_key
JWT_SECRET=your_jwt_secret_min_32_chars
```

### Optional Variables

```bash
PCP_PORT_BASE=3001              # Base port (default: 3001)
MCP_TRANSPORT=http              # stdio or http (default: stdio)
TELEGRAM_BOT_TOKEN=...          # For Myra Telegram
ENABLE_WHATSAPP=true            # WhatsApp support
ENABLE_DISCORD=false            # Discord bot
LOG_LEVEL=info                  # error, warn, info, debug
```

## Development Workflow

### Typical Session

1. Start all services: `yarn dev`
2. Open dashboard: http://localhost:3002
3. Edit code — API and web restart automatically
4. When done: Ctrl+C

### Viewing Logs

Winston writes structured logs to `~/.pcp/logs/`:

```bash
yarn logs:pcp              # Formatted JSON logs
yarn logs:pcp:errors       # Errors only

# Or tail directly
tail -f ~/.pcp/logs/combined.log
```

### Running Individual Services

For debugging, run services individually:

```bash
yarn dev:api               # API server only
yarn dev:web               # Web dashboard only
yarn dev:mcp               # MCP server (stdio mode)
```

## Production

```bash
yarn prod                  # One-shot: build + migrate + start
# Or step by step:
yarn prod:refresh          # Install + build after git pull
yarn prod:migrate          # Apply pending migrations
yarn prod:direct           # Start (no rebuild)
```

For containerized deployment, see `docker-compose.app.yml`.

## Troubleshooting

### Port Already in Use

```bash
# Find process on port 3001
lsof -i :3001

# Kill it
kill -9 <PID>
```

### MCP Tools Not Working

1. Check the server is running and port 3001 is accessible
2. Verify `.mcp.json` config file exists in the project root
3. Check logs: `yarn logs:pcp`

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        User                                  │
│      (Telegram / WhatsApp / Web Dashboard / CLI)            │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│     Myra      │  │  MCP Server   │  │   Web App     │
│  (Messaging)  │  │  (API + Tools)│  │   (HMR)       │
│               │  │               │  │               │
│ • Telegram    │  │ • MCP Tools   │  │ • Dashboard   │
│ • WhatsApp    │──│ • Admin API   │──│ • Auth        │
│ • Discord     │  │ • Gateway     │  │ • Settings    │
│               │  │               │  │               │
│  Port: +2     │  │  Port: base   │  │  Port: +1     │
└───────────────┘  └───────────────┘  └───────────────┘
        │                  │
        │                  │
        ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│                      Supabase                                │
│              (PostgreSQL + Auth + Storage)                   │
└─────────────────────────────────────────────────────────────┘
```
