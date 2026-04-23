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
