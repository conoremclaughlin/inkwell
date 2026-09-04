# Memory benchmark terms

This package is for experimental memory-system benchmarks only. It must not be bundled into production packages.

## Terms we use precisely

- **Benchmark case**: one dataset question plus its source sessions/documents. Example: one LongMemEval question.
- **Source memory**: one memory row created from benchmark source text. For LongMemEval this is usually one session transcript from the case haystack. Source memories are raw evidence, not extracted facts.
- **Seed pass**: creates source memory rows for benchmark cases and records their memory IDs in a `*.seed.json` file. A seed pass does not mean entity/fact/summary extraction happened.
- **Seed ID**: a stable label used to group source memories from one seed pass. The script writes topics like `benchmark:memory-recall:<seedId>` so later extraction/backfill jobs can target exactly that corpus.
- **Extraction pass**: reads source memories and asks a configured backend to produce structured JSON views: `entity`, `durable_fact`, `summary`, and/or `current_state`.
- **Extraction audit file**: JSONL output from `extract-memory-llm-views` containing the exact extracted payload and exact strings that will be embedded. This is the human-inspectable record of what the model produced.
- **Embedding/backfill pass**: embeds source memory content plus any saved extraction views and writes vectors/chunks. This is separate from seeding and extraction.
- **Recall pass**: runs benchmark queries against an already seeded and embedded corpus.

Use `MEMORY_LLM_EXTRACT_MEMORY_ID=<memoryId>` or `BACKFILL_MEMORY_ID=<memoryId>` when an experiment should touch exactly one source memory. Use the seed/case topics when it should touch a whole corpus or case.

## Recall mode definitions

- **text**: lexical/text search over memory rows.
- **semantic**: vector search over the selected embedding chunks.
- **hybrid**: text search + one semantic search, merged and reranked by weighted text/semantic score. Hybrid does not mean multi-view routing.
- **multi-view router**: an experimental hybrid option that separately queries derived chunks and content chunks, then applies optional chunk-type, multi-view, and chronology boosts. This is not the default meaning of hybrid.

## LLM extraction backends

Extraction should normally use a subscription-backed CLI runner rather than direct provider API billing:

```bash
MEMORY_LLM_EXTRACT_BACKEND=claude # or codex
MEMORY_LLM_EXTRACTION_ENABLED=true
MEMORY_LLM_ENTITY_ENABLED=true
MEMORY_LLM_DURABLE_FACT_ENABLED=false
MEMORY_LLM_SUMMARY_ENABLED=false
yarn workspace @inklabs/api extract:memory-llm-views
```

`MEMORY_LLM_EXTRACT_BACKEND=direct` is the direct OpenAI-compatible HTTP path and requires `OPENAI_API_KEY`. Runner-backed extraction uses the existing Claude/Codex CLI runners and writes the same audit JSONL.

## Minimal controlled experiment shape

The memory experiment pipeline has three conceptual steps:

1. **Extract**: use our prompts to derive the salient view for one axis of investigation, e.g. `entity`, `durable_fact`, `summary`, or `current_state`. This is not a mechanical preprocessing step; it is part of the research surface and can strongly affect benchmark quality.
2. **Embed**: generate vectors for the exact extracted strings we plan to query later.
3. **Store for querying**: persist the extracted payloads and vectors in the database so recall can use them. Steps 2 and 3 can happen in the same backfill operation.

Controlled benchmark flow:

1. Seed source memories once for a benchmark corpus.
2. Run one extraction pass at a time, e.g. entity-only.
3. Inspect the extraction audit JSONL before trusting the vectors.
4. Backfill embeddings scoped by `BACKFILL_MEMORY_TOPIC=benchmark:memory-recall:<seedId>`.
5. Run recall using explicit modes/variants and record the output/state files.

Future recurrent/dream passes should treat prior extracted views as possible source material too. For example, durable facts may be summarized, deduplicated, contradicted, or consolidated against earlier durable facts rather than only extracted from raw episodic memories.

## LoCoMo experiment terms

LoCoMo is not shaped like LongMemEval. It contains 10 long conversations, and each
conversation has many questions. We therefore use these terms:

- **Conversation/sample**: one isolated LoCoMo conversation (`sample_id`). This is the normal retrieval scope.
- **Session document**: one chronological `session_<n>` containing all of that session's turns and timestamp.
- **Turn document**: one dialog turn identified by `dia_id`.
- **QA row**: question, answer, category, and evidence IDs. QA labels belong only in the evaluation manifest—never in embedded source text.

Run the loader audit before seeding:

```bash
yarn workspace @inklabs/benchmarks audit:locomo
```

For the public `locomo10.json` currently identified by SHA-256
`79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`, the
clean loader finds:

- 10 conversations
- 272 sessions
- 5,882 turns
- 1,986 QA rows
- 1,979 questions with fully resolvable evidence
- 4 questions with no evidence
- 3 questions with partial/malformed evidence metadata

The loader preserves the malformed raw fields and records every unambiguous repair.
It does not silently discard those questions.

`loadLoCoMoDataset()` is retained only as a legacy adapter for the generic per-QA
harness. Its source is explicitly labeled `legacy-qa-duplicated` because it repeats
the same conversation for each question. Do not publish results from that path. The
clean LoCoMo harness must seed a conversation once and reuse it for all of that
conversation's QA rows.

## Clean LoCoMo retrieval baseline

The dedicated harness uses one isolated LoCoMo conversation as the retrieval scope.
It never embeds QA questions, answers, evidence labels, or cross-conversation text.
Rows use the non-identity recall scope `__benchmark_locomo__`, so they are excluded from
normal Lumen/Wren/Aster recall despite sharing the same database.

In this harness, **seeding** means all of the following completed for each selected
source document:

1. one raw `memories` row was created;
2. its raw content was embedded by the configured provider;
3. the content vector(s) were persisted in `memory_embedding_chunks`;
4. the seed manifest recorded the source document ID, memory ID, content hash, chunk count,
   and elapsed time.

It does **not** mean an LLM extraction or dream pass ran. The harness verifies that every
seed contains content chunks only and fails if summary, fact, entity, or other derived vectors
appear. A turn is one source document; a session is one source document that may require
multiple content chunks because the local model's vetted input limit is shorter than some
sessions.

Seed the complete turn representation with local embeddings:

```bash
BENCHMARK_USER_ID=<uuid> \
MEMORY_EMBEDDINGS_ENABLED=true \
MEMORY_EMBEDDING_PROVIDER=ollama \
MEMORY_EMBEDDING_MODEL=mxbai-embed-large \
LOCOMO_PHASE=seed \
LOCOMO_REPRESENTATION=turn \
yarn benchmark:locomo
```

Run content-only semantic retrieval against that seed:

```bash
BENCHMARK_USER_ID=<uuid> \
MEMORY_EMBEDDINGS_ENABLED=true \
MEMORY_EMBEDDING_PROVIDER=ollama \
MEMORY_EMBEDDING_MODEL=mxbai-embed-large \
LOCOMO_PHASE=recall \
LOCOMO_REPRESENTATION=turn \
LOCOMO_SEMANTIC_INDEX=memory-chunks \
LOCOMO_RUN_ID=<stable-run-id> \
yarn benchmark:locomo
```

`LOCOMO_SEMANTIC_INDEX=memory-chunks` is forced: an RPC error fails the run rather than
silently falling back to `memories.embedding`. The alternate
`memory-single-vector` ablation explicitly searches that memory-level vector. For an
over-limit session, the current write path stores its first content chunk—not the impossible
full-session input—in `memories.embedding`; the result manifest states this explicitly.

There are no implicit sample, question, or distractor caps. `LOCOMO_SAMPLE_IDS` and
`LOCOMO_QUESTION_LIMIT` apply only when explicitly set. A question limit never removes source
documents from a selected conversation, so every within-conversation distractor remains present.

Each run always writes tail-able progress logs plus atomic resumable state under
`packages/benchmarks/output/locomo/` (or the paths given by `LOCOMO_LOG_PATH`,
`LOCOMO_SEED_STATE_PATH`, and `LOCOMO_RUN_STATE_PATH`). The final result separates
hit-any@K, hit-all@K, evidence coverage@K, and MRR@max-K; it does not call a censored top-K
rank an unbounded MRR.
