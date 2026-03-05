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
yarn workspace @personal-context/cli build
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
yarn workspace @personal-context/cli type-check
yarn workspace @personal-context/cli test -- src/cli.test.ts
yarn workspace @personal-context/cli test -- src/commands/claude.test.ts
yarn workspace @personal-context/cli test -- src/commands/claude.integration.test.ts
yarn workspace @personal-context/cli test -- src/commands/hooks.test.ts
yarn workspace @personal-context/cli test -- src/lib/pcp-mcp.test.ts
```

## Logging

- Use `--sb-debug` for runtime tracing.
- Current debug log path:

```text
~/.pcp/sb-debug.log
```
