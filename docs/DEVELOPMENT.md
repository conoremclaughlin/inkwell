# Development Guide

This guide covers the development workflow for the Personal Context Protocol (PCP) project.

## Architecture Overview

The project runs as **three separate processes** for optimal development experience:

| Process | Purpose | Restarts on code changes? |
|---------|---------|---------------------------|
| **mcp** | MCP Server - tools, admin API, database | Yes (auto-restart) |
| **myra** | Messaging - Telegram/WhatsApp connections | No (manual only) |
| **web** | Next.js admin dashboard | Yes (HMR) |

### Why Separate Processes?

**Myra** holds authentication sessions for Telegram and WhatsApp. These connections:
- Take time to establish (WhatsApp QR scanning)
- Should persist while you develop
- Only need restart when messaging code changes

**MCP Server** handles tools and API endpoints. It can restart freely without affecting messaging connections.

**Web App** uses Next.js Hot Module Replacement (HMR) for instant updates.

## Getting Started

### Prerequisites

```bash
# Install pm2 globally
npm install -g pm2

# Install dependencies
yarn install
```

### Start Development

```bash
# Start all three processes
yarn dev

# View process status
yarn status

# View logs (all processes)
yarn logs

# View Myra logs only
yarn logs:myra
```

### Managing Processes

```bash
# Restart MCP server only (Myra stays connected)
yarn restart:mcp

# Restart Myra (reconnects Telegram/WhatsApp)
yarn restart:myra

# Stop everything
yarn stop

# Clean up pm2 processes
pm2 delete all
```

## Process Details

### MCP Server (`mcp`)

**Entry point:** `packages/api/src/index.ts`

**Features:**
- MCP tools for context management
- Admin REST API at `/api/admin/*`
- Auto-restarts when code in `packages/api/src/` changes
- Ignores changes to `src/myra/` directory

**Port:** 3001

### Myra (`myra`)

**Entry point:** `packages/api/src/myra/index.ts`

**Features:**
- Telegram bot listener
- WhatsApp listener (optional, set `ENABLE_WHATSAPP=true`)
- Claude Code backend for AI processing
- Persistent process - survives MCP restarts

**Configuration:**
```bash
# In packages/api/.env
TELEGRAM_BOT_TOKEN=your_bot_token
ENABLE_WHATSAPP=true  # Optional
```

**Manual restart only:**
```bash
yarn restart:myra
# or
pm2 restart myra
```

### Web App (`web`)

**Entry point:** `packages/web/`

**Features:**
- Next.js 16 admin dashboard
- Supabase Auth with magic links
- Admin pages for trusted users, groups, challenge codes
- WhatsApp QR display

**Port:** 3002

## Environment Variables

### packages/api/.env

```bash
# Required
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_KEY=your_service_key

# Telegram (for Myra)
TELEGRAM_BOT_TOKEN=your_bot_token

# WhatsApp (optional)
ENABLE_WHATSAPP=true

# MCP
MCP_TRANSPORT=http
MCP_HTTP_PORT=3001
```

### packages/web/.env.local

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
API_URL=http://localhost:3001
```

## Development Workflow

### Typical Session

1. Start all processes: `yarn dev`
2. Open dashboard: http://localhost:3002
3. Send messages via Telegram/WhatsApp
4. Edit code - MCP/web restart automatically, Myra stays connected
5. When done: `yarn stop`

### When to Restart Myra

Restart Myra (`yarn restart:myra`) when you change:
- `packages/api/src/myra/` code
- `packages/api/src/channels/` code (Telegram/WhatsApp listeners)
- `packages/api/src/agent/` code (Session Host)
- System prompt configuration

### Viewing Logs

```bash
# All logs with colors
pm2 logs

# Myra only
pm2 logs myra

# MCP only
pm2 logs mcp

# Web only
pm2 logs web

# Follow mode (like tail -f)
pm2 logs --lines 50
```

## PM2 Tips

### Save Process List

```bash
# Save current process list
pm2 save

# Restore on system startup
pm2 startup
```

### Monitor Resources

```bash
# Interactive monitor
pm2 monit

# Status with memory/CPU
pm2 status
```

### Flush Logs

```bash
pm2 flush  # Clear all logs
```

## Troubleshooting

### Port Already in Use

```bash
# Find process on port 3001
lsof -i :3001

# Kill it
kill -9 <PID>

# Or use pm2 to restart
pm2 restart mcp
```

### Myra Not Receiving Messages

1. Check Telegram token is valid
2. Ensure bot was started with `/start` command
3. Check logs: `pm2 logs myra`

### WhatsApp QR Not Showing

1. Set `ENABLE_WHATSAPP=true` in `.env`
2. Restart Myra: `yarn restart:myra`
3. Check logs for QR output: `pm2 logs myra`

### MCP Tools Not Working

1. Ensure MCP server is running: `pm2 status`
2. Check port 3001 is accessible
3. Verify `.mcp.json` config file exists

## MCP Transport TODOs

- Revisit full SSE stream support for `GET /mcp` in Streamable HTTP mode (resumability / server-pushed notifications).
- Keep compatibility notes for Gemini CLI and other MCP clients that probe `GET /mcp` during discovery.

## Running Individual Processes

For debugging, you can run processes individually without pm2:

```bash
# MCP server only
yarn dev:mcp

# Myra only
yarn dev:myra

# Web only
yarn dev:web
```

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        User                                  │
│            (Telegram / WhatsApp / Web Dashboard)            │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│     Myra      │  │  MCP Server   │  │   Web App     │
│  (Persistent) │  │ (Restartable) │  │   (HMR)       │
│               │  │               │  │               │
│ • Telegram    │  │ • Tools       │  │ • Dashboard   │
│ • WhatsApp    │──│ • Admin API   │──│ • Auth        │
│ • Claude Code │  │ • Database    │  │ • Settings    │
│               │  │               │  │               │
│   Port: N/A   │  │  Port: 3001   │  │  Port: 3002   │
└───────────────┘  └───────────────┘  └───────────────┘
        │                  │
        │                  │
        ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│                      Supabase                                │
│              (PostgreSQL + Auth + Storage)                   │
└─────────────────────────────────────────────────────────────┘
```
