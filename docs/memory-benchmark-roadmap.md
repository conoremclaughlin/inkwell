# Memory Benchmark Roadmap

This document lays out how Inkwell should evaluate its memory system as we move from simple retrieval toward richer long-term memory, reflection, and context-eviction behavior.

## Benchmark philosophy

We should start by measuring ourselves against existing public memory benchmarks before inventing new ones. That gives us an honest baseline, makes external comparison possible, and forces discipline around evaluation before we optimize for our own runtime.

There are two axes we ultimately care about:

1. **Retrieval quality** — does the right memory surface?
2. **Continuity efficiency** — how much context/token budget does it take to preserve continuity over time?

Phase 1 is about the first axis. Phase 2 introduces the second.

## Lessons from other systems

### MemPal

MemPal's most important lesson is not any single top-line score. It is benchmark discipline.

- Keep a strong simple baseline.
- Distinguish clean vs contaminated results.
- Store per-case outputs, not just aggregate metrics.
- Separate retrieval quality from end-to-end answer quality.
- Be explicit when improvements come from heuristics, reranking, or architecture changes.

Architecturally, MemPal also suggests that **verbatim memory is a stronger baseline than many systems assume**. Compression and extraction can destroy signal. We should treat raw memory plus good retrieval as a real baseline, not something to immediately outgrow.

### Hermes

Hermes draws a strong line between:
- small curated memory that is always in-context
- larger searchable history that is only pulled when needed

That distinction matters for Inkwell too. Our future benchmarks should separate:
- long-term retrieval quality
- bootstrap relevance
- live context budget behavior

### Honcho

Honcho's lesson is that memory can be more than retrieval. It can become a **stateful user/project model** with asynchronous background derivation and lightweight representations for prompt hydration.

That should influence our later dream-phase work, but it should not distract us from proving the base retrieval layer first.

## Benchmark tracks

### Track 1 — Standard public retrieval benchmarks

This is the immediate priority.

We should support and compare on:
- **LongMemEval** — long-horizon conversational memory retrieval
- **LoCoMo** — multi-hop conversational QA / temporal retrieval pressure
- **ConvoMem** — large-scale conversational memory evaluation
- **MemBench / BEAM-style suites** — broader long-context and noisy-memory stress tests

For each benchmark, we should be able to evaluate:
- text retrieval
- semantic retrieval
- hybrid retrieval
- chunked semantic retrieval
- optional rerank as a separate tier

Metrics:
- Recall@1 / @3 / @5 / @10
- MRR
- NDCG
- latency
- optional rerank cost

### Track 2 — Bootstrap relevance

We already have the beginning of this.

Question:
- given a thread/focus/session context, do we inject the right memories into bootstrap?

This measures relevance of **memory selection for live work**, not just abstract retrieval.

### Track 3 — Ink-native context eviction

This is where Ink can become genuinely differentiated.

Question:
- when an SB can manage and evict its own context, how well does continuity survive?

This belongs after public benchmark parity, not before.

## Parallel second brain implications

The most relevant and unique lesson from our parallel second brain direction is that memory should not be a single retrieval layer. We should preserve **raw memories** while also letting a slower background system derive additional memory views.

The likely long-term layers are:
- raw chunked memory for faithful recall
- durable fact extraction for concise stable claims
- entity/person/project memories for who-or-what centric lookup
- summary memories for coarse routing across large histories
- override / contradiction links so newer policy or state can explicitly supersede older memory

That means our future benchmark tiers should not just compare text vs semantic vs hybrid. They should eventually compare:
- raw only
- raw + durable facts
- raw + entity/fact indexes
- raw + override-aware scoring

This is especially important for domains like policy and healthcare, where semantic similarity alone is not enough. If one memory overrides another, retrieval quality depends on chronology, provenance, and explicit linkage as much as embedding distance.

For now, this affects the benchmark roadmap in one specific way: we should keep our baseline honest, but design the harness so we can later add multiple retrieval views and score how much each derived layer helps or hurts.

## Evaluation rules

We should adopt explicit benchmark hygiene rules:

- Keep a **cheap baseline** that uses no LLM extraction/rerank.
- Introduce a fixed **dev / held-out split** for any internally tuned benchmark set.
- Label runs as:
  - `clean`
  - `tuned_on_dev`
  - `contaminated`
- Persist **per-case failures** and top retrieved candidates.
- Treat retrieval and answer-generation as separate measurements.
- Never publish a score without saying whether reranking / LLM extraction was involved.

## Inkwell benchmark roadmap

### Phase 1 — Public benchmark parity

Goal: run Inkwell against standard external benchmark families and produce honest baseline numbers.

Deliverables:
- dataset loaders/adapters for standard public benchmarks
- benchmark run metadata that records family, split, and mode
- per-case result persistence
- clean baseline vs rerank-assisted tiers

### Phase 2 — Benchmark hygiene upgrade

Goal: make our results publishable and comparable over time.

Deliverables:
- dev/held-out split support for internal sets
- contamination labeling
- regression tracking by architecture version
- benchmark comparison tables over time

Current implementation direction:
- phase-2 retrieval should query **multiple chunk views** (`summary`, `fact`, `topic`, `entity`, `content`)
- retrieval should be able to filter chunk types at the RPC layer
- `memory_embedding_chunks(user_id, chunk_type)` should be indexed so view-specific retrieval stays cheap
- derived-view matches and raw-content matches should merge before hybrid scoring

### Phase 3 — Dream-phase memory

Goal: test the value of durable fact extraction and higher-order summaries.

Deliverables:
- benchmark modes for:
  - raw memory only
  - raw + durable facts
  - raw + dream-phase summaries
  - raw + dream-phase + rerank
- explicit comparison between extraction-enhanced memory and verbatim baselines

Early implementation slices:
- chronology-aware reranking as the first optional second pass
- durable fact candidates linked back to source memories
- duplicate-candidate detection for same-topic memories
- supersession / contradiction candidate detection for chronological review

### Phase 4 — Ink-native context eviction benchmark

Goal: measure continuity under context pressure.

Possible metrics:
- task success after eviction
- recovery rate for evicted-but-needed context
- false reinjection rate
- turns-to-recovery
- tokens freed vs continuity preserved

## Near-term implementation order

1. Add benchmark family descriptors and public benchmark scaffolding.
2. Wire the first external benchmark family into the existing benchmark scripts.
3. Add dev/held-out split support for internal sets.
4. Add run labeling for clean vs contaminated evaluation.
5. Only then design the first Ink-native eviction benchmark.

## What success looks like

Short term:
- Inkwell can run against the same public memory benchmarks other systems cite.
- We can report quality and cost honestly.
- We can compare raw, hybrid, chunked, and reranked modes clearly.

Long term:
- Ink can show not just that it retrieves well, but that it preserves continuity under self-managed context pressure.
