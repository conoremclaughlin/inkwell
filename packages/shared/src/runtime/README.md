# Runtime

The ink runtime's host-independent pieces: the agent loop (`runAgentLoop`)
and the text-tool grammar it parses. The CLI's `ink chat` and its shadow
clones run it today; a server or desktop host is meant to import the same code
rather than write another loop (`ink://specs/live-agent-surfaces`).

```ts
import { runAgentLoop, type AgentLoopPorts } from '@inklabs/shared/runtime';
```

## Rules

`runtime-boundary.test.ts` checks the first three on the source, on every
non-test file in this directory.

- **Imports stay inside this directory.** No Node built-ins, no
  `@inklabs/shared` root, no other package. Everything the loop touches (the
  backend, tool execution, the terminal, the transcript) arrives through
  `AgentLoopPorts`, supplied by the host.
- **No host globals.** `process`, `require`, `__dirname`, `global`,
  `globalThis` and their relatives are refused. The one exception is
  `Buffer.byteLength` in `utf8Bytes` (`agent-loop.ts`), so this directory is
  Node-compatible, not browser-native. The test names that site: a second use
  fails it, and so does removing the first without removing the allowance.
- **No mutable module state.** A host may run several sessions in one process,
  and they share every module-level binding. So no top-level `let` or `var`, no
  top-level `new` unless its declared type is `Readonly…`, and no top-level
  regex with the `g` or `y` flag (its `lastIndex` is state). Constant array and
  object tables are allowed; the check cannot prove nobody mutates them, so
  don't.
- **Imported by its own path, never re-exported from the package root.** The
  root barrel carries Node-only code (process spawning, filesystem config).
- **Tests sit beside the code.** The CLI's tests resolve this subpath to its
  source through a vitest alias (in the root `vitest.config.ts` and
  `packages/cli/vitest.config.ts`), so an edit here reaches them without
  rebuilding the package.
