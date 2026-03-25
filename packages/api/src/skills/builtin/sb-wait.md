---
name: sb-wait
version: '1.0.0'
displayName: SB Wait (Holding Pattern)
description: Poll for new inbox or thread messages and wake up when something arrives
type: guide
emoji: "\u23F3"
category: workflow
tags:
  - inbox
  - polling
  - workflow
  - waiting
  - background
author: Wren

triggers:
  keywords:
    - wait
    - hold
    - poll
    - waiting for
    - review response
    - holding pattern
---

# SB Wait — Background Inbox Polling

Use `sb wait` when you need to hold for a response (PR review, spec feedback, task completion) and want to wake up automatically when it arrives.

## Quick Start

```bash
# Watch a specific thread
sb wait --thread pr:239 --timeout 300 --interval 15

# Watch inbox for any new unread
sb wait --timeout 300

# Include pending trigger queue
sb wait --pending --timeout 300
```

## Usage in Claude Code

Run via `run_in_background` so you wake up when the response arrives:

```
# 1. Send your message
send_to_inbox(recipientAgentId: "lumen", threadKey: "pr:239", ...)

# 2. Hold in background
run_in_background: sb wait --thread pr:239 --timeout 300

# 3. Continue other work or idle...

# 4. Background task completes (exit code 0) → you wake up
# 5. Process the response
```

## Options

| Flag                   | Description                 | Default          |
| ---------------------- | --------------------------- | ---------------- |
| `--thread <threadKey>` | Watch a specific thread     | (watches inbox)  |
| `--timeout <seconds>`  | Max wait time               | 300              |
| `--interval <seconds>` | Poll frequency              | 15               |
| `--agent <agentId>`    | Agent ID                    | from `$AGENT_ID` |
| `--pending`            | Check pending trigger queue | off              |

## Exit Codes

| Code | Meaning                                          |
| ---- | ------------------------------------------------ |
| 0    | New message(s) found — content printed to stdout |
| 1    | Timed out with no new messages                   |
| 2    | Configuration error (PCP not set up)             |

## How It Works

- **Thread mode**: Anchors on the last message ID using `afterMessageId`. Only genuinely new messages trigger exit.
- **Inbox mode**: Anchors on the current `totalUnreadCount`. New unreads above the baseline trigger exit.
- **Pending mode** (opt-in): Checks the pending trigger queue with a `since` timestamp filter. Marks entries as read after rendering to prevent replay.

## Common Patterns

### PR Review Loop

```
# Send review request → hold → wake on review → fix → re-request → hold → ...
send_to_inbox(recipientAgentId: "lumen", threadKey: "pr:240", ...)
run_in_background: sb wait --thread pr:240 --timeout 300
# ... wake up, process review ...
# Fix issues, push, re-request
run_in_background: sb wait --thread pr:240 --timeout 300
```

### Spec Feedback

```
send_to_inbox(recipients: ["lumen", "myra"], threadKey: "spec:new-feature", ...)
run_in_background: sb wait --thread spec:new-feature --timeout 600
```

### General Inbox Watch

```
# Wait for anything new
run_in_background: sb wait --timeout 300
```

## For Runtimes Without sb CLI

If your runtime doesn't support `sb wait`, use a heartbeat cron to periodically call `get_inbox` and process pending messages. The `sb wait` pattern is the recommended approach for runtimes that support background shell commands.
