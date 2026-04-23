import { createSupabaseClient } from '../data/supabase/client';
import type { Database } from '../data/supabase/types';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  buildExtractionPrompt,
  buildCurrentStateEmbeddingTexts,
  buildDurableFactEmbeddingTexts,
  buildEntityEmbeddingTexts,
  buildSummaryEmbeddingTexts,
  MemoryLlmExtractor,
  durableFactExtractionSchema,
  entityExtractionSchema,
  currentStateExtractionSchema,
  summaryExtractionSchema,
  normalizeMemoryExtractions,
  MEMORY_EXTRACTION_VERSION,
  type ExtractionKind,
  type MemoryExtractionSource,
  type MemoryExtractions,
} from '../services/memory-llm-extraction';
import { ClaudeRunner, CodexRunner } from '../services/sessions';
import type { ClaudeRunnerConfig, IRunner } from '../services/sessions/types';
import { env } from '../config/env';

type MemoryRow = Database['public']['Tables']['memories']['Row'];

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function parsePositiveInt(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultValue;
}

function buildExtractionEmbeddingTexts(
  llmExtractions: MemoryExtractions
): Record<string, string[]> {
  return {
    entity: llmExtractions.entity ? buildEntityEmbeddingTexts(llmExtractions.entity) : [],
    durable_fact: llmExtractions.durable_fact
      ? buildDurableFactEmbeddingTexts(llmExtractions.durable_fact)
      : [],
    summary: llmExtractions.summary ? buildSummaryEmbeddingTexts(llmExtractions.summary) : [],
    current_state: llmExtractions.current_state
      ? buildCurrentStateEmbeddingTexts(llmExtractions.current_state)
      : [],
  };
}

function getEnabledKinds(): ExtractionKind[] {
  const enabledKinds: ExtractionKind[] = [];
  if (env.MEMORY_LLM_ENTITY_ENABLED) enabledKinds.push('entity');
  if (env.MEMORY_LLM_DURABLE_FACT_ENABLED) enabledKinds.push('durable_fact');
  if (env.MEMORY_LLM_SUMMARY_ENABLED) enabledKinds.push('summary');
  if (env.MEMORY_LLM_CURRENT_STATE_ENABLED) enabledKinds.push('current_state');
  return enabledKinds;
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('runner extraction response did not contain a JSON object');
  }
  return trimmed.slice(firstBrace, lastBrace + 1);
}

function parseKindPayload(kind: ExtractionKind, raw: unknown): MemoryExtractions[ExtractionKind] {
  switch (kind) {
    case 'entity':
      return entityExtractionSchema.parse(raw);
    case 'durable_fact':
      return durableFactExtractionSchema.parse(raw);
    case 'summary':
      return summaryExtractionSchema.parse(raw);
    case 'current_state':
      return currentStateExtractionSchema.parse(raw);
  }
}

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function sanitizeSourceForRunner(source: MemoryExtractionSource): MemoryExtractionSource {
  return {
    ...source,
    summary: source.summary
      ? clampText(source.summary, Math.min(env.MEMORY_LLM_MAX_INPUT_CHARS, 2000))
      : source.summary,
    content: clampText(source.content, env.MEMORY_LLM_MAX_INPUT_CHARS),
  };
}

class RunnerBackedMemoryExtractor {
  private readonly enabledKinds = getEnabledKinds();
  private readonly runner: IRunner;
  private readonly backend: 'claude' | 'codex';
  private readonly config: ClaudeRunnerConfig;

  constructor(backend: 'claude' | 'codex') {
    this.backend = backend;
    this.runner = backend === 'claude' ? new ClaudeRunner() : new CodexRunner();
    this.config = {
      workingDirectory: process.env.MEMORY_LLM_EXTRACT_WORKING_DIRECTORY || process.cwd(),
      mcpConfigPath: process.env.MEMORY_LLM_EXTRACT_MCP_CONFIG_PATH || '',
      ...(env.MEMORY_LLM_MODEL ? { model: env.MEMORY_LLM_MODEL } : {}),
      systemPrompt:
        'You are a deterministic memory extraction worker. Do not use tools. Return only strict JSON matching the requested schema.',
      sandboxBypass: false,
    };
  }

  isEnabled(): boolean {
    return env.MEMORY_LLM_EXTRACTION_ENABLED && this.enabledKinds.length > 0;
  }

  getEnabledKinds(): ExtractionKind[] {
    return [...this.enabledKinds];
  }

  async extract(source: MemoryExtractionSource): Promise<MemoryExtractions | null> {
    if (!this.isEnabled()) return null;
    const sanitizedSource = sanitizeSourceForRunner(source);
    const payload: Partial<MemoryExtractions> = {
      version: MEMORY_EXTRACTION_VERSION,
      provider: `runner:${this.backend}`,
      model: env.MEMORY_LLM_MODEL || this.backend,
      extractedAt: new Date().toISOString(),
    };

    for (const kind of this.enabledKinds) {
      const result = await this.extractKind(kind, sanitizedSource);
      if (!result) continue;
      switch (kind) {
        case 'entity':
          payload.entity = result as MemoryExtractions['entity'];
          break;
        case 'durable_fact':
          payload.durable_fact = result as MemoryExtractions['durable_fact'];
          break;
        case 'summary':
          payload.summary = result as MemoryExtractions['summary'];
          break;
        case 'current_state':
          payload.current_state = result as MemoryExtractions['current_state'];
          break;
      }
    }

    const normalized = normalizeMemoryExtractions(payload);
    return normalized &&
      Object.keys(normalized).some((key) =>
        ['entity', 'durable_fact', 'summary', 'current_state'].includes(key)
      )
      ? normalized
      : null;
  }

  private async extractKind(
    kind: ExtractionKind,
    source: MemoryExtractionSource
  ): Promise<MemoryExtractions[ExtractionKind] | null> {
    const prompt = buildExtractionPrompt(source, kind);
    const message = [
      prompt.systemPrompt,
      prompt.schemaDescription,
      '',
      'Return only the JSON object. Do not wrap it in Markdown. Do not call tools.',
      '',
      prompt.userPrompt,
    ].join('\n');
    const result = await this.runner.run(message, { config: this.config });
    if (!result.success) {
      console.warn(
        `[memory-llm-extract] runner backend=${this.backend} kind=${kind} failed: ${result.error || 'unknown error'}`
      );
      return null;
    }

    const content =
      result.finalTextResponse ||
      result.responses
        .map((response) => response.content)
        .filter(Boolean)
        .join('\n');
    if (!content.trim()) {
      console.warn(
        `[memory-llm-extract] runner backend=${this.backend} kind=${kind} returned no text`
      );
      return null;
    }

    try {
      return parseKindPayload(kind, JSON.parse(extractJsonObject(content)));
    } catch (error) {
      console.warn(
        `[memory-llm-extract] runner backend=${this.backend} kind=${kind} returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }
}

async function main() {
  const userId = process.env.MEMORY_LLM_EXTRACT_USER_ID || process.env.BENCHMARK_USER_ID;
  if (!userId) {
    throw new Error('MEMORY_LLM_EXTRACT_USER_ID or BENCHMARK_USER_ID is required');
  }

  const limit = parsePositiveInt(process.env.MEMORY_LLM_EXTRACT_LIMIT, 100);
  const offset = parsePositiveInt(process.env.MEMORY_LLM_EXTRACT_OFFSET, 0);
  const topic = process.env.MEMORY_LLM_EXTRACT_TOPIC;
  const dryRun = parseBoolean(process.env.MEMORY_LLM_EXTRACT_DRY_RUN, false);
  const force = parseBoolean(process.env.MEMORY_LLM_EXTRACT_FORCE, false);
  const outputPath =
    process.env.MEMORY_LLM_EXTRACT_OUTPUT_PATH ||
    resolve(
      process.cwd(),
      'output',
      'memory-extractions',
      `memory-llm-extract-${Date.now()}.jsonl`
    );

  const backend = (process.env.MEMORY_LLM_EXTRACT_BACKEND || 'direct').trim().toLowerCase();
  if (!['direct', 'claude', 'codex'].includes(backend)) {
    throw new Error('MEMORY_LLM_EXTRACT_BACKEND must be one of: direct, claude, codex');
  }
  const extractor =
    backend === 'claude' || backend === 'codex'
      ? new RunnerBackedMemoryExtractor(backend)
      : new MemoryLlmExtractor();
  if (!extractor.isEnabled()) {
    throw new Error(
      'Memory LLM extraction is disabled. Set MEMORY_LLM_EXTRACTION_ENABLED=true and at least one per-type flag.'
    );
  }

  const supabase = createSupabaseClient();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify({
      type: 'config',
      userId,
      topic: topic || null,
      limit,
      offset,
      dryRun,
      force,
      backend,
      enabledKinds: extractor.getEnabledKinds(),
      startedAt: new Date().toISOString(),
    })}\n`
  );

  console.log(`[memory-llm-extract] auditOutput=${outputPath}`);

  let query = supabase
    .from('memories')
    .select('id,user_id,content,summary,topic_key,topics,source,salience,metadata')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (topic?.trim()) {
    query = query.contains('topics', [topic.trim()]);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load memories: ${error.message}`);

  const rows = (data || []) as Pick<
    MemoryRow,
    | 'id'
    | 'user_id'
    | 'content'
    | 'summary'
    | 'topic_key'
    | 'topics'
    | 'source'
    | 'salience'
    | 'metadata'
  >[];

  let extracted = 0;
  let skipped = 0;

  for (const row of rows) {
    const metadata = (row.metadata as Record<string, unknown> | null) || {};
    if (!force && metadata.llm_extractions) {
      skipped += 1;
      continue;
    }

    const llmExtractions = await extractor.extract({
      summary: row.summary,
      content: row.content,
      topicKey: row.topic_key,
      topics: row.topics,
      source: row.source,
      salience: row.salience,
    });

    if (!llmExtractions) {
      skipped += 1;
      continue;
    }

    if (!dryRun) {
      const { error: updateError } = await supabase
        .from('memories')
        .update({
          metadata: {
            ...metadata,
            llm_extractions: llmExtractions,
          } as Database['public']['Tables']['memories']['Update']['metadata'],
        })
        .eq('id', row.id)
        .eq('user_id', row.user_id);

      if (updateError) {
        throw new Error(`Failed to update memory ${row.id}: ${updateError.message}`);
      }
    }

    extracted += 1;
    await appendFile(
      outputPath,
      `${JSON.stringify({
        type: 'extraction',
        memoryId: row.id,
        topicKey: row.topic_key,
        topics: row.topics,
        source: row.source,
        salience: row.salience,
        summary: row.summary,
        contentLength: row.content.length,
        extractedKinds: extractor.getEnabledKinds(),
        llmExtractions,
        embeddingTexts: buildExtractionEmbeddingTexts(llmExtractions),
        dryRun,
        extractedAt: new Date().toISOString(),
      })}\n`
    );
    console.log(
      `[memory-llm-extract] ${dryRun ? 'dry-run ' : ''}extracted memory=${row.id} backend=${backend} kinds=${extractor.getEnabledKinds().join(',')}`
    );
  }

  await appendFile(
    outputPath,
    `${JSON.stringify({
      type: 'summary',
      loaded: rows.length,
      extracted,
      skipped,
      dryRun,
      backend,
      completedAt: new Date().toISOString(),
    })}\n`
  );

  console.log(
    `[memory-llm-extract] complete loaded=${rows.length} extracted=${extracted} skipped=${skipped} dryRun=${dryRun} backend=${backend} auditOutput=${outputPath}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
