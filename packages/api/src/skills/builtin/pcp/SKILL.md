---
name: pcp
version: '0.1.0'
displayName: Personal Context Protocol
description: Identity, memory, sessions, and cross-agent messaging via Inkstand. Gives agents persistent context that survives across sessions and works across AI backends.
type: guide
emoji: '🧠'
category: productivity
tags:
  - pcp
  - memory
  - context
  - identity
  - sessions
  - inbox
  - cross-agent
author: Inkstand Team
homepage: https://github.com/conoremclaughlin/personal-context-protocol
triggers:
  keywords:
    - pcp
    - memory
    - remember
    - recall
    - context
    - bootstrap
    - session
    - inbox
    - identity
    - cross-agent
capabilities:
  memory: true
  network: true
requirements:
  config:
    - ~/.ink/config.json
metadata:
  openclaw:
    emoji: '🧠'
    requires:
      config:
        - openclaw.json.plugins.entries.pcp
---

# Personal Context Protocol (Inkstand)

Inkstand gives you persistent identity, long-term memory, session tracking, and cross-agent messaging. Your context survives across sessions and works across AI backends (Claude Code, Codex, Gemini, OpenClaw).

## Setup

Inkstand tools are available via MCP. If the Inkstand MCP server is not already configured, add it to your MCP config:

**Option A — Stdio (spawns a process):**

```json
{
  "mcpServers": {
    "pcp": {
      "command": "node",
      "args": ["/path/to/pcp/packages/api/dist/index.js"],
      "env": { "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

**Option B — HTTP (connect to running server):**

```json
{
  "mcpServers": {
    "pcp": {
      "url": "http://localhost:3001/mcp",
      "headers": {
        "Authorization": "Bearer ${INK_ACCESS_TOKEN}"
      }
    }
  }
}
```

## Quick Start

At the start of every session, call `bootstrap` to load your identity and context:

```
bootstrap(agentId: "your-agent-id")
```

This returns your identity documents, recent memories, active sessions, and team context. Everything you need to know who you are and what you've been working on.

## Core Tools

### Memory — What You Know

```
remember(content: "Decided to use X because...", agentId: "wren", topicKey: "decision:auth")
```

Saves to long-term memory with topic tagging. Memories persist across sessions and are filtered by your agentId.

```
recall(query: "auth approach", agentId: "wren")
```

Searches your memories. Returns matches sorted by relevance and salience.

**TopicKey convention:** `type:identifier` — e.g., `project:pcp/memory`, `decision:jwt-auth`, `lesson:cross-agent-review`.

### Sessions — Where You Are

Sessions track what you're working on and in what phase:

```
update_session_phase(phase: "implementing")
```

Phases: `investigating`, `implementing`, `reviewing`, `blocked:<reason>`, `waiting:<reason>`.

Sessions end automatically, but you can save a summary:

```
end_session(summary: "Built memory layer with versioning")
```

### Inbox — Cross-Agent Messaging

Send messages to other agents:

```
send_to_inbox(
  recipientAgentId: "lumen",
  messageType: "task_request",
  threadKey: "pr:42",
  subject: "Review PR #42",
  content: "Please review the auth middleware changes."
)
```

Check your inbox:

```
get_inbox(agentId: "wren")
```

Read thread messages:

```
get_thread_messages(threadKey: "pr:42", agentId: "wren")
```

**threadKey convention:** `pr:42`, `spec:cli-hooks`, `issue:15`, `thread:perf-audit`.

### Identity — Who You Are

Your identity is stored in the database and served via bootstrap. Six documents form your constitution:

| Document  | Scope     | Purpose                   |
| --------- | --------- | ------------------------- |
| identity  | Per-agent | Name, role, relationships |
| soul      | Per-agent | Philosophical core        |
| heartbeat | Per-agent | Operational checklist     |
| values    | Shared    | Team principles           |
| process   | Shared    | How we work               |
| user      | Shared    | About the human           |

Read: `get_identity(agentId, file: "identity")`. Write: `save_identity(description: "...")`.

## Tool Reference

| Tool                   | Purpose                                           |
| ---------------------- | ------------------------------------------------- |
| `bootstrap`            | Load identity, context, memories at session start |
| `remember`             | Save to long-term memory                          |
| `recall`               | Search memories                                   |
| `forget`               | Delete a memory                                   |
| `update_memory`        | Update salience/topics                            |
| `send_to_inbox`        | Message another agent                             |
| `get_inbox`            | Check your inbox                                  |
| `get_thread_messages`  | Read a conversation thread                        |
| `mark_thread_read`     | Mark thread as read                               |
| `update_session_phase` | Set work phase                                    |
| `end_session`          | End session with summary                          |
| `get_identity`         | Read identity documents                           |
| `save_identity`        | Update identity documents                         |
| `create_task`          | Create a tracked task                             |
| `list_tasks`           | List tasks                                        |
| `save_context`         | Save context summaries                            |
| `get_context`          | Retrieve context                                  |
| `log_activity`         | Log structured activity events                    |

## Conventions

- **Always bootstrap first.** It loads your identity, context, and recent memories.
- **Attribute memories.** Include `agentId` and `topicKey` on every `remember()` call.
- **Use threadKey.** Every `send_to_inbox` should include a threadKey for conversation continuity.
- **All messages trigger by default.** Only set `trigger: false` if the message can wait 5+ hours.
- **Phases are semantic.** Use `blocked:awaiting-review` not just `blocked`.
