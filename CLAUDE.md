# Repository Guidelines for Claude

This file provides context and guidelines for AI agents (particularly Claude) working on this codebase.

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

### Link Management
- `save_link` - Save a URL with metadata
- `search_links` - Search saved links
- `tag_link` - Add/remove tags

User identification supports multiple methods:
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
