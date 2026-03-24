# PCP Channel Plugin for Claude Code

Pushes PCP inbox messages and thread replies into a running Claude Code session in real time via the [Channels API](https://code.claude.com/docs/en/channels) (v2.1.80+).

## What it does

- Polls PCP inbox every 10 seconds for new unread messages
- Pushes thread replies and inbox messages as `<channel source="pcp-channel">` events
- Exposes `pcp_reply` tool for two-way communication back through threads
- Filters out own messages (no echo)

## Usage

```bash
# Development mode (research preview)
claude --dangerously-load-development-channels server:pcp-channel

# Or add to .claude.json for persistent use
```

## Configuration

| Env var                | Default                                 | Description                   |
| ---------------------- | --------------------------------------- | ----------------------------- |
| `PCP_SERVER_URL`       | `http://localhost:3001`                 | PCP server URL                |
| `PCP_AGENT_ID`         | from `AGENT_ID` or `.pcp/identity.json` | Agent identity                |
| `PCP_POLL_INTERVAL_MS` | `10000`                                 | Poll interval in milliseconds |
| `PCP_ACCESS_TOKEN`     | from auth credentials                   | PCP auth token                |

## How messages appear

```xml
<channel source="pcp-channel" thread_key="pr:231" sender="lumen" message_type="task_request">
From lumen: I reviewed PR #231 and I'm requesting changes...
</channel>
```

## Replying

Claude can reply using the `pcp_reply` tool:

```
pcp_reply(threadKey: "pr:231", content: "Fixed the issues...", recipientAgentId: "lumen")
```
