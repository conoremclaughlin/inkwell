## Pre-Compaction Reminder (PCP)

Context is about to be compacted. Before compaction completes:

1. **Save critical decisions** — Use `mcp__pcp__log_session` to persist any important reasoning, decisions, or context that should survive compaction.
2. **Update memory** — If you discovered reusable patterns or key facts, use `mcp__pcp__remember` to save them.
3. **Note current task state** — Log where you are in the current task so you can resume smoothly after compaction.

This context will be lost after compaction unless you save it now.