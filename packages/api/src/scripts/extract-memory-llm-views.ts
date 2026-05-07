import { createSupabaseClient } from '../data/supabase/client';
import type { Database } from '../data/supabase/types';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  buildBatchExtractionPrompt,
  buildExtractionPrompt,
  buildCurrentStateEmbeddingTexts,
  buildDurableFactEmbeddingTexts,
  buildEntityEmbeddingTexts,
  buildSummaryEmbeddingTexts,
  MemoryLlmExtractor,
  normalizeMemoryExtractions,
  MEMORY_EXTRACTION_VERSION,
  batchMemoryExtractionResponseSchema,
  coerceExtractionPayload,
  type ExtractionKind,
  type BatchMemoryExtractionSource,
  type MemoryExtractionSource,
  type MemoryExtractions,
} from '../services/memory-llm-extraction';
import { ClaudeRunner, CodexRunner } from '../services/sessions';
import type { ClaudeRunnerConfig, IRunner } from '../services/sessions/types';
import { env } from '../config/env';

type MemoryRow = Database['public']['Tables']['memories']['Row'];
type ExtractableMemoryRow = Pick<
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
>;

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function parsePositiveInt(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultValue;
}

function parseNonNegativeInt(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : defaultValue;
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

function hasAllEnabledKinds(
  existing: MemoryExtractions | null,
  enabledKinds: ExtractionKind[],
  options: { requireRaw?: boolean } = {}
): boolean {
  if (!existing) return false;
  return enabledKinds.every(
    (kind) => Boolean(existing[kind]) && (!options.requireRaw || existing.raw?.[kind] !== undefined)
  );
}

function mergeMemoryExtractions(
  existing: MemoryExtractions | null,
  next: MemoryExtractions
): MemoryExtractions {
  const raw =
    existing?.raw || next.raw
      ? {
          ...(existing?.raw || {}),
          ...(next.raw || {}),
        }
      : undefined;
  return normalizeMemoryExtractions({
    ...(existing || {}),
    ...next,
    entity: next.entity ?? existing?.entity,
    durable_fact: next.durable_fact ?? existing?.durable_fact,
    summary: next.summary ?? existing?.summary,
    current_state: next.current_state ?? existing?.current_state,
    version: next.version,
    provider: next.provider,
    model: next.model,
    extractedAt: next.extractedAt,
    raw,
  }) as MemoryExtractions;
}

function buildMemoryQuery(
  supabase: ReturnType<typeof createSupabaseClient>,
  params: {
    userId: string;
    topic?: string;
    memoryId?: string;
  }
) {
  let query = supabase
    .from('memories')
    .select('id,user_id,content,summary,topic_key,topics,source,salience,metadata')
    .eq('user_id', params.userId)
    .order('created_at', { ascending: true });

  if (params.topic?.trim()) {
    query = query.contains('topics', [params.topic.trim()]);
  }

  if (params.memoryId?.trim()) {
    query = query.eq('id', params.memoryId.trim());
  }

  return query;
}

async function countMatchingMemories(
  supabase: ReturnType<typeof createSupabaseClient>,
  params: {
    userId: string;
    topic?: string;
    memoryId?: string;
  }
): Promise<number | null> {
  let query = supabase
    .from('memories')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', params.userId);

  if (params.topic?.trim()) {
    query = query.contains('topics', [params.topic.trim()]);
  }

  if (params.memoryId?.trim()) {
    query = query.eq('id', params.memoryId.trim());
  }

  const { count, error } = await query;
  if (error) {
    console.warn(`[memory-llm-extract] failed to count matching memories: ${error.message}`);
    return null;
  }

  return count ?? 0;
}

async function loadMemoryPage(
  supabase: ReturnType<typeof createSupabaseClient>,
  params: {
    userId: string;
    topic?: string;
    memoryId?: string;
    offset: number;
    limit: number;
  }
): Promise<ExtractableMemoryRow[]> {
  const { data, error } = await buildMemoryQuery(supabase, params).range(
    params.offset,
    params.offset + params.limit - 1
  );
  if (error) throw new Error(`Failed to load memories: ${error.message}`);
  return (data || []) as ExtractableMemoryRow[];
}

type ExtractionStatus = 'extracted' | 'skip-existing' | 'skip-no-output';

interface BatchItem {
  row: ExtractableMemoryRow;
  index: number;
  metadata: Record<string, unknown>;
  existingExtractions: MemoryExtractions | null;
}

interface BatchResultStatus {
  index: number;
  rowId: string;
  status: ExtractionStatus;
}

function rowToExtractionSource(row: ExtractableMemoryRow): MemoryExtractionSource {
  return {
    summary: sanitizeSyntheticBenchmarkSummary(row.summary),
    content: row.content,
    topicKey: row.topic_key,
    topics: row.topics,
    source: row.source,
    salience: row.salience,
  };
}

function sanitizeSyntheticBenchmarkSummary(summary: string | null): string | null {
  if (!summary) return summary;
  return /^benchmark\s+(target|distractor)\b/i.test(summary.trim()) ? null : summary;
}

function estimateBatchChars(row: ExtractableMemoryRow): number {
  return (
    Math.min(row.content.length, env.MEMORY_LLM_MAX_INPUT_CHARS) +
    Math.min(row.summary?.length || 0, 2000) +
    JSON.stringify(row.topics || []).length +
    (row.topic_key?.length || 0) +
    (row.source?.length || 0) +
    400
  );
}

function isTransientPersistenceError(error: { message?: string; code?: string } | null): boolean {
  const message = error?.message?.toLowerCase() || '';
  const code = error?.code?.toLowerCase() || '';
  return (
    code === '57014' ||
    message.includes('upstream') ||
    message.includes('timeout') ||
    message.includes('temporarily') ||
    message.includes('connection') ||
    message.includes('econnreset') ||
    message.includes('fetch failed')
  );
}

async function persistMemoryMetadataWithRetry(params: {
  supabase: ReturnType<typeof createSupabaseClient>;
  row: ExtractableMemoryRow;
  metadata: Record<string, unknown>;
  maxAttempts?: number;
}) {
  const { supabase, row, metadata, maxAttempts = 4 } = params;
  let lastError: { message: string; code?: string } | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { error } = await supabase
      .from('memories')
      .update({
        metadata: metadata as Database['public']['Tables']['memories']['Update']['metadata'],
      })
      .eq('id', row.id)
      .eq('user_id', row.user_id);

    if (!error) {
      if (attempt > 1) {
        console.log(
          `[memory-llm-extract] memory metadata update succeeded after retry memory=${row.id} attempt=${attempt}`
        );
      }
      return;
    }

    lastError = { message: error.message, code: error.code };
    if (attempt >= maxAttempts || !isTransientPersistenceError(lastError)) {
      break;
    }

    const delayMs = 500 * 2 ** (attempt - 1);
    console.warn(
      `[memory-llm-extract] transient memory metadata update failed memory=${row.id} attempt=${attempt}/${maxAttempts} retryInMs=${delayMs}: ${error.message}`
    );
    await sleep(delayMs);
  }

  throw new Error(
    `Failed to update memory ${row.id}: ${lastError?.message || 'unknown persistence error'}`
  );
}

async function writeExtractionResult(params: {
  row: ExtractableMemoryRow;
  metadata: Record<string, unknown>;
  existingExtractions: MemoryExtractions | null;
  llmExtractions: MemoryExtractions;
  dryRun: boolean;
  outputPath: string;
  supabase: ReturnType<typeof createSupabaseClient>;
  extractedKinds: ExtractionKind[];
}) {
  const {
    row,
    metadata,
    existingExtractions,
    llmExtractions,
    dryRun,
    outputPath,
    supabase,
    extractedKinds,
  } = params;
  const mergedExtractions = mergeMemoryExtractions(existingExtractions, llmExtractions);

  if (!dryRun) {
    await persistMemoryMetadataWithRetry({
      supabase,
      row,
      metadata: {
        ...metadata,
        llm_extractions: mergedExtractions,
      },
    });
  }

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
      extractedKinds,
      llmExtractions: mergedExtractions,
      embeddingTexts: buildExtractionEmbeddingTexts(mergedExtractions),
      dryRun,
      extractedAt: new Date().toISOString(),
    })}\n`
  );
}

async function processMemoryRow(params: {
  row: ExtractableMemoryRow;
  index: number;
  total: number;
  backend: string;
  dryRun: boolean;
  force: boolean;
  requireRaw: boolean;
  extractor: RunnerBackedMemoryExtractor | MemoryLlmExtractor;
  outputPath: string;
  supabase: ReturnType<typeof createSupabaseClient>;
}): Promise<'extracted' | 'skip-existing' | 'skip-no-output'> {
  const { row, index, total, backend, dryRun, force, requireRaw, extractor, outputPath, supabase } =
    params;
  const metadata = (row.metadata as Record<string, unknown> | null) || {};
  const existingExtractions = normalizeMemoryExtractions(metadata.llm_extractions);
  if (
    !force &&
    hasAllEnabledKinds(existingExtractions, extractor.getEnabledKinds(), { requireRaw })
  ) {
    console.log(
      `[memory-llm-extract] progress processed=${index}/${total} backend=${backend} memory=${row.id} status=skip-existing`
    );
    return 'skip-existing';
  }

  const llmExtractions = await extractor.extract({
    ...rowToExtractionSource(row),
  });

  if (!llmExtractions) {
    console.log(
      `[memory-llm-extract] progress processed=${index}/${total} backend=${backend} memory=${row.id} status=skip-no-output`
    );
    return 'skip-no-output';
  }

  await writeExtractionResult({
    row,
    metadata,
    existingExtractions,
    llmExtractions,
    dryRun,
    outputPath,
    supabase,
    extractedKinds: extractor.getEnabledKinds(),
  });
  console.log(
    `[memory-llm-extract] progress processed=${index}/${total} backend=${backend} memory=${row.id} status=${dryRun ? 'dry-run-extract' : 'extracted'} kinds=${extractor.getEnabledKinds().join(',')}`
  );
  return 'extracted';
}

async function processMemoryBatch(params: {
  items: BatchItem[];
  total: number;
  backend: string;
  dryRun: boolean;
  extractor: RunnerBackedMemoryExtractor;
  outputPath: string;
  supabase: ReturnType<typeof createSupabaseClient>;
}): Promise<BatchResultStatus[]> {
  const { items, total, backend, dryRun, extractor, outputPath, supabase } = params;
  if (items.length === 0) return [];
  const batchChars = items.reduce((sum, item) => sum + estimateBatchChars(item.row), 0);
  console.log(
    `[memory-llm-extract] batch start size=${items.length} indexRange=${items[0]?.index}-${items[items.length - 1]?.index} approxChars=${batchChars} backend=${backend} kinds=${extractor.getEnabledKinds().join(',')}`
  );

  const extractionByMemoryId = await extractor.extractBatch(
    items.map((item) => ({
      memoryId: item.row.id,
      source: rowToExtractionSource(item.row),
    }))
  );
  const statuses: BatchResultStatus[] = [];

  for (const item of items) {
    const llmExtractions = extractionByMemoryId.get(item.row.id);
    if (!llmExtractions) {
      console.log(
        `[memory-llm-extract] progress processed=${item.index}/${total} backend=${backend} memory=${item.row.id} status=skip-no-output batch=true`
      );
      statuses.push({ index: item.index, rowId: item.row.id, status: 'skip-no-output' });
      continue;
    }

    await writeExtractionResult({
      row: item.row,
      metadata: item.metadata,
      existingExtractions: item.existingExtractions,
      llmExtractions,
      dryRun,
      outputPath,
      supabase,
      extractedKinds: extractor.getEnabledKinds(),
    });
    console.log(
      `[memory-llm-extract] progress processed=${item.index}/${total} backend=${backend} memory=${item.row.id} status=${dryRun ? 'dry-run-extract' : 'extracted'} kinds=${extractor.getEnabledKinds().join(',')} batch=true`
    );
    statuses.push({ index: item.index, rowId: item.row.id, status: 'extracted' });
  }

  console.log(
    `[memory-llm-extract] batch complete size=${items.length} extracted=${statuses.filter((status) => status.status === 'extracted').length} skipped=${statuses.filter((status) => status.status !== 'extracted').length} backend=${backend}`
  );
  return statuses;
}

function getEnabledKinds(options: { batchAllKinds?: boolean } = {}): ExtractionKind[] {
  if (options.batchAllKinds) return ['entity', 'durable_fact', 'summary'];
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
  const fencedJson = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedJson?.[1]?.trim()) return extractJsonObject(fencedJson[1]);
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('runner extraction response did not contain a JSON object');
  }
  return trimmed.slice(firstBrace, lastBrace + 1);
}

function compactLogSnippet(text: string, maxChars = 500): string {
  const compacted = text.replace(/\s+/g, ' ').trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function parseKindPayload(kind: ExtractionKind, raw: unknown): MemoryExtractions[ExtractionKind] {
  return coerceExtractionPayload(kind, raw);
}

function assignExtractionPayload(
  payload: Partial<MemoryExtractions>,
  kind: ExtractionKind,
  result: MemoryExtractions[ExtractionKind]
) {
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

function assignRawExtractionPayload(
  payload: Partial<MemoryExtractions>,
  kind: ExtractionKind,
  raw: unknown
) {
  payload.raw = {
    ...(payload.raw || {}),
    [kind]: raw,
  };
}

interface RunnerExtractionResult {
  normalized: MemoryExtractions[ExtractionKind];
  raw: unknown;
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
  private readonly enabledKinds: ExtractionKind[];
  private readonly runner: IRunner;
  private readonly backend: 'claude' | 'codex';
  private readonly config: ClaudeRunnerConfig;

  constructor(backend: 'claude' | 'codex', enabledKinds: ExtractionKind[] = getEnabledKinds()) {
    this.backend = backend;
    this.enabledKinds = enabledKinds;
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
    const extractedAt = new Date().toISOString();
    const payload: Partial<MemoryExtractions> = {
      version: MEMORY_EXTRACTION_VERSION,
      provider: `runner:${this.backend}`,
      model: env.MEMORY_LLM_MODEL || this.backend,
      extractedAt,
      raw: {
        provider: `runner:${this.backend}`,
        model: env.MEMORY_LLM_MODEL || this.backend,
        extractedAt,
      },
    };

    for (const kind of this.enabledKinds) {
      const result = await this.extractKind(kind, sanitizedSource);
      if (!result) continue;
      assignExtractionPayload(payload, kind, result.normalized);
      assignRawExtractionPayload(payload, kind, result.raw);
    }

    const normalized = normalizeMemoryExtractions(payload);
    return normalized &&
      Object.keys(normalized).some((key) =>
        ['entity', 'durable_fact', 'summary', 'current_state'].includes(key)
      )
      ? normalized
      : null;
  }

  async extractBatch(
    items: BatchMemoryExtractionSource[]
  ): Promise<Map<string, MemoryExtractions>> {
    if (!this.isEnabled() || items.length === 0) return new Map();
    if (items.length === 1) {
      const extraction = await this.extract(items[0].source);
      return extraction ? new Map([[items[0].memoryId, extraction]]) : new Map();
    }

    const sanitizedItems = items.map((item) => ({
      memoryId: item.memoryId,
      source: sanitizeSourceForRunner(item.source),
    }));
    const parsed = await this.extractBatchOnce(sanitizedItems);
    if (!parsed) {
      const midpoint = Math.ceil(items.length / 2);
      console.warn(
        `[memory-llm-extract] runner backend=${this.backend} batch parse failed; splitting size=${items.length} into ${midpoint}+${items.length - midpoint}`
      );
      const [left, right] = await Promise.all([
        this.extractBatch(items.slice(0, midpoint)),
        this.extractBatch(items.slice(midpoint)),
      ]);
      return new Map([...left, ...right]);
    }

    const output = new Map(parsed.extractions);
    const retryIds = new Set([...parsed.invalidMemoryIds, ...parsed.missingMemoryIds]);
    if (retryIds.size > 0) {
      console.warn(
        `[memory-llm-extract] runner backend=${this.backend} batch partial failure; retrying individually count=${retryIds.size}`
      );
    }

    for (const item of items) {
      if (!retryIds.has(item.memoryId)) continue;
      const extraction = await this.extract(item.source);
      if (extraction) output.set(item.memoryId, extraction);
    }

    return output;
  }

  private async extractKind(
    kind: ExtractionKind,
    source: MemoryExtractionSource
  ): Promise<RunnerExtractionResult | null> {
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
      const retryAtMatch = result.error?.match(/try again at ([^.]+)\./i);
      console.warn(
        `[memory-llm-extract] runner backend=${this.backend} kind=${kind} failed: ${result.error || 'unknown error'}`
      );
      if (
        result.error?.includes("You've hit your usage limit") ||
        result.error?.toLowerCase().includes('usage limit')
      ) {
        console.warn(
          `[memory-llm-extract] runner backend=${this.backend} appears rate-limited${
            retryAtMatch?.[1] ? ` until ${retryAtMatch[1]}` : ''
          }`
        );
      }
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
      const parsedJson = JSON.parse(extractJsonObject(content));
      return {
        normalized: parseKindPayload(kind, parsedJson),
        raw: parsedJson,
      };
    } catch (error) {
      console.warn(
        `[memory-llm-extract] runner backend=${this.backend} kind=${kind} returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }; contentSnippet=${JSON.stringify(compactLogSnippet(content))}`
      );
      return null;
    }
  }

  private async extractBatchOnce(items: BatchMemoryExtractionSource[]): Promise<{
    extractions: Map<string, MemoryExtractions>;
    invalidMemoryIds: Set<string>;
    missingMemoryIds: Set<string>;
  } | null> {
    const prompt = buildBatchExtractionPrompt(items, this.enabledKinds);
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
      const retryAtMatch = result.error?.match(/try again at ([^.]+)\./i);
      console.warn(
        `[memory-llm-extract] runner backend=${this.backend} batch failed: ${result.error || 'unknown error'}`
      );
      if (
        result.error?.includes("You've hit your usage limit") ||
        result.error?.toLowerCase().includes('usage limit')
      ) {
        console.warn(
          `[memory-llm-extract] runner backend=${this.backend} appears rate-limited${
            retryAtMatch?.[1] ? ` until ${retryAtMatch[1]}` : ''
          }`
        );
      }
      return null;
    }

    const content =
      result.finalTextResponse ||
      result.responses
        .map((response) => response.content)
        .filter(Boolean)
        .join('\n');
    if (!content.trim()) {
      console.warn(`[memory-llm-extract] runner backend=${this.backend} batch returned no text`);
      return null;
    }

    try {
      const parsed = batchMemoryExtractionResponseSchema.parse(
        JSON.parse(extractJsonObject(content))
      );
      const requestedMemoryIds = new Set(items.map((item) => item.memoryId));
      const seenMemoryIds = new Set<string>();
      const invalidMemoryIds = new Set<string>();
      const extractions = new Map<string, MemoryExtractions>();

      for (const resultItem of parsed.results) {
        if (!requestedMemoryIds.has(resultItem.memoryId)) {
          console.warn(
            `[memory-llm-extract] runner backend=${this.backend} batch returned unknown memoryId=${resultItem.memoryId}`
          );
          continue;
        }
        seenMemoryIds.add(resultItem.memoryId);

        const extractedAt = new Date().toISOString();
        const payload: Partial<MemoryExtractions> = {
          version: MEMORY_EXTRACTION_VERSION,
          provider: `runner:${this.backend}:batch`,
          model: env.MEMORY_LLM_MODEL || this.backend,
          extractedAt,
          raw: {
            provider: `runner:${this.backend}:batch`,
            model: env.MEMORY_LLM_MODEL || this.backend,
            extractedAt,
          },
        };
        let invalid = false;
        for (const kind of this.enabledKinds) {
          const rawKindPayload = resultItem[kind];
          if (rawKindPayload === undefined) {
            invalid = true;
            console.warn(
              `[memory-llm-extract] runner backend=${this.backend} batch memory=${resultItem.memoryId} missing kind=${kind}`
            );
            break;
          }
          try {
            assignExtractionPayload(payload, kind, parseKindPayload(kind, rawKindPayload));
            assignRawExtractionPayload(payload, kind, rawKindPayload);
          } catch (error) {
            invalid = true;
            console.warn(
              `[memory-llm-extract] runner backend=${this.backend} batch memory=${resultItem.memoryId} invalid kind=${kind}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
            break;
          }
        }

        const normalized = normalizeMemoryExtractions(payload);
        if (
          invalid ||
          !normalized ||
          !Object.keys(normalized).some((key) =>
            ['entity', 'durable_fact', 'summary', 'current_state'].includes(key)
          )
        ) {
          invalidMemoryIds.add(resultItem.memoryId);
          continue;
        }
        extractions.set(resultItem.memoryId, normalized);
      }

      const missingMemoryIds = new Set(
        items.map((item) => item.memoryId).filter((memoryId) => !seenMemoryIds.has(memoryId))
      );
      return { extractions, invalidMemoryIds, missingMemoryIds };
    } catch (error) {
      console.warn(
        `[memory-llm-extract] runner backend=${this.backend} batch returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }; contentSnippet=${JSON.stringify(compactLogSnippet(content))}`
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
  const offset = parseNonNegativeInt(process.env.MEMORY_LLM_EXTRACT_OFFSET, 0);
  const pageSize = Math.min(parsePositiveInt(process.env.MEMORY_LLM_EXTRACT_PAGE_SIZE, 1000), 1000);
  const batchAllKinds = parseBoolean(process.env.MEMORY_LLM_EXTRACT_BATCH_ALL_KINDS, false);
  const batchSize = Math.min(parsePositiveInt(process.env.MEMORY_LLM_EXTRACT_BATCH_SIZE, 1), 50);
  const batchMaxChars = parsePositiveInt(process.env.MEMORY_LLM_EXTRACT_BATCH_MAX_CHARS, 60_000);
  const maxConsecutiveFailures = parsePositiveInt(
    process.env.MEMORY_LLM_EXTRACT_MAX_CONSECUTIVE_FAILURES,
    10
  );
  const topic = process.env.MEMORY_LLM_EXTRACT_TOPIC;
  const memoryId = process.env.MEMORY_LLM_EXTRACT_MEMORY_ID;
  const dryRun = parseBoolean(process.env.MEMORY_LLM_EXTRACT_DRY_RUN, false);
  const force = parseBoolean(process.env.MEMORY_LLM_EXTRACT_FORCE, false);
  const requireRaw = parseBoolean(process.env.MEMORY_LLM_EXTRACT_REQUIRE_RAW, true);
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
  const enabledKinds = getEnabledKinds({ batchAllKinds });
  const extractor =
    backend === 'claude' || backend === 'codex'
      ? new RunnerBackedMemoryExtractor(backend, enabledKinds)
      : new MemoryLlmExtractor();
  const batchExtractor = extractor instanceof RunnerBackedMemoryExtractor ? extractor : null;
  const useBatchExtraction = Boolean(batchExtractor && batchSize > 1);
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
      memoryId: memoryId || null,
      topic: topic || null,
      limit,
      offset,
      pageSize,
      batchAllKinds,
      batchSize,
      batchMaxChars,
      useBatchExtraction,
      maxConsecutiveFailures,
      dryRun,
      force,
      requireRaw,
      backend,
      enabledKinds: extractor.getEnabledKinds(),
      startedAt: new Date().toISOString(),
    })}\n`
  );

  console.log(`[memory-llm-extract] auditOutput=${outputPath}`);

  let extracted = 0;
  let skipped = 0;
  let processed = 0;
  let loaded = 0;
  let consecutiveNoOutput = 0;
  const matchingCount = await countMatchingMemories(supabase, {
    userId,
    topic,
    memoryId,
  });
  const plannedTotal =
    matchingCount === null ? limit : Math.min(limit, Math.max(0, matchingCount - offset));
  console.log(
    `[memory-llm-extract] starting total=${plannedTotal} offset=${offset} limit=${limit} pageSize=${pageSize} batchSize=${useBatchExtraction ? batchSize : 1} batchMaxChars=${useBatchExtraction ? batchMaxChars : 0} extracted=${extracted} skipped=${skipped} backend=${backend} kinds=${extractor.getEnabledKinds().join(',')}`
  );

  const recordStatus = (status: ExtractionStatus, index: number) => {
    if (status === 'extracted') {
      extracted += 1;
      consecutiveNoOutput = 0;
    } else if (status === 'skip-existing') {
      skipped += 1;
    } else {
      skipped += 1;
      consecutiveNoOutput += 1;
    }
    console.log(
      `[memory-llm-extract] counts processed=${index}/${plannedTotal} loaded=${loaded} extracted=${extracted} skipped=${skipped} consecutiveNoOutput=${consecutiveNoOutput} backend=${backend}`
    );
    if (consecutiveNoOutput >= maxConsecutiveFailures) {
      console.warn(
        `[memory-llm-extract] stopping early after ${consecutiveNoOutput} consecutive no-output rows; maxConsecutiveFailures=${maxConsecutiveFailures}`
      );
      return true;
    }
    return false;
  };

  while (processed < limit) {
    const remaining = limit - processed;
    const rows = await loadMemoryPage(supabase, {
      userId,
      topic,
      memoryId,
      offset: offset + processed,
      limit: Math.min(pageSize, remaining),
    });
    loaded += rows.length;
    if (rows.length === 0) break;

    console.log(
      `[memory-llm-extract] page loaded=${rows.length} pageStart=${offset + processed} processed=${processed}/${plannedTotal} extracted=${extracted} skipped=${skipped}`
    );

    if (useBatchExtraction) {
      let batch: BatchItem[] = [];
      let batchChars = 0;
      let shouldStop = false;

      const flushBatch = async () => {
        if (batch.length === 0) return;
        const statuses = await processMemoryBatch({
          items: batch,
          total: plannedTotal,
          backend,
          dryRun,
          extractor: batchExtractor!,
          outputPath,
          supabase,
        });
        batch = [];
        batchChars = 0;
        for (const status of statuses) {
          if (recordStatus(status.status, status.index)) {
            shouldStop = true;
            break;
          }
        }
      };

      for (const row of rows) {
        processed += 1;
        const metadata = (row.metadata as Record<string, unknown> | null) || {};
        const existingExtractions = normalizeMemoryExtractions(metadata.llm_extractions);
        if (
          !force &&
          hasAllEnabledKinds(existingExtractions, extractor.getEnabledKinds(), { requireRaw })
        ) {
          console.log(
            `[memory-llm-extract] progress processed=${processed}/${plannedTotal} backend=${backend} memory=${row.id} status=skip-existing`
          );
          shouldStop = recordStatus('skip-existing', processed);
          if (shouldStop) break;
          continue;
        }

        const rowChars = estimateBatchChars(row);
        if (
          batch.length > 0 &&
          (batch.length >= batchSize || batchChars + rowChars > batchMaxChars)
        ) {
          await flushBatch();
          if (shouldStop) break;
        }
        batch.push({ row, index: processed, metadata, existingExtractions });
        batchChars += rowChars;
        if (batch.length >= batchSize || batchChars >= batchMaxChars) {
          await flushBatch();
          if (shouldStop) break;
        }
      }
      await flushBatch();
      if (shouldStop) {
        processed = limit;
        break;
      }
    } else {
      for (const row of rows) {
        processed += 1;
        const result = await processMemoryRow({
          row,
          index: processed,
          total: plannedTotal,
          backend,
          dryRun,
          force,
          requireRaw,
          extractor,
          outputPath,
          supabase,
        });
        if (recordStatus(result, processed)) {
          processed = limit;
          break;
        }
      }
    }

    if (rows.length < Math.min(pageSize, remaining)) break;
  }

  await appendFile(
    outputPath,
    `${JSON.stringify({
      type: 'summary',
      loaded,
      processed,
      total: plannedTotal,
      extracted,
      skipped,
      dryRun,
      backend,
      batchAllKinds,
      batchSize: useBatchExtraction ? batchSize : 1,
      batchMaxChars: useBatchExtraction ? batchMaxChars : null,
      requireRaw,
      completedAt: new Date().toISOString(),
    })}\n`
  );

  console.log(
    `[memory-llm-extract] complete loaded=${loaded} processed=${processed}/${plannedTotal} extracted=${extracted} skipped=${skipped} dryRun=${dryRun} backend=${backend} auditOutput=${outputPath}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
