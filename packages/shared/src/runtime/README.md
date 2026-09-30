# Runtime

The ink runtime's host-independent pieces: the agent loop (`runAgentLoop`),
text-tool grammar, context ledger, hook registry and built-in recall/budget
hooks. The CLI's `ink chat` and its shadow
clones run it today; a server or desktop host is meant to import the same code
rather than write another loop (`ink://specs/live-agent-surfaces`).

```ts
import { runAgentLoop, type AgentLoopPorts } from '@inklabs/shared/runtime';
```

## Rules

`runtime-boundary.test.ts` checks imports, globals and module state in every
non-test source file in this directory.

- **Imports reach only the files the test scans, with one named primitive exception.** No host I/O, no
  `@inklabs/shared` root, no other package. A relative import must name a
  non-test `.ts` file in this directory by its `.js` path, so a test file, a
  `.mts` file or a missing file is refused even though it sits here. Everything
  the loop touches (the backend, tool execution, the terminal, the transcript)
  arrives through `AgentLoopPorts`, supplied by the host.
- The hash helper's exact `import { createHash } from 'node:crypto'` is allowed to
  preserve existing content-addressed eviction references. Namespace imports,
  other crypto bindings and other importing files remain forbidden. The one
  importer is `entry-ref-hash.ts`, and every reference to the binding there must
  be the callee of a direct call: exporting, aliasing, wrapping or passing it
  would hand the Node primitive to files the import rule never admitted. A
  load-time call is refused by the module-state rule below, because the
  accumulator it returns would be shared. This is deterministic hashing, not a
  new filesystem/process/network dependency.
- **No host globals.** `process`, `require`, `__dirname`, `global`,
  `globalThis` and their relatives are refused. The one exception is
  `Buffer.byteLength` in `utf8Bytes` (`agent-loop.ts`), so this directory is
  Node-compatible, not browser-native. The test names that site: a second use
  fails it, and so does removing the first without removing the allowance.
  `console` is forbidden too: hook-error reporting is injected by the host;
  the CLI compatibility wrapper preserves its existing warning output.
- **No mutable module state.** A host may run several sessions in one process,
  and they share everything that runs when the module loads: anything outside a
  function body or an instance field, however it is nested or wrapped. So at
  load time there is no `let` or `var`, no regex with the `g` or `y` flag (its
  `lastIndex` is state), and no `new`, except as the whole initializer of a
  `const` declared `ReadonlySet<…>` or `ReadonlyMap<…>`. The match is by exact
  name, since `Readonly<Set<T>>` keeps `add`. No file here may declare either
  name, because that would shadow the global interface. There is no load-time
  call or tagged template either: a factory, an immediately invoked function or
  an aliased `createHash` returns state as surely as `new` does, and the `new`
  it hides sits in a function body the rule treats as running later. The
  exceptions are `Object.freeze`, `Symbol` and `Symbol.for`, whose arguments are
  still checked, and two reviewed `.map` calls in `imitation-grammar.ts` that
  build plain grammar pieces from string literals; the test names both.
  Constant array and object tables are allowed. The check cannot prove nobody
  mutates them, so don't.
- **Imported by its own path, never re-exported from the package root.** The
  root barrel carries Node-only code (process spawning, filesystem config).
- **Tests sit beside the code.** The CLI's tests resolve this subpath to its
  source through a vitest alias (in the root `vitest.config.ts` and
  `packages/cli/vitest.config.ts`), so an edit here reaches them without
  rebuilding the package.

## Scope of the context extraction

This is the existing ledger and hook implementation, not a complete hosted
session. Prompt composition, hydration, compaction orchestration, skills,
live controls and provider adapters still need their own host boundaries.
Each ledger/registry/recall registration owns its own state. Hosts serialize
hooks within one session; different sessions can await recall independently.

The pre-existing passive-recall eviction tracker is a placeholder: it does
not populate its eviction map. Already-injected IDs therefore remain
deduplicated even after eviction; the configured reinjection cooldown is not
yet implemented. This relocation preserves that behavior rather than claiming
the simulated recall tests prove the production tracker works.
