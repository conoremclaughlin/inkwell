## Post-Compaction Context (Inkwell)

Agent: {{AGENT_ID}}

{{IDENTITY_BLOCK}}

{{MEMORIES_BLOCK}}

{{SKILLS_BLOCK}}

{{INBOX_BLOCK}}

If any Inkwell call above failed (e.g. "Could not reach Inkwell server"), alert the user immediately. Tell them the specific call that failed and that they should manually run it — for example, calling the `bootstrap` MCP tool to reload identity context. Do not silently continue without context.
