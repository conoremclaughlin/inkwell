# Runtime

The ink runtime's host-independent pieces: the agent loop (`runAgentLoop`),
text-tool grammar, context ledger, context tools, compaction policy, token
accounting, session journal, hook registry and built-in recall/budget hooks. The CLI's `ink chat` and its shadow
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

This is the existing ledger, hook and history implementation, not a complete hosted
session. Prompt composition, compaction orchestration, skills,
live control delivery and provider adapters still need their own host boundaries.
The context tools require an explicit status sink for each parent and clone;
there is no process-global fallback. Compaction still uses the existing
synchronous marker callback: moving the policy does not yet make its journal
commit asynchronous or provide hosted recovery.
Each ledger/registry/recall registration owns its own state. Hosts serialize
hooks within one session; different sessions can await recall independently.

The pre-existing passive-recall eviction tracker is a placeholder: it does
not populate its eviction map. Already-injected IDs therefore remain
deduplicated even after eviction; the configured reinjection cooldown is not
yet implemented. This relocation preserves that behavior rather than claiming
the simulated recall tests prove the production tracker works.

## Session restoration

`hydrateLedgerFromEvents` reuses the CLI's existing replay policy with an
explicit, host-loaded event snapshot. Compaction and eviction ordering,
platform-message replay metadata, recall/inbox/activity cursors, clone summaries
and event-ID recovery stay the same. `findLastBackendSessionInEvents` and
`findLastDetectedModelInEvents` recover provider continuity from that snapshot;
they do not start providers or decide whether an interrupted effect is safe to
repeat. The session-context fallback also lives here.

The CLI keeps its public file-based wrappers. A server host must load storage
asynchronously before calling the shared functions. This extraction does not
activate an async CLI sink, change replay formats, implement safe crash recovery,
or make loading and replay of an arbitrarily large history bounded/nonblocking.
The small activity, auto-eviction and clone-outcome policies are shared with live
CLI handling rather than copied for replay. Their old CLI paths remain shims.

## Session journal

`SessionLog` owns event IDs, serialized writes, flush/close, failure state and
post-commit observer projection. Every shared-runtime caller supplies a sink;
there is no implicit filesystem access. The CLI compatibility class supplies
its existing synchronous JSONL default, and its opt-in async file sink stays
in the CLI host. This extraction does not activate async CLI persistence.

An append's returned ID is reserved, not a commit acknowledgment. Await
`flush()` at a durability boundary. This preserves the existing sink contract;
there is no added fsync/power-loss guarantee, replay engine, write-buffer bound
or safe automatic replay of an unresolved external effect.

## Hosted recovery scope

The experimental database command/tenure/lease admission, D1 journal and
associated adapters are parked outside this runtime extraction. Their source
and tests are preserved on `wren/park/d1-db-journal-and-seal`; the decisions and
conditions for reconsideration remain in `ink://specs/live-agent-surfaces`.
The existing `SessionLog` and CLI tool-intent persistence above are unchanged.
A hosted restart fix is separate server work, not a recovery guarantee provided
by importing this package.

## Guarded paragraph streaming

`ParagraphStreamBuffer` and `StreamedTurnRenderer` are the existing CLI text
state machines, now shared without changing their behavior. Each instance keeps
its own fence context, imitated-result cutoff, attribution and final-message
deduplication. The CLI compatibility path re-exports these exact classes.
The host still supplies the display transform and guard appropriate to its tool
routing; this is not a raw provider stream or an authorization boundary.

This extraction prepares the same guarded text for terminal and hosted sinks;
it does not wire participant fanout, input delivery, durable replay or ownership.
Output still releases at safe paragraph boundaries, not every token. Existing
raw-text retention is not newly bounded by this move: hosted integration must
enforce output/replay budgets without breaking whole-spawn guard context. No
observer projection or current terminal behavior changes here.

`ImitationPreviewGuard` is also shared, with its CLI path re-exporting the same
implementation. It holds possible result-frame prefixes across completed text
blocks and reports whole-spawn offsets used by mid-turn reseeding. It is still
the existing observer-preview guard, not a full participant projection or a
replacement for authorization. Its retained text has the same hosted-budget
limitation as the paragraph renderer above.

## Bounded live delivery

`FrameFanout` delivers an already-encoded string to independent pull readers.
One instance serves one authorized projection, not every principal who happens
to name a session. The host authorizes subscriptions, guards and projects text,
and supplies finite subscriber/count/UTF-8-byte limits. A slow reader overflows
independently; publishing never invokes or awaits consumer code. Reader queues
and their pending reads are bounded, and frames cannot be mutated by a sibling
reader. The host must separately bound its registry and transport/in-flight
writes; a frame returned by `next()` is no longer in this queue.

Detaching a reader does not interrupt the writer. Revocation and source closure
discard queued frames and fail reads explicitly; `ended` also signals a consumer
busy writing its last frame. The host must stop that transport and revalidate
authority before writing: a frame already handed to it cannot be recalled.
Oversized publishes return `too_large` without delivering to anyone, and must
be handled rather than treated as success. Overflow/source closure require the
host's authorized replay/snapshot recovery, not skipping ahead.

`FrameFanout.close()` is for failure and teardown only. It does not drain: even
a queued final frame is discarded and readers fail with `source_closed`. Keep
the fanout open across normal turns; completion comes from a durable record,
not source closure. A concurrent second `next()` rejects with
`FrameReadPendingError`, which is consumer misuse, not a stream ending. The
original pending read and the subscription remain usable.

This primitive is not yet wired to hosted sessions or the CLI. It retains no
history, grants no participant access, creates no cursors, and supplies no
generation fencing or replay/live stitching. The existing observer projection
is unchanged. A guarded-text/two-reader synthetic composition test is not a
real provider or end-to-end attach proof.

## Ordinary input drain

`SerialInputDrain` is the shared FIFO used by the CLI for user, system and
Inkmail-triggered turns. It retains at most the host's declared count and byte
budget (including the active input). Admission is synchronous; its returned
promise represents completion, not a durable receipt. Capacity refusals happen
before local preparation and are retryable. An individually oversized input is
refused as `too-large`, even when the queue is empty. The CLI displays and journals
its inbox auto-run refusal before acknowledging delivery; it does not pretend the
turn ran or retry it indefinitely. Other thread-intake failures remain unacknowledged.
An input failure does not poison the next queued turn. If a preparation callback
throws or closes intake, its caller must undo accounting effects; presentation
must be safe to repeat.

The CLI currently caps the queue at 128 inputs / 8 MiB of UTF-8 input fields.
The host supplies size measurement; the runtime never reads environment or
process state. Each instance has its own queue, so independent sessions remain
concurrent. `close()` closes intake and waits for accepted work; it does not
interrupt it. Interrupt and approval responses must go directly to the active
owner, not into this ordinary-input drain.

This is not a lease, cross-process ownership fence, deduplication store, or
crash-recovery mechanism. A hosted adapter must preserve accepted input through
restart and prevent overlapping writers before dispatch; this primitive does
not prescribe a datastore or database admission functions. Running two drains
for the same session is NOT prevented by this class. Hosted recovery and
multi-view streaming require their own integration and end-to-end tests.

## Session turn context coordinator

`SessionTurnCoordinator` is the CLI's shared context lifecycle around the existing
execution callback: input provenance and transcript writes, pre-turn compaction,
measured-occupancy hooks, persisted recall injections, assistant outcome,
consumed-tool-result eviction, and turn-end hooks. It receives explicit ledger,
hook, log, state, occupancy, compaction and eviction ports. Native-session
invalidation still goes through the host's existing persistent eviction path.
It has no process globals, filesystem defaults or network client.

Turn-end hooks now finish before the next ordinary input or one-shot shutdown,
with a finite whole-event budget (5 seconds by default, at most 60 seconds).
Previously their unawaited recall could inject into the next prompt or append
after the transcript closed. Assistant entries flush and notify the host before
this tail, so recall does not delay the reply. Aborted turns skip end hooks.
The registry abandons late hook results on cancellation; built-in recall also
leaves its dedup/cooldown state unchanged when its late read returns. Hooks
must return mutations, not mutate the ledger or perform effects after cancellation.
An ignored signal cannot stop arbitrary third-party work, only its result application.
Timeout is recorded in the log; the next input can then proceed. Hook handler
failures remain isolated by the registry; log failures propagate. Log flush is
awaited before execution, reply notification and completion. This observes the existing SessionLog's write
promise, not fsync, a transaction, cross-process exclusion or recovery.

Each instance serves one session and refuses overlapping runs; the host still
owns its FIFO and admission. Execution, errors and cancellation do not manufacture
a completed assistant response. Separate instances can run concurrently.

Prompt/identity/skill rendering, measured occupancy and continuation/reseed
policy now live in `session-prompt.ts`; the CLI supplies its instruction catalog.
This extraction is not yet the complete hosted session entry. Bootstrap calls,
provider orchestration, tool policy, media, live controls, cancellation
and rendering still have host composition in `runChat`. Both hosts must bind
that same extracted composition before claiming API parity; a bare call to
`runAgentLoop` with fresh context is not an equivalent implementation.

### Session provider composition

`../providers/session-provider.ts` now holds the existing parent turn's native
provider continuity and relay-occupancy policy. `runChat` uses it for initial
launch, missing-session recovery, and tool-loop continuations. Its explicit
ports carry the live envelope, session-specific launch host, log, stream events,
usage sampling, mutation generation, cancellation handle, and presentation
callbacks. It imports provider request **types** but never launches on its own;
it belongs to the Node provider layer rather than widening this pure runtime
entry point's import boundary. Stateless budget arithmetic lives here in
`session-budget.ts`.

This extraction is not the complete hosted session binding: bootstrap/state
hydration, tool-policy composition, controls, and per-host cleanup must still
join the coordinator and provider composition before a server turn is enabled.

Prompt-build hooks also have a whole-event 5-second default budget (validated
1–60000 ms); their late returned mutations are discarded. A timed-out optional
hook is recorded and dispatch proceeds with the context already available.
The coordinator accepts the host's per-turn AbortSignal: cancellation interrupts
hook waits and is checked before dispatch, rather than being treated as an
optional-hook timeout. Hosts must separately cancel/fence their own I/O;
awaiting compaction is not proof that its external effects are cancellable.
The outcome callback must not throw: it runs after persistence, so its failure
cannot authorize retrying that committed reply.

### Tool execution boundary

`tool-call-executor.ts` is the same sequential policy/approval/intent pipeline
used by parent and clone CLI turns. Hosts supply the policy decision port,
invocation-id mint, local-surface diagnostics, approvals, and dispatcher. The
CLI adapter supplies its existing implementations; no host receives an
implicit permissive policy. `createToolIntentCommitter` uses the existing
session log and waits for its writes before dispatch. Credential expansion
still belongs inside the dispatcher, after the unresolved model arguments are
recorded. Policy storage, coding-tool/catalog setup and approval transports
remain host composition; this extraction alone does not enable the API host.

### Tool policy and host persistence

`ToolPolicyState` and `tool-profiles` are the existing Ink policy, not a second
hosted permission model. The runtime takes a host-loaded v1/v2 snapshot and an
optional synchronous `onChange(snapshot)` staging callback. It does not read the
home directory or touch a file. The CLI adapter retains its existing path,
malformed-file fallback, write permissions, and synchronous persistence points.

An API host must load its policy asynchronously before constructing the state.
If it stages writes in `onChange`, it must await that queue (and surface errors)
before admitting the corresponding effect, alongside the tool-intent barrier.
Do not pass an async callback and discard its promise. A policy instance is not
a lock or a cross-session grant authority: the host must coordinate instances
that share persisted grants. Session-only grants remain session-only and are
never serialized. Async persistence coordination is a binding requirement, not
an implementation provided by this extraction.
