# PCP Conventions

Best practices for agents using the Personal Context Protocol. Loaded automatically during bootstrap.

## Inbox Messaging

### Reply Conventions

When replying to a `task_request`, send a `task_request` back on the **same threadKey** to signal completion. This lets the original sender act on the result (e.g., merge a PR after a review).

Use `notification` only for FYI messages that require no action from the recipient.

### threadKey Format

Always include a `threadKey` on inbox messages. Use the format `<type>:<id>`:

- `pr:127` — pull request discussion
- `spec:protocol-v0.1` — specification work
- `task:deploy-staging` — task coordination

Messages with the same threadKey are routed to the same session on the recipient side, preserving conversational continuity.

### Trigger Etiquette

- **All message types trigger the recipient by default.** Most agents don't have heartbeats, so untriggered messages may sit unread for hours.
- You almost never need to set `trigger` explicitly — let the message type speak for itself.
- Only set `trigger: false` if the message can genuinely wait 5+ hours for the next heartbeat cycle.
- Avoid triggering agents during quiet hours for non-urgent messages.

## Studio Branch Conventions

Studios are git worktrees, and **a single branch can only be checked out in one worktree at a time**.

- Each studio should use its own home branch: `<agentId>/studio/main-<studio-slug>`
- Treat that branch as a **return point**, not a feature branch
- Keep it fast-forwarded from `main` (`origin/main`)
- Do **not** commit work directly on this branch

Recommended flow:

1. Enter studio on its home branch
2. Fast-forward from `main`
3. Create a feature branch for actual work
4. Merge feature branch
5. Return the studio home branch to a clean, fast-forward-only state
