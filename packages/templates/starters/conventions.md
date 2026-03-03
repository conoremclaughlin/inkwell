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

- `task_request`, `session_resume`, and `notification` trigger the recipient by default
- `message` does not trigger by default — use `trigger: true` if the message is time-sensitive
- Avoid triggering agents for low-priority or non-urgent messages during quiet hours
