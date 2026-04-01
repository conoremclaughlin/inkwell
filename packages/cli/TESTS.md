# CLI Testing Notes (SB-focused)

This doc is for contributors testing `sb` behavior and preventing regressions.

## Session-candidate debugging commands

Use these to inspect the _exact same_ candidate data used by the interactive picker:

```bash
sb -a wren -b claude --session-candidates
sb -a wren -b claude --session-candidates-json

sb -a lumen -b codex --session-candidates
sb -a lumen -b codex --session-candidates-json

sb -a aster -b gemini --session-candidates-json
```

`--session-candidates-json` is the preferred form for assertions and test fixtures.

## Required manual regression loop

When touching session resolution logic, run this loop before opening/updating a PR:

1. Build CLI:

```bash
yarn workspace @inkstand/cli build
```

2. Validate **path scoping** across at least 2 repos/worktrees:

```bash
cd ~/ws/clearpol-ai
sb-alpha -a wren -b claude --session-candidates-json --sb-debug

cd ~/ws/clearpol-ai--wren
sb-alpha -a wren -b claude --session-candidates-json --sb-debug
```

Expected: candidate sets differ by repo/worktree path; no cross-path leakage.

3. Validate poisoned/snapshot-only Claude IDs are excluded:
   - No picker entries should be created from `.jsonl` files that contain only snapshot events and no real `sessionId` evidence.

4. Validate codex/gemini candidate output still renders correctly:

```bash
cd ~/ws/clearpol-ai
sb-alpha -a lumen -b codex --session-candidates-json --sb-debug
sb-alpha -a aster -b gemini --session-candidates-json --sb-debug
```

## Test suites to run

At minimum:

```bash
yarn workspace @inkstand/cli type-check
yarn workspace @inkstand/cli test -- src/cli.test.ts
yarn workspace @inkstand/cli test -- src/commands/claude.test.ts
yarn workspace @inkstand/cli test -- src/commands/claude.integration.test.ts
yarn workspace @inkstand/cli test -- src/commands/hooks.test.ts
yarn workspace @inkstand/cli test -- src/lib/pcp-mcp.test.ts
```

## Optional local smoke tests (not CI)

For real-backend validation of `sb chat` local tool routing (`ink-tool` → sb runtime execution),
run:

```bash
yarn workspace @inkstand/cli test:smoke:live
```

The smoke runner:

- requires a live PCP API server (`INK_SERVER_URL`, default `http://localhost:3101`)
- uses real backend CLIs (claude/codex/gemini) if installed
- checks for `local tool get_inbox` in output as proof that tool execution happened in sb runtime

Environment overrides:

```bash
SB_SMOKE_AGENT=lumen \
SB_SMOKE_BACKENDS="claude codex gemini" \
INK_SERVER_URL=http://localhost:3101 \
yarn workspace @inkstand/cli test:smoke:live
```

## Logging

- Use `--sb-debug` for runtime tracing.
- Current debug log path:

```text
~/.ink/sb-debug.log
```
