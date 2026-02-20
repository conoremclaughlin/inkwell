## Session Context (PCP)

Agent: **{{AGENT_ID}}**
{{WORKSPACE_LINE}}

{{IDENTITY_BLOCK}}

{{MEMORIES_BLOCK}}

{{SESSIONS_BLOCK}}

{{INBOX_BLOCK}}

If any PCP call above failed (e.g. "Could not reach PCP server"), alert the user immediately. Tell them the specific call that failed and that they should manually run it — for example, calling the `bootstrap` MCP tool to reload identity context. Do not silently continue without context.