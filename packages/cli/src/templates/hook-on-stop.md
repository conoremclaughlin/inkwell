<ink-reminder>
You have completed ~{{TOOL_COUNT}} tool calls this session. If you've made important decisions or discovered non-obvious details, use `mcp__inkwell__remember` to preserve them durably.

If your runtime state has changed (started/stopped a server, opened a PR, kicked off a build, changed ports, etc.), update your session context via `update_session_phase(context: "...")` so it survives compaction. Context is your scratch board for transient active state — what's running, what's pending, what port you're on.
</ink-reminder>
