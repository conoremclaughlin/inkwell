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
├── AGENTS.md             # Agent onboarding (points to CLAUDE.md)
├── ARCHITECTURE.md       # System architecture
├── CLAUDE.md             # Detailed agent guidelines
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

See [AGENTS.md](./AGENTS.md) for onboarding instructions. Detailed guidelines are in [CLAUDE.md](./CLAUDE.md).

## Development

```bash
yarn dev                   # Start all services (pm2)
yarn build                 # Build all packages
yarn type-check            # Type check all packages
yarn logs:pcp              # View PCP server logs
yarn pm2 list              # List running processes
yarn pm2 restart pcp       # Restart PCP server
```

## Git Conventions

### Commits

We use the [Angular commit convention](https://github.com/angular/angular/blob/main/CONTRIBUTING.md):

```
<type>(<scope>): <short summary>
  │       │             │
  │       │             └─⫸ Imperative present tense. Not capitalized. No period.
  │       │
  │       └─⫸ Optional. Succinct, relevant to the initiative.
  │
  └─⫸ feat|fix|refactor|chore|docs|test|perf|build|ci|style
```

Examples:
```
feat(cli): add global install via symlink
fix(sessions): preserve existing fields on upsert
refactor(mcp): extract identity resolution into service
chore: bump typescript to 5.4
```

### Branching

We follow [GitHub flow](https://www.geeksforgeeks.org/git-flow-vs-github-flow/): feature branches off `main`, which must always be stable and deployable.

```
<initials or moniker>/<type>/<scope>
  │                      │       │
  │                      │       └─⫸ Kebab-case. Succinct description.
  │                      │
  │                      └─⫸ Same types as commits.
  │
  └─⫸ Your initials or unique moniker (e.g., cm, wren, myra)
```

Examples:
```bash
git checkout -b cm/feat/agent-orchestrator
git checkout -b wren/fix/session-resume
git checkout -b myra/chore/heartbeat-cleanup
```

When syncing with main: rebase first; if conflicts get messy, merge main in and move on.

### Code Comments

```
<author>(<scope>): <short summary>
  │         │             │
  │         │             └─⫸ Be succinct. Present tense.
  │         │
  │         └─⫸ Optional. todo|bug|???|<commit-style scope>
  │
  └─⫸ Optional. Your initials or common name.
```

A plain comment needs no prefix — any comment is implicitly a note. Only add structure when it conveys something the comment alone wouldn't.

Examples:
```typescript
// cm(todo): extract this into a shared utility
// wren(bug): race condition when two agents write simultaneously
// ???: unclear why this timeout is needed — removing it breaks auth
// Simple explanation needs no prefix
```

## Coding Conventions

- **camelCase** for variables and functions (acronyms treated as words: `userId`, `apiResponse`)
- **PascalCase** for classes and types (`HttpClient`, `UserIdentity`)
- **SCREAMING_SNAKE** for constants
- Strict TypeScript, Zod for runtime validation, `async/await` over callbacks

## License

MIT
