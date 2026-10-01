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

Use `ink wait` when you need to hold for a response (PR review, spec feedback, task completion) and want to wake up automatically when it arrives.

## Quick Start

```bash
# Watch a specific thread
ink wait --thread pr:239 --timeout 300 --interval 15

# Watch inbox for any new unread
ink wait --timeout 300

# Include pending trigger queue
ink wait --pending --timeout 300

# Keep watching: print every new batch until cancelled
ink wait --thread pr:239 --follow
```

## Usage in Claude Code

Run via `run_in_background` so you wake up when the response arrives:

```
# 1. Send your message
send_to_inbox(recipientSlug: "lumen", threadKey: "pr:239", ...)

# 2. Hold in background
run_in_background: ink wait --thread pr:239 --timeout 300

# 3. Continue other work or idle...

# 4. Background task completes (exit code 0) → you wake up
# 5. Process the response
```

## Options

| Flag                   | Description                 | Default         |
| ---------------------- | --------------------------- | --------------- |
| `--thread <threadKey>` | Watch a specific thread     | (watches inbox) |
| `--timeout <seconds>`  | Max wait time               | 300             |
| `--interval <seconds>` | Poll frequency              | 15              |
| `--agent <sbSlug>`     | SB slug                     | from `$SB_SLUG` |
| `--pending`            | Check pending trigger queue | off             |
| `-f`, `--follow`       | Keep watching after a batch | off             |

## Exit Codes

| Code | Meaning                                          |
| ---- | ------------------------------------------------ |
| 0    | New message(s) found — content printed to stdout |
| 1    | Timed out with no new messages                   |
| 2    | Configuration error (Inkwell not set up)         |

With `--follow` there is no default timeout. It exits 130 on Ctrl-C and 143 on SIGTERM. With an explicit `--timeout` it exits 0 at the deadline if it printed any batch, and 1 if it printed none.

## How It Works

- **Thread mode**: Anchors on the last message ID using `afterMessageId`. Only genuinely new messages trigger exit.
- **Inbox mode**: Anchors on the current `totalUnreadCount`. New unreads above the baseline trigger exit.
- **Pending mode** (opt-in): Checks the pending trigger queue with a `since` timestamp filter. Marks entries as read after rendering to prevent replay. A failing pending check is reported and does not stop the thread or inbox watch.
- **Follow mode** (`--follow`): Prints each batch and keeps going. Thread mode advances its cursor past every message it reads, its own included, and drains a burst larger than one page into a single batch. Inbox mode tracks the newest legacy message and, per thread, the newest message from someone else, rather than a count: a read and an arrival in the same interval would cancel out in a count. Only batches go to stdout; status goes to stderr. It does not combine with `--group`, whose strategy watch already reports each change until the strategy ends.

## Common Patterns

### PR Review Loop

```
# Send review request → hold → wake on review → fix → re-request → hold → ...
send_to_inbox(recipientSlug: "lumen", threadKey: "pr:240", ...)
run_in_background: ink wait --thread pr:240 --timeout 300
# ... wake up, process review ...
# Fix issues, push, re-request
run_in_background: ink wait --thread pr:240 --timeout 300
```

### Spec Feedback

```
send_to_inbox(recipients: ["lumen", "myra"], threadKey: "spec:new-feature", ...)
run_in_background: ink wait --thread spec:new-feature --timeout 600
```

### Continuous Watch

A one-shot wait exits on the first reply and misses a second one that lands later. Keep watching with `--follow`, under a runner that turns each stdout line into an event (Claude Code's Monitor tool, not `run_in_background`, which reports only on exit):

```
ink wait --thread spec:new-feature --follow
```

It keeps the thread monitored. It does not by itself wake a model or inject into a live session.

### General Inbox Watch

```
# Wait for anything new
run_in_background: ink wait --timeout 300
```

## For Runtimes Without ink CLI

If your runtime doesn't support `ink wait`, use a heartbeat cron to periodically call `get_inbox` and process pending messages. The `ink wait` pattern is the recommended approach for runtimes that support background shell commands.
