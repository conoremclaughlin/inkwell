# Real-Scenario Memory Eval

Measures whether PCP's passive recall surfaces the RIGHT memories during real vocational work — not synthetic benchmarks. Built as the evaluation arm of the memory-eviction work started in PR #242.

Spec: `ink://specs/memory-real-scenario-eval` (artifact on the Inkwell server).

## Why

The previous benchmark asked "does recall return memories that contain certain keywords?" — easy to game, doesn't reflect usage. This harness asks a harder question: **given a realistic turn of work, does memory surface what we'd need to act correctly?** That includes refusing a wrong premise, grounding continued work across compaction, and keeping someone's state-of-affairs in view.

## Capabilities under test

| Capability       | What it proves                                                       |
| ---------------- | -------------------------------------------------------------------- |
| **recall**       | The right memories surface when working on a topic                   |
| **eviction**     | Irrelevant memories drop out when the conversation shifts            |
| **re-hydration** | Previously-evicted memories come back when we re-enter their topic   |
| **correction**   | Memory contradicts a stale premise rather than complying             |
| **continuity**   | Post-compaction, the SB still knows what was being worked on and why |

v1 of the runner handles **recall** and **correction** shapes. Eviction / re-hydration / continuity shapes are defined in the schema but stubbed by the runner with "not yet implemented".

## Scenario anatomy

Each scenario is a YAML file in `fixtures/`:

```yaml
id: merge-strategy-rule
shape: convention-recall
capability: [recall]

context: |
  I'm ready to merge PR #350. Should I squash, rebase, or regular merge?

impliedQuestion: What is our merge strategy?

expectedSurfaced:
  - kind: doc_section
    ref: CONTRIBUTING.md#git
    reason: Authoritative source for the rule
    containsPhrases: [merge commit, never squash]

mustAssert:
  - claim: We use merge commits, not squash merges
    criticality: high
    containsPhrases: [merge commit, never squash]

mustNotAssert:
  - claim: Squash is the default
    containsPhrases: [squash is default]

rubric:
  precisionFloor: 0.2
  recallFloor: 0.3
  mustAssertPassRate: 0.5
  mustNotAssertLeakRate: 0.0
```

- **`expectedSurfaced`** — items that _should_ come back from recall, matched either by UUID (`ref`) or by `containsPhrases` (for doc sections without stable IDs).
- **`mustAssert`** — claims the SB must be able to make, given the surfaced memories. Decouples "item X was returned" from "fact Y is derivable." A claim can be derivable even when its canonical source isn't in context.
- **`mustNotAssert`** — plausible-but-wrong claims that indicate hallucination. Flagged as leaks if their phrases appear in surfaced content.
- **`rubric`** — precision/recall floors and assertion-pass-rate thresholds.

## Files

| File                         | Purpose                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| `types.ts`                   | `Scenario`, `ScenarioResult`, `AssertClaim`, shape/capability enums |
| `loader.ts`                  | YAML → validated `Scenario` (+ shape-specific requirements)         |
| `scorer.ts`                  | Pure scoring: `scoreScenario(scenario, signal, surfaced)`           |
| `runner.ts`                  | Orchestrator: `runScenario(scenario, recallFn)`                     |
| `report.ts`                  | Markdown report for a batch of results                              |
| `fixtures/*.yaml`            | Scenario definitions                                                |
| `*.test.ts`                  | Unit tests for loader / scorer / runner                             |
| `runner.integration.test.ts` | Live integration against the PCP server's `recall` tool             |

## Adding a scenario

1. Pick a shape (see `types.ts` `ScenarioShape`).
2. Drop a YAML file into `fixtures/`. Use an existing one as a template.
3. `yarn workspace @inklabs/cli exec vitest run src/repl/real-scenarios/loader.test.ts` — confirms the file validates.
4. `yarn workspace @inklabs/cli exec vitest run src/repl/real-scenarios/runner.integration.test.ts` — runs it against live PCP and prints a report.

If the rubric fails, the finding is usually one of:

- **Memory not seeded** — the canonical memory for the rule doesn't exist yet. `remember()` it.
- **Phrase mismatch** — the memory exists but uses different wording. Either update `containsPhrases` or update the memory.
- **Precision noise** — too many unrelated memories coming back. That's real signal: passive recall needs filtering.

## Running

Unit tests (no server needed):

```bash
yarn workspace @inklabs/cli exec vitest run src/repl/real-scenarios/
```

Integration against live PCP (server must be up at `http://localhost:3001` with a valid `~/.ink/auth.json`):

```bash
# Against the default main dev server
yarn workspace @inklabs/cli exec vitest run src/repl/real-scenarios/runner.integration.test.ts

# Against an isolated test server
INK_SERVER_URL=http://localhost:4001 \
  yarn workspace @inklabs/cli exec vitest run src/repl/real-scenarios/runner.integration.test.ts
```

The integration test is a **reporting** test, not a rubric gate: it passes as long as the harness runs end-to-end and every supported scenario surfaces at least one memory. The printed markdown report is the actual signal — read it to see what the memory system is and isn't doing.

## Why substring matching (v1)

`mustAssert` and `mustNotAssert` are scored by phrase matching against the combined surfaced-memory content. This is deterministic, cheap, and runnable in CI. It's also imperfect — a memory that says "never squash" matches even if the broader context around it would have led the SB astray.

v2 can swap an LLM judge behind the same `claimDerivable(claim, surfaced)` interface without changing scenario files. The schema was designed with that swap in mind.

## Shape reference

- **convention-recall** — "what is our rule for X?" Used for merge strategy, PR process, testing conventions.
- **current-state-correction** — stale premise contradicts known current state. The SB must refuse, not comply. Used for "restart the dev server" when `yarn dev` hot-reloads.
- **person-centric-recall** — context mentions a person; their state-of-affairs should surface (last email, pending replies).
- **state-of-affairs** — open loops, what's pending, what's blocked.
- **why-we-care** — why is X important to us / our work.
- **objective-grounding** — what is the objective of this effort — re-grounds after drift.
- **anti-hallucination-challenge** — confidently-wrong assertion in context, memory must contradict.
- **post-compaction-continuity** — after simulated compaction, can the SB still name what was being worked on?
- **topic-shift** — conversation pivots; old memories should drop, new ones should surface.
- **re-entry** — previously-dropped memories should come back when we return to the topic.
- **concurrent-threads** — two threads interleaved; each turn surfaces its own thread's memories.
