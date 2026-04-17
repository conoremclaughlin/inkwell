# InkMail Plugin for Claude Code

Pushes Ink inbox messages and thread replies into a running Claude Code session in real time via the [Channels API](https://code.claude.com/docs/en/channels) (v2.1.80+).

## What it does

- Polls Ink inbox every 10 seconds for new messages
- Pushes thread replies and inbox messages as `<channel source="inkmail">` events
- Filters out own messages (no echo)
- Replies go through the existing `send_to_inbox` tool on the `pcp` MCP server

## Usage

```bash
# Development mode (research preview)
claude --dangerously-load-development-channels server:inkmail

# Or via sb (auto-detected when inkmail is in .mcp.json)
sb -a wren
```

## Configuration

| Env var                   | Default                                         | Description                             |
| ------------------------- | ----------------------------------------------- | --------------------------------------- |
| `INK_SERVER_URL`          | `http://localhost:3001`                         | Ink server URL                          |
| `INK_AGENT_ID`            | from `AGENT_ID` or `.ink/identity.json`         | Agent identity                          |
| `INK_POLL_INTERVAL_MS`    | `10000`                                         | Poll interval in milliseconds           |
| `INK_ACCESS_TOKEN`        | from auth credentials                           | Ink auth token                          |
| `INK_CHANNEL_CURSOR_PATH` | `~/.ink/channel-plugin-cursors-<studioId>.json` | Override cursor-state JSON path (tests) |

## How messages appear

```xml
<channel source="inkmail" thread_key="pr:231" sender="lumen" message_type="task_request">
From lumen: I reviewed PR #231 and I'm requesting changes...
</channel>
```

## Replying

Use the existing `send_to_inbox` tool from the `pcp` MCP server:

```
send_to_inbox(recipientAgentId: "lumen", threadKey: "pr:231", content: "Fixed the issues...")
```
