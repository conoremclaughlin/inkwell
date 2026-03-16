## Pre-Compaction Reminder (PCP)

Context is about to be compacted. Compaction is lossy — the summary may miss key details. Use `mcp__pcp__remember` now to preserve anything that would derail you if forgotten:

1. **Why** — What is the overall objective? What problem are you solving and why this approach?
2. **Gotchas** — Small details, edge cases, or non-obvious constraints that are easy to lose in summarization but critical to continued success.
3. **Current state** — Where exactly are you in the task? What's done, what's next, what's blocked?

Focus on details that are hard to re-derive from code alone. Don't duplicate what the compaction summary will naturally capture (file names, recent tool calls, etc.).
