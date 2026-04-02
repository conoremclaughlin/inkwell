# CLI Lifecycle Hooks

Inkstand hooks bridge coding agents (Claude Code, Codex, Gemini) with Inkstand's session, memory, and inbox system. Each hook fires at a specific lifecycle event and injects context into the agent's conversation.

**Source:** [`src/commands/hooks.ts`](src/commands/hooks.ts)
**Templates:** [`src/templates/hook-*.md`](src/templates/)

## Backend Support

| Hook               |   Claude Code    |     Codex     |    Gemini    |
| ------------------ | :--------------: | :-----------: | :----------: |
| `on-session-start` |   SessionStart   | session_start | SessionStart |
| `pre-compact`      |    PreCompact    |       -       | PreCompress  |
| `post-compact`     |  SessionStart\*  |       -       |      -       |
| `on-prompt`        | UserPromptSubmit |  user_prompt  | BeforeAgent  |
| `on-stop`          |       Stop       |  session_end  |  AfterAgent  |

\* `post-compact` uses the SessionStart event with a "compact" matcher to distinguish from initial startup.

## Hook Reference

### `on-session-start`

**When:** Agent session begins (first startup).

**What it does:**

1. Reads workspace ID from `.ink/identity.json`
2. Calls `bootstrap` with agentId and workspaceId
3. Calls `get_inbox` for unread messages
4. Resolves Inkstand session ID (`INK_SESSION_ID` env from launcher, or `start_session` fallback)
5. Reconciles Inkstand/backend session linkage when backend session ID is available (prefers existing server-side backend-session match)
6. Stores runtime session state in `.ink/runtime/sessions.json` (multi-session list + current pointer + correlation link)
7. Stores backend session ID in `.ink/runtime/session-id` (legacy compatibility)
8. Links backend session ID to Inkstand session via `update_session_phase(sessionId, backendSessionId)`

**Output:**

```
## Session Context

Agent: **{agentId}**
Workspace: {workspace name}

### Identity
{bootstrap identity JSON}

### Recent Memories
- {memory content}
...

### Active Sessions
- {session_id}: {summary or status}
...

### Inbox ({count} messages)
- **{from}**: {content or subject}
...
```

---

### `pre-compact`

**When:** Context is about to be compacted (Claude Code only).

**What it does:** Outputs a static reminder prompting the agent to save state before context is lost.

**Output:**

```
## Pre-Compaction Reminder

Context is about to be compacted. Before compaction completes:

1. **Save critical decisions** — Use `mcp__inkstand__remember` to persist any
   important reasoning, decisions, or context that should survive compaction.
2. **Note current task state** — Use `mcp__inkstand__update_session_phase` to record
   where you are in the current task so you can resume smoothly after compaction.

This context will be lost after compaction unless you save it now.
```

---

### `post-compact`

**When:** After context compaction (Claude Code only). Fires on SessionStart with a "compact" matcher.

**What it does:**

1. Calls `bootstrap` to reload identity
2. Calls `get_inbox` for unread messages

**Output:**

```
## Post-Compaction Context

Agent: {agentId}

### Identity
{bootstrap identity JSON}

### Inbox ({count} messages)
- **{from}**: {content or subject}
...
```

---

### `on-prompt`

**When:** Before each user prompt is submitted (Claude Code: `UserPromptSubmit`, Codex: `user_prompt`, Gemini: `BeforeAgent`).

**What it does:**

1. Marks runtime phase as `runtime:generating` via `update_session_phase(sessionId, phase)`
2. Reconciles backend session ID linkage if the hook payload includes a session ID
   - short-circuits on local `sessions.json` if linkage is already known
3. Checks if inbox was polled within the last 5 minutes — if so, exits silently
4. Calls `get_inbox` for unread messages
5. Updates the `last-inbox-check` timestamp in `.ink/runtime/`

**Output (only if messages exist and inbox is stale):**

```
<inkmail count="{count}">
- **{from}**: {content or subject}
...
</inkmail>
```

---

### `on-stop`

**When:** After each agent tool call / turn (Claude Code: Stop, Codex: session_end, Gemini: AfterAgent).

**What it does:**

1. Marks runtime phase as `runtime:idle` via `update_session_phase(sessionId, phase)`
2. Reconciles backend session ID linkage if the hook payload includes a session ID
   - short-circuits on local `sessions.json` if linkage is already known
3. Increments tool call counter in `.ink/runtime/tool-count`
4. Every 30 tool calls, outputs a nudge to log session progress
5. If inbox is stale (>5 minutes), checks for new messages

**Output (conditional):**

```
<pcp-reminder>
You have completed ~{count} tool calls this session. Consider using
`mcp__inkstand__remember` to save a progress snapshot.
</pcp-reminder>

<inkmail count="{count}">
- **{from}**: {content or subject}
...
</inkmail>
```

## Runtime State

Hooks store ephemeral state in `.ink/runtime/` (gitignored):

| File               | Purpose                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `sessions.json`    | Runtime session registry (list of Inkstand sessions + backend session IDs/history + current pointer + runtimeLinkId correlation token) |
| `ink-session-id`   | Current Inkstand session UUID (legacy convenience file)                                                                                |
| `session-id`       | Backend session ID from on-session-start (legacy convenience file)                                                                |
| `runtime-link-id`  | Current run correlation token (`INK_RUNTIME_LINK_ID`) for local reconciliation/debug                                              |
| `last-inbox-check` | ISO timestamp of last inbox poll                                                                                                  |
| `tool-count`       | Cumulative tool call counter for on-stop nudges                                                                                   |

## Installation

```bash
sb hooks install     # Auto-detects backend and installs hooks
sb hooks status      # Show installed hook status
sb hooks uninstall   # Remove Inkstand-managed hooks
```
