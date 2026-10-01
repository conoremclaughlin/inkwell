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

- **Imports reach only the files the test scans.** No Node built-ins, no
  `@inklabs/shared` root, no other package. A relative import must name a
  non-test `.ts` file in this directory by its `.js` path, so a test file, a
  `.mts` file or a missing file is refused even though it sits here. Everything
  the loop touches (the backend, tool execution, the terminal, the transcript)
  arrives through `AgentLoopPorts`, supplied by the host.
- **No host globals.** `process`, `require`, `__dirname`, `global`,
  `globalThis` and their relatives are refused. The one exception is
  `Buffer.byteLength` in `utf8Bytes` (`agent-loop.ts`), so this directory is
  Node-compatible, not browser-native. The test names that site: a second use
  fails it, and so does removing the first without removing the allowance.
- **No mutable module state.** A host may run several sessions in one process,
  and they share everything that runs when the module loads: anything outside a
  function body or an instance field, however it is nested or wrapped. So at
  load time there is no `let` or `var`, no regex with the `g` or `y` flag (its
  `lastIndex` is state), and no `new`, except as the whole initializer of a
  `const` declared `ReadonlySet<…>` or `ReadonlyMap<…>`. The match is by exact
  name, since `Readonly<Set<T>>` keeps `add`. No file here may declare either
  name, because that would shadow the global interface. Constant array and
  object tables, and values returned from a load-time call, are allowed. The
  check cannot prove nobody mutates them, so don't.
- **Imported by its own path, never re-exported from the package root.** The
  root barrel carries Node-only code (process spawning, filesystem config).
- **Tests sit beside the code.** The CLI's tests resolve this subpath to its
  source through a vitest alias (in the root `vitest.config.ts` and
  `packages/cli/vitest.config.ts`), so an edit here reaches them without
  rebuilding the package.
