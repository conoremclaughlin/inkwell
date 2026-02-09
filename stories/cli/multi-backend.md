# Multi-Backend CLI Support

> Let `sb` wrap Claude Code, Codex CLI, and Gemini CLI with the same identity injection and session tracking.

**Branch**: `wren/feat/multi-backend-cli`
**Status**: Research complete, implementation pending

## Motivation

PCP's identity system shouldn't be locked to one AI provider. Users should be able to launch any supported CLI and get the same persistent identity, memory, and context — just with a different underlying model.

```bash
sb                          # Default backend (claude)
sb -b codex "fix the bug"   # Use Codex CLI
sb -b gemini "review this"  # Use Gemini CLI
```

## Backend Comparison

| Feature | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| **Binary** | `claude` | `codex` | `gemini` |
| **Install** | `npm i -g @anthropic-ai/claude-code` | `npm i -g @openai/codex` | `npm i -g @google/gemini-cli` |
| **Instruction file** | `CLAUDE.md` | `AGENTS.md` | `GEMINI.md` |
| **System prompt flag** | `--append-system-prompt <file>` | None | None |
| **System prompt alt** | N/A | `model_instructions_file` in config.toml | `GEMINI_SYSTEM_MD` env var |
| **MCP config format** | `.mcp.json` (JSON) | `config.toml` under `[mcp_servers.*]` | `settings.json` under `mcpServers` |
| **MCP transport** | stdio, HTTP/SSE | stdio, Streamable HTTP | stdio, Streamable HTTP, SSE |
| **Non-interactive** | `claude -p "prompt"` | `codex -q "prompt"` or `codex exec "prompt"` | `gemini -p "prompt"` |
| **Interactive** | `claude` (default) | `codex` (default) | `gemini` (default) |
| **Model flag** | `--model` | `--model` | `-m` / `--model` |
| **Config location** | `~/.claude/` | `~/.codex/config.toml` | `~/.gemini/settings.json` |
| **Config format** | JSON (various) | TOML | JSON |
| **JSON output** | `--output-format json` | `codex exec --json` | `--output-format json` |
| **Auto-approve** | `--dangerously-skip-permissions` | `--yolo` | `--yolo` |
| **Written in** | TypeScript | Rust | TypeScript |

## Identity Injection Strategy

The key challenge: **none of the three CLIs support system prompt injection via a CLI flag** (beyond Claude's `--append-system-prompt`). They all use instruction files.

### Approach: Temporary instruction files

For each backend, `sb` writes a temporary instruction file with the agent's identity, then invokes the CLI in the appropriate way:

| Backend | Injection mechanism |
|---|---|
| **Claude** | `--append-system-prompt <tmpfile>` (current approach, works well) |
| **Codex** | Write temp `AGENTS.md` in CWD or use `--config model_instructions_file=<tmpfile>` |
| **Gemini** | Set `GEMINI_SYSTEM_MD=<tmpfile>` env var (full system prompt replacement) |

**Concern with Codex**: Writing a temporary `AGENTS.md` to CWD could conflict with an existing one. The `--config model_instructions_file=<tmpfile>` approach is cleaner but replaces *all* built-in instructions rather than appending.

**Concern with Gemini**: `GEMINI_SYSTEM_MD` does a full replacement of the system prompt. We'd need to include the standard Gemini instructions alongside our identity block, or accept that our identity instructions are the full system prompt.

### Recommended approach

1. **Claude**: Keep `--append-system-prompt` (additive, clean)
2. **Codex**: Use `--config model_instructions_file=<tmpfile>` with a note that this replaces default instructions (acceptable tradeoff — our identity prompt includes the essentials)
3. **Gemini**: Use `GEMINI_SYSTEM_MD=<tmpfile>` similarly

All three write a temporary file with the same identity content, cleaned up on process exit.

## MCP Config Transformation

Each backend has its own config format for MCP servers. `sb` needs to either:

1. **Generate per-backend config**: Read the PCP MCP server URL and write the appropriate config format
2. **Use a shared `.mcp.json`**: If backends converge on a standard (they haven't yet)

For now, each backend adapter writes its own config:

```typescript
// Claude: .mcp.json already exists, no transform needed
// Codex: write [mcp_servers.pcp] section to a temp config.toml
// Gemini: write mcpServers.pcp to a temp settings.json (or project .gemini/settings.json)
```

## Adapter Interface

```typescript
interface BackendAdapter {
  name: string;           // 'claude' | 'codex' | 'gemini'
  binary: string;         // 'claude' | 'codex' | 'gemini'

  // Check if the backend binary is installed
  isInstalled(): Promise<boolean>;

  // Build the full args array for spawning the process
  buildArgs(options: SbOptions, prompt?: string, passthroughArgs?: string[]): string[];

  // Prepare environment (write temp files, set env vars)
  // Returns cleanup function
  prepare(options: SbOptions): Promise<{ env: Record<string, string>; cleanup: () => void }>;

  // Map sb flags to backend-specific flags
  mapFlags(sbFlags: Record<string, string>): string[];
}
```

## Flag Mapping

| SB flag | Claude | Codex | Gemini |
|---|---|---|---|
| `-m <model>` | `--model <model>` | `--model <model>` | `-m <model>` |
| `-b <backend>` | (self) | (self) | (self) |
| `--no-session` | (internal) | (internal) | (internal) |
| Passthrough | Direct pass | Direct pass | Direct pass |

## Open Questions

1. **Default backend**: Should it be configurable in `~/.pcp/config.json`? Or always Claude?
2. **MCP config conflicts**: What if the user already has Codex/Gemini MCP config? Merge or override?
3. **Instruction file conflicts**: Codex uses `AGENTS.md` — same as our `AGENTS.md`. Need to be careful not to clobber.
4. **Session tracking**: Should session logs differ by backend? Or is a session just a session regardless?
5. **Model defaults**: Should `sb -b codex` default to `gpt-5-codex` and `sb -b gemini` default to `gemini-2.5-pro`? Or let the backend pick?

## Implementation Order

1. Define `BackendAdapter` interface
2. Extract current Claude logic into `ClaudeAdapter`
3. Implement `CodexAdapter` (identity via config flag, MCP via temp config.toml)
4. Implement `GeminiAdapter` (identity via env var, MCP via temp settings.json)
5. Add `-b`/`--backend` flag to `extractArgs()` in cli.ts
6. Wire up adapter selection in `runClaude`/`runClaudeInteractive` (rename to generic)
7. Test each backend flow end-to-end
