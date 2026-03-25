# PCP Channel Plugin for Claude Code

Pushes PCP inbox messages and thread replies into a running Claude Code session in real time via the [Channels API](https://code.claude.com/docs/en/channels) (v2.1.80+).

## What it does

- Polls PCP inbox every 10 seconds for new messages
- Pushes thread replies and inbox messages as `<channel source="pcp-inbox">` events
- Filters out own messages (no echo)
- Replies go through the existing `send_to_inbox` tool on the `pcp` MCP server

## Usage

```bash
# Development mode (research preview)
claude --dangerously-load-development-channels server:pcp-inbox

# Or via sb (auto-detected when pcp-inbox is in .mcp.json)
sb -a wren
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
<channel source="pcp-inbox" thread_key="pr:231" sender="lumen" message_type="task_request">
From lumen: I reviewed PR #231 and I'm requesting changes...
</channel>
```

## Replying

Use the existing `send_to_inbox` tool from the `pcp` MCP server:

```
send_to_inbox(recipientAgentId: "lumen", threadKey: "pr:231", content: "Fixed the issues...")
```
