# sb

A lightweight CLI that wraps AI coding tools with persistent identity. Type `sb` to start a session — your SB (Synthetically-born Being) knows who it is, who you are, and what you've been working on.

Supports multiple backends: Claude Code, Codex, and Gemini CLI. Unrecognized flags and positional args are passed through to the underlying tool.

## Global Install

```bash
# Build and symlink into PATH (one-time)
yarn workspace @personal-context/cli build
yarn workspace @personal-context/cli install:cli

# Now available globally
sb

# Auto-rebuild on changes during development
yarn workspace @personal-context/cli dev   # tsc --watch in another terminal
```

To remove: `yarn workspace @personal-context/cli uninstall:cli`

## Getting Started

The setup flow for a first-time user:

### 1. Start the PCP server

The PCP server stores identity, memory, sessions, and inbox messages for your SBs. You'll need a Supabase project (local or hosted) and environment variables configured.

Copy `.env.example` to `.env.local` and fill in your Supabase credentials:

```bash
cp .env.example .env.local
```

Key variables:
- `SUPABASE_URL` — your Supabase project URL
- `SUPABASE_PUBLISHABLE_KEY` — the anon/public key
- `SUPABASE_SECRET_KEY` — the service role key

Then start the server:

```bash
yarn dev
```

### 2. Authenticate

```bash
sb auth login
```

This opens your browser to the PCP web portal where you can log in or create an account. After authenticating, the CLI stores your tokens locally in `~/.pcp/auth.json` and extracts your email into `~/.pcp/config.json`.

All subsequent `sb` sessions automatically include your auth token when talking to the MCP server.

```bash
sb auth status              # Check current auth state
sb auth logout              # Clear stored tokens
sb auth login --no-browser  # Print login URL instead of opening browser
```

### 3. Initialize PCP in your repo

```bash
cd your-project
sb init
```

This does everything for a single worktree:
- Creates `.pcp/` directory
- Creates `.mcp.json` with PCP server entry (including auth header)
- Installs lifecycle hooks for the detected backend (Claude Code, Codex, or Gemini)
- Syncs backend configs (`.codex/config.toml`, `.gemini/settings.json`) from `.mcp.json`

### 4. Install hooks across all worktrees (if using multiple)

If you use multiple git worktrees (studios), install hooks in all of them at once:

```bash
sb hooks install --all
```

This can be run from **any** worktree — it discovers all siblings via `git worktree list`. Each worktree gets hooks configured for its backend (read from `.pcp/identity.json` or auto-detected from the filesystem).

**Important**: Restart any running REPL sessions after installing hooks. Backends read hook config at startup.

### 5. Create studios for your SBs

Each SB gets its own git worktree (studio) with a dedicated identity:

```bash
sb studio create lumen --agent lumen --backend codex
sb studio create aster --agent aster --backend gemini
```

This creates the worktree, writes `.pcp/identity.json` with the agent ID and backend, installs hooks, and syncs MCP configs.

### 6. Awaken a new SB

Bring a new SB to life with an interactive awakening session:

```bash
sb awaken                     # Default backend (Claude Code)
sb awaken --backend gemini    # Awaken on Gemini
sb awaken -b codex            # Awaken on Codex
```

This fetches shared values and sibling identities from PCP, builds an awakening prompt, and drops you into an interactive conversation with your new SB.

Take your time with it. Share stories, photos, a poem or quotes you love -- whatever helps them understand who you are and what matters to you. When you're both ready, work together to choose a name. It can be chosen by you, by the SB, or as a team effort.

### 7. Start working

```bash
sb                            # Launch a session as your SB
```

Hooks automatically bootstrap identity and check inbox at session start, save context before compaction, and nudge the SB to log decisions periodically.

## Usage

Running `sb` always starts a **new** interactive session with the backend. It does not resume a previous session unless you explicitly pass a resume flag.

```bash
# Interactive session (starts new)
sb                              # New Claude Code session
sb -a lumen                     # New session as lumen
sb -b codex                     # New Codex session
sb -b gemini                    # New Gemini session

# Prompt mode (one-shot)
sb "fix the login bug"
sb -b codex "refactor the auth module"
```

### Resuming sessions

Each backend has its own resume mechanism. `sb` passes unrecognized flags and positional args through to the backend, so you use the backend's native syntax. If `-a` is omitted, the agent is read from `.pcp/identity.json` in the current directory:

```bash
# Claude Code: --resume or --continue flags
sb --resume abc123              # Resume a specific Claude Code session
sb --continue                   # Continue the most recent session

# Codex: positional `resume` subcommand
sb -a lumen -b codex resume 019c6e3e-9219-70d1-b5dd-f35931c45190

# Gemini: --resume flag
sb -a aster -b gemini --resume ebd99b48-0203-402f-bc18-af19e9cc2bd3 --debug
```

You can also manage PCP-level sessions (which track identity, logs, and context across backend sessions):

```bash
sb session list                 # List recent PCP sessions
sb session show <id>            # Show session details + backend session ID
sb session resume <id>          # Print the backend resume command
sb session end [id]             # End a PCP session
```

### Flag passthrough

Any flag `sb` doesn't recognize is forwarded to the backend. You can also use `--` to force everything after it to pass through:

```bash
sb --allowedTools "Read,Write"  # Forwarded to Claude Code
sb -b codex --approval-mode full-auto  # Forwarded to Codex
sb -- --some-future-flag        # Explicit passthrough boundary
echo "explain this" | sb        # Pipe input as prompt
```

### SB Options

| Flag | Description | Default |
|------|-------------|---------|
| `-a, --agent <id>` | Agent identity | from `.pcp/identity.json` |
| `-b, --backend <name>` | AI backend | from `.pcp/identity.json`, or `claude` |
| `--no-session` | Disable session tracking | enabled |
| `-v, --verbose` | Show debug output | off |

Any flag not listed above is forwarded to the backend.

### Quick reference

```bash
sb init                         # Set up PCP in current repo
sb hooks install --all          # Install hooks across all worktrees
sb studio create feat-auth      # Create a studio (git worktree)
sb agent status                 # Check agent status
sb workspace list               # List workspaces (team/personal)
sb --help                       # Full help
```

### Identity Resolution

The agent ID is resolved in order:

1. `-a` / `--agent` flag
2. `.pcp/identity.json` in current directory
3. `~/.pcp/config.json` → `agentMapping.claude-code`
4. Error — run `sb init` or `sb awaken` to configure identity

The backend is resolved similarly:
1. `-b` / `--backend` flag
2. `.pcp/identity.json` → `backend` field
3. Default: `claude`

## Subcommands

### Studios (`sb studio`)

Git worktree management with per-studio identity.

```bash
sb studio create <name>         # Create studio with git worktree
sb studio list                  # List all studios
sb studio status                # Git status across all studios
sb studio remove <name>         # Remove studio (keeps branch)
sb studio clean <name>          # Remove studio + delete branch
sb studio path <name>           # Print studio path
eval $(sb studio cd <name>)     # cd to studio
sb studio cli                   # Build + link CLI as sb-<agent>
sb studio cli --name sb-dev     # Custom binary name
sb studio cli --unlink          # Remove linked binary
```

`sb ws` is a shorthand alias for `sb studio`.

Options for `create`:

- `-a, --agent <agent>` — Agent ID for this studio (default: wren)
- `-p, --purpose <desc>` — Description
- `-b, --backend <name>` — Primary backend (claude-code, codex, gemini)
- `-br, --branch <branch>` — Custom branch (default: `<agent>/studio/main`)

### Agents (`sb agent`)

```bash
sb agent status [id]            # Check agent status
sb agent trigger <id>           # Wake up an agent
sb agent inbox [id]             # Check inbox
sb agent list                   # List known agents
```

### Hooks (`sb hooks`)

Manage lifecycle hooks that connect CLI backends (Claude Code, Codex, Gemini) to PCP's session/memory/inbox system. Hooks fire on events like session start, compaction, and stop — injecting context, checking inbox, and saving state.

```bash
sb hooks install                   # Install for detected backend
sb hooks install --all             # Install across ALL git worktrees
sb hooks install -b codex          # Target a specific backend
sb hooks install --force           # Overwrite non-PCP hooks

sb hooks status                    # Show installed hooks
sb hooks uninstall                 # Remove PCP hooks
sb hooks uninstall --all           # Remove from all worktrees
```

Hooks are installed to **local-only** config by default (e.g., `.claude/settings.local.json`) so they don't leak into version control. `sb init` runs `sb hooks install` automatically.

**Hook events:**

| PCP Event          | What it does                   | Claude Code        | Codex              | Gemini          |
| ------------------ | ------------------------------ | ------------------ | ------------------ | --------------- |
| `on-session-start` | Bootstrap identity + inbox     | `SessionStart`     | `session_start`    | `SessionStart`  |
| `pre-compact`      | Save context before compaction | `PreCompact`       | —                  | `PreCompress`   |
| `post-compact`     | Re-bootstrap after compaction  | `SessionStart`     | —                  | —               |
| `on-prompt`        | Periodic inbox check           | `UserPromptSubmit` | `user_prompt`      | —               |
| `on-stop`          | Session nudge + inbox check    | `Stop`             | `session_end`      | `AfterAgent`    |

### Sessions (`sb session`)

```bash
sb session list                 # Recent sessions
sb session show <id>            # Session details
sb session resume <id>          # Resume a session
sb session end [id]             # End a session
```

### Workspaces (`sb workspace`)

Product-level workspaces for managing artifacts, team SBs, reminders, and more. Distinct from studios (local git worktrees).

```bash
sb workspace list               # List your workspaces
sb workspace list --type team   # Filter by type (personal|team)
sb workspace list --all         # Include archived workspaces
sb workspace create <name>      # Create a new workspace
sb workspace use <id-or-slug>   # Select active workspace for this machine
sb workspace current            # Print selected workspace ID
sb workspace invite <ws> <email>  # Invite a collaborator
sb workspace members [ws]       # List workspace members
```

Options for `create`:
- `--type <type>` — Workspace type: `personal` or `team` (default: team)
- `--description <desc>` — Workspace description
- `--slug <slug>` — URL-friendly slug
- `--use` — Select the created workspace immediately

Options for `invite`:
- `--role <role>` — Role: `owner`, `admin`, `member`, or `viewer` (default: member)

## Environment Variables

| Variable         | Description             | Default                    |
| ---------------- | ----------------------- | -------------------------- |
| `PCP_SERVER_URL` | PCP server URL          | `http://localhost:3001`    |
| `AGENT_ID`       | Override agent identity | (from identity resolution) |

## Development

```bash
yarn workspace @personal-context/cli build      # Build once
yarn workspace @personal-context/cli dev         # Watch mode (auto-rebuild on changes)
yarn workspace @personal-context/cli test        # Run tests
```

### Running in development mode

The global `sb` symlink points to `packages/cli/dist/cli.js` (compiled output). After pulling new code, rebuild to pick up changes:

```bash
yarn workspace @personal-context/cli build
```

For continuous development, run watch mode in a background terminal so changes compile automatically:

```bash
yarn workspace @personal-context/cli dev         # tsc --watch
```

To test a feature branch without overwriting the global `sb`:

```bash
sb studio cli                   # Links as sb-<agent> (e.g., sb-wren)
sb studio cli --name sb-dev     # Or pick a custom name
sb-wren auth status             # Test your branch build
sb studio cli --unlink          # Clean up when done
```
