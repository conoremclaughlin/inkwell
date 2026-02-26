# CLI Lifecycle Hooks

PCP hooks bridge coding agents (Claude Code, Codex, Gemini) with PCP's session, memory, and inbox system. Each hook fires at a specific lifecycle event and injects context into the agent's conversation.

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

1. Reads workspace ID from `.pcp/identity.json`
2. Calls `bootstrap` with agentId and workspaceId
3. Calls `get_inbox` for unread messages
4. Resolves PCP session ID (`PCP_SESSION_ID` env from launcher, or `start_session` fallback)
5. Reconciles PCP/backend session linkage when backend session ID is available (prefers existing server-side backend-session match)
6. Stores runtime session state in `.pcp/runtime/sessions.json` (multi-session list + current pointer + correlation link)
7. Stores backend session ID in `.pcp/runtime/session-id` (legacy compatibility)
8. Links backend session ID to PCP session via `update_session_phase(sessionId, backendSessionId)`

**Output:**

```
## Session Context (PCP)

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
## Pre-Compaction Reminder (PCP)

Context is about to be compacted. Before compaction completes:

1. **Save critical decisions** — Use `mcp__pcp__log_session` to persist any
   important reasoning, decisions, or context that should survive compaction.
2. **Update memory** — If you discovered reusable patterns or key facts,
   use `mcp__pcp__remember` to save them.
3. **Note current task state** — Log where you are in the current task so you
   can resume smoothly after compaction.

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
## Post-Compaction Context (PCP)

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
5. Updates the `last-inbox-check` timestamp in `.pcp/runtime/`

**Output (only if messages exist and inbox is stale):**

```
<pcp-inbox count="{count}">
- **{from}**: {content or subject}
...
</pcp-inbox>
```

---

### `on-stop`

**When:** After each agent tool call / turn (Claude Code: Stop, Codex: session_end, Gemini: AfterAgent).

**What it does:**

1. Marks runtime phase as `runtime:idle` via `update_session_phase(sessionId, phase)`
2. Reconciles backend session ID linkage if the hook payload includes a session ID
   - short-circuits on local `sessions.json` if linkage is already known
3. Increments tool call counter in `.pcp/runtime/tool-count`
4. Every 30 tool calls, outputs a nudge to log session progress
5. If inbox is stale (>5 minutes), checks for new messages

**Output (conditional):**

```
<pcp-reminder>
You have completed ~{count} tool calls this session. Consider using
`mcp__pcp__log_session` to save a progress snapshot.
</pcp-reminder>

<pcp-inbox count="{count}">
- **{from}**: {content or subject}
...
</pcp-inbox>
```

## Runtime State

Hooks store ephemeral state in `.pcp/runtime/` (gitignored):

| File               | Purpose                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| `sessions.json`    | Runtime session registry (list of PCP sessions + backend session IDs/history + current pointer + runtimeLinkId correlation token) |
| `pcp-session-id`   | Current PCP session UUID (legacy convenience file)                                      |
| `session-id`       | Backend session ID from on-session-start (legacy convenience file)                      |
| `runtime-link-id`  | Current run correlation token (`PCP_RUNTIME_LINK_ID`) for local reconciliation/debug    |
| `last-inbox-check` | ISO timestamp of last inbox poll                                                        |
| `tool-count`       | Cumulative tool call counter for on-stop nudges                                         |

## Installation

```bash
sb hooks install     # Auto-detects backend and installs hooks
sb hooks status      # Show installed hook status
sb hooks uninstall   # Remove PCP-managed hooks
```
