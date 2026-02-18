# sb

A lightweight CLI that wraps AI coding tools with persistent identity. Type `sb` to start a session — your SB (Synthetically-born Being) knows who it is, who you are, and what you've been working on.

Unrecognized flags are passed through to the underlying tool (Claude Code today, others in the future).

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

## Usage

```bash
# Interactive session (default)
sb                              # Launch Claude Code as wren
sb -a myra                      # Launch as myra
sb -m opus                      # Use opus model

# Prompt mode (one-shot)
sb "fix the login bug"
sb -m opus "refactor auth"

# Passthrough flags to Claude Code
sb --resume abc123              # Resume a session
sb --continue                   # Continue last session
sb --allowedTools "Read,Write"  # Restrict tools

# Explicit passthrough with --
sb -- --some-future-flag

# Pipe input
echo "explain this" | sb

# Subcommands
sb init                         # Set up PCP in current repo
sb hooks install --all          # Install hooks across all worktrees
sb studio create feat-auth      # Create studio/workspace
sb agent status                 # Check agent status
sb session list                 # List sessions
sb --help                       # Full help
```

### SB Options

| Flag | Description | Default |
|------|-------------|---------|
| `-a, --agent <id>` | Agent identity | `wren` (or from `.pcp/identity.json`) |
| `-m, --model <model>` | Model (sonnet, opus, haiku) | `sonnet` |
| `--no-session` | Disable session tracking | enabled |
| `-v, --verbose` | Show debug output | off |

Any flag not listed above is forwarded to Claude Code.

### Identity Resolution

The agent ID is resolved in order:
1. `-a` / `--agent` flag
2. `.pcp/identity.json` in current directory
3. `~/.pcp/config.json` → `agentMapping.claude-code`
4. Default: `wren`

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
```

Backwards compatibility aliases still work:
- `sb ws ...`
- `sb workspace ...`

Options for `create`:
- `-a, --agent <agent>` — Agent ID for this studio (default: wren)
- `-p, --purpose <desc>` — Description
- `-b, --branch <branch>` — Custom branch (default: `<agent>/workspace/<name>`)

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

| PCP Event | What it does | Claude Code | Codex | Gemini |
|---|---|---|---|---|
| `on-session-start` | Bootstrap identity + inbox | `SessionStart` | `session_start` | `session_start` |
| `pre-compact` | Save context before compaction | `PreCompact` | — | — |
| `post-compact` | Re-bootstrap after compaction | `SessionStart` | — | — |
| `on-prompt` | Periodic inbox check | `UserPromptSubmit` | — | — |
| `on-stop` | Session nudge + inbox check | `Stop` | `session_end` | `session_end` |

### Sessions (`sb session`)

```bash
sb session list                 # Recent sessions
sb session show <id>            # Session details
sb session resume <id>          # Resume a session
sb session end [id]             # End a session
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PCP_SERVER_URL` | PCP server URL | `http://localhost:3001` |
| `AGENT_ID` | Override agent identity | (from identity resolution) |

## Development

```bash
yarn workspace @personal-context/cli build      # Build
yarn workspace @personal-context/cli dev         # Watch mode
yarn workspace @personal-context/cli test        # Run tests
```
