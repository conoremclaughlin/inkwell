import { env } from '../config/env';
import { logger } from '../utils/logger';
import { z } from 'zod';

export const MEMORY_EXTRACTION_VERSION = 1;

export const entityExtractionItemSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).max(6).default([]),
  entityType: z.enum([
    'person',
    'org',
    'project',
    'product',
    'place',
    'policy',
    'service',
    'file',
    'other',
  ]),
  description: z.string().min(1),
  evidence: z.string().min(1),
});

export const durableFactExtractionItemSchema = z.object({
  fact: z.string().min(1),
  category: z.enum([
    'identity',
    'preference',
    'decision',
    'constraint',
    'process',
    'status',
    'ownership',
    'relationship',
    'other',
  ]),
  subject: z.string().optional(),
  object: z.string().optional(),
  evidence: z.string().min(1),
});

export const summaryExtractionSchema = z.object({
  summary: z.string().min(1),
  keyPoints: z.array(z.string().min(1)).max(6).default([]),
  actionRelevance: z.string().min(1),
});

export const currentStateExtractionSchema = z.object({
  state: z.string().min(1),
  scope: z.string().min(1),
  status: z.string().min(1),
  volatility: z.enum(['volatile', 'semi-stable', 'stable']),
  evidence: z.string().min(1),
});

export const entityExtractionSchema = z.object({
  entities: z.array(entityExtractionItemSchema).max(8),
});

export const durableFactExtractionSchema = z.object({
  durableFacts: z.array(durableFactExtractionItemSchema).max(10),
});

export const memoryExtractionsSchema = z.object({
  version: z.number().int().default(MEMORY_EXTRACTION_VERSION),
  provider: z.string().min(1),
  model: z.string().min(1),
  extractedAt: z.string().min(1),
  entity: entityExtractionSchema.optional(),
  durable_fact: durableFactExtractionSchema.optional(),
  summary: summaryExtractionSchema.optional(),
  current_state: currentStateExtractionSchema.optional(),
  raw: z
    .object({
      provider: z.string().optional(),
      model: z.string().optional(),
      extractedAt: z.string().optional(),
      entity: z.unknown().optional(),
      durable_fact: z.unknown().optional(),
      summary: z.unknown().optional(),
      current_state: z.unknown().optional(),
    })
    .passthrough()
    .optional(),
});

export type MemoryExtractions = z.infer<typeof memoryExtractionsSchema>;

export const batchMemoryExtractionResultSchema = z
  .object({
    memoryId: z.string().min(1),
  })
  .passthrough();

export const batchMemoryExtractionResponseSchema = z.object({
  results: z.array(batchMemoryExtractionResultSchema),
});

export interface MemoryExtractionSource {
  summary?: string | null;
  content: string;
  topicKey?: string | null;
  topics?: string[] | null;
  source?: string | null;
  salience?: string | null;
}

export type ExtractionKind = 'entity' | 'durable_fact' | 'summary' | 'current_state';

export interface BatchMemoryExtractionSource {
  memoryId: string;
  source: MemoryExtractionSource;
}

export interface ExtractionPromptBundle {
  kind: ExtractionKind;
  systemPrompt: string;
  userPrompt: string;
  schemaDescription: string;
}

export interface ExtractionRuntimeConfig {
  enabled: boolean;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  maxInputChars: number;
  enabledKinds: ExtractionKind[];
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';
export const DEFAULT_MEMORY_LLM_MODEL = 'gpt-4.1-mini';

function buildSourceBlock(source: MemoryExtractionSource): string {
  const parts: string[] = [];
  if (source.summary?.trim()) parts.push(`Summary:\n${source.summary.trim()}`);
  if (source.topicKey?.trim()) parts.push(`Topic key: ${source.topicKey.trim()}`);
  const topics = (source.topics || []).map((t) => t.trim()).filter(Boolean);
  if (topics.length > 0) parts.push(`Topics: ${topics.join(', ')}`);
  if (source.source?.trim()) parts.push(`Source: ${source.source.trim()}`);
  if (source.salience?.trim()) parts.push(`Salience: ${source.salience.trim()}`);
  parts.push(`Memory text:\n${source.content.trim()}`);
  return parts.join('\n\n');
}

function clampSourceText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function quote(text: string, maxChars = 220): string {
  const normalized = compactWhitespace(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

export function buildEntityExtractionPrompt(
  source: MemoryExtractionSource
): ExtractionPromptBundle {
  return {
    kind: 'entity',
    systemPrompt:
      'You extract explicit entity memory from a single memory record. Return strict JSON only. Do not speculate. Only extract entities clearly supported by the text. Prefer entities that help answer future who/what questions. Each entity must include a short grounded description and a direct evidence quote.',
    schemaDescription:
      'JSON schema: {"entities": [{"name": string, "aliases": string[], "entityType": "person"|"org"|"project"|"product"|"place"|"policy"|"service"|"file"|"other", "description": string, "evidence": string}]}',
    userPrompt: [
      'Extraction type: entity',
      'Task:',
      '- Extract the main people, orgs, projects, products, places, policies, services, or files explicitly mentioned.',
      '- Include aliases only if the text supports them.',
      '- Ignore generic nouns that are not useful routing anchors.',
      '- Return at most 8 entities.',
      '',
      buildSourceBlock(source),
    ].join('\n'),
  };
}

export function buildDurableFactExtractionPrompt(
  source: MemoryExtractionSource
): ExtractionPromptBundle {
  return {
    kind: 'durable_fact',
    systemPrompt:
      'You extract durable facts from a single memory record. Return strict JSON only. Durable facts are long-lived facts, decisions, constraints, process rules, status conditions, ownership facts, relationship facts, or preferences likely to matter later. Do not include fleeting chatter. Do not speculate. Every fact must quote evidence from the memory.',
    schemaDescription:
      'JSON schema: {"durableFacts": [{"fact": string, "category": "identity"|"preference"|"decision"|"constraint"|"process"|"status"|"ownership"|"relationship"|"other", "subject"?: string, "object"?: string, "evidence": string}]}',
    userPrompt: [
      'Extraction type: durable_fact',
      'Task:',
      '- Extract stable, decision-relevant facts from the memory.',
      '- Prefer facts that would help answer who / what / why / constraint / process / status questions later.',
      '- Use the most specific category available, including decision and process when applicable.',
      '- Return at most 10 durable facts.',
      '',
      buildSourceBlock(source),
    ].join('\n'),
  };
}

export function buildSummaryExtractionPrompt(
  source: MemoryExtractionSource
): ExtractionPromptBundle {
  return {
    kind: 'summary',
    systemPrompt:
      'You write a compact retrieval-oriented summary for a single memory record. Return strict JSON only. The summary should optimize for future decision support and actionability, not literary style. Keep it source-grounded.',
    schemaDescription:
      'JSON schema: {"summary": string, "keyPoints": string[], "actionRelevance": string}',
    userPrompt: [
      'Extraction type: summary',
      'Task:',
      '- Produce a short holistic recap of the memory.',
      '- Keep the summary focused on what happened, what matters, and why it may matter later.',
      '- keyPoints should capture the most important supporting points.',
      '- actionRelevance should state how this memory could help a future decision or action.',
      '',
      buildSourceBlock(source),
    ].join('\n'),
  };
}

export function buildCurrentStateExtractionPrompt(
  source: MemoryExtractionSource
): ExtractionPromptBundle {
  return {
    kind: 'current_state',
    systemPrompt:
      'You extract current-state memory from a single memory record. Return strict JSON only. Current state is volatile operational status that may change soon, such as server state, active branch state, current blocker, or live workflow status. Do not convert stable historical facts into current state. Include volatility and direct evidence.',
    schemaDescription:
      'JSON schema: {"state": string, "scope": string, "status": string, "volatility": "volatile"|"semi-stable"|"stable", "evidence": string}',
    userPrompt: [
      'Extraction type: current_state',
      'Task:',
      '- Extract only if the memory contains a present or near-present operational state.',
      '- Good examples: dev server auto-restarts, current test server port, current blocker, current rollout status.',
      '- Bad examples: old decisions or historical facts with no present-state implication.',
      '',
      buildSourceBlock(source),
    ].join('\n'),
  };
}

export function buildExtractionPrompt(
  source: MemoryExtractionSource,
  kind: ExtractionKind
): ExtractionPromptBundle {
  switch (kind) {
    case 'entity':
      return buildEntityExtractionPrompt(source);
    case 'durable_fact':
      return buildDurableFactExtractionPrompt(source);
    case 'summary':
      return buildSummaryExtractionPrompt(source);
    case 'current_state':
      return buildCurrentStateExtractionPrompt(source);
  }
}

export function buildBatchExtractionPrompt(
  items: BatchMemoryExtractionSource[],
  kinds: ExtractionKind[]
): Omit<ExtractionPromptBundle, 'kind'> {
  const uniqueKinds = [...new Set(kinds)];
  const requestedSchemas = uniqueKinds.map((kind) => {
    switch (kind) {
      case 'entity':
        return '"entity": {"entities": [{"name": string, "aliases": string[], "entityType": "person"|"org"|"project"|"product"|"place"|"policy"|"service"|"file"|"other", "description": string, "evidence": string}]}';
      case 'durable_fact':
        return '"durable_fact": {"durableFacts": [{"fact": string, "category": "identity"|"preference"|"decision"|"constraint"|"process"|"status"|"ownership"|"relationship"|"other", "subject"?: string, "object"?: string, "evidence": string}]}';
      case 'summary':
        return '"summary": {"summary": string, "keyPoints": string[], "actionRelevance": string}';
      case 'current_state':
        return '"current_state": {"state": string, "scope": string, "status": string, "volatility": "volatile"|"semi-stable"|"stable", "evidence": string}';
    }
  });

  return {
    systemPrompt:
      'You are a deterministic batched memory extraction worker. Return strict JSON only. Do not use tools. Treat each memory independently: do not synthesize across memories, do not infer from neighboring memories, and do not use benchmark labels. Each extracted item must be grounded in the memory it belongs to.',
    schemaDescription: `JSON schema: {"results": [{"memoryId": string, ${requestedSchemas.join(', ')}}]}`,
    userPrompt: [
      `Extraction types: ${uniqueKinds.join(', ')}`,
      'Task:',
      '- Return exactly one result object for each input memoryId.',
      '- Do not fill quotas. Extract only salient items likely to improve future retrieval or decision support.',
      '- For entity extraction: extract at most 8 explicit people, orgs, projects, products, places, policies, services, or files per memory; prefer 2-5 high-signal entities and use an empty entities array if none are useful.',
      '- For durable_fact extraction: extract at most 10 long-lived facts, decisions, constraints, process rules, status conditions, ownership facts, relationship facts, or preferences per memory; prefer 2-6 high-signal facts and use an empty durableFacts array if none are useful.',
      '- For summary extraction: summarize only that single source memory. Do not aggregate across the batch. Optimize for future retrieval and decision support.',
      '- For current_state extraction: include only present or near-present operational state supported by that memory.',
      '- Evidence must quote or closely paraphrase text from the same memory.',
      '',
      'Input memories JSON:',
      JSON.stringify(
        items.map(({ memoryId, source }) => ({
          memoryId,
          summary: source.summary || null,
          topicKey: source.topicKey || null,
          topics: source.topics || [],
          memorySource: source.source || null,
          salience: source.salience || null,
          content: source.content,
        })),
        null,
        2
      ),
    ].join('\n'),
  };
}

export function buildEntityEmbeddingTexts(
  payload: z.infer<typeof entityExtractionSchema>
): string[] {
  return payload.entities.map((entity) =>
    compactWhitespace(
      `entity: ${entity.name}; type: ${entity.entityType}; aliases: ${entity.aliases.join(', ') || 'none'}; description: ${entity.description}; evidence: ${quote(entity.evidence)}`
    )
  );
}

export function buildDurableFactEmbeddingTexts(
  payload: z.infer<typeof durableFactExtractionSchema>
): string[] {
  return payload.durableFacts.map((fact) =>
    compactWhitespace(
      `durable fact: ${fact.fact}; category: ${fact.category}; subject: ${fact.subject || 'unknown'}; object: ${fact.object || 'unknown'}; evidence: ${quote(fact.evidence)}`
    )
  );
}

export function buildSummaryEmbeddingTexts(
  payload: z.infer<typeof summaryExtractionSchema>
): string[] {
  return [
    compactWhitespace(
      `summary: ${payload.summary}; key points: ${payload.keyPoints.join(' | ') || 'none'}; action relevance: ${payload.actionRelevance}`
    ),
  ];
}

export function buildCurrentStateEmbeddingTexts(
  payload: z.infer<typeof currentStateExtractionSchema>
): string[] {
  return [
    compactWhitespace(
      `current state: ${payload.state}; scope: ${payload.scope}; status: ${payload.status}; volatility: ${payload.volatility}; evidence: ${quote(payload.evidence)}`
    ),
  ];
}

export function normalizeMemoryExtractions(value: unknown): MemoryExtractions | null {
  const parsed = memoryExtractionsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const ENTITY_TYPES = new Set(entityExtractionItemSchema.shape.entityType.options);
const DURABLE_FACT_CATEGORIES = new Set(durableFactExtractionItemSchema.shape.category.options);
const VOLATILITY_VALUES = new Set(currentStateExtractionSchema.shape.volatility.options);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asNonEmptyString(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems);
}

function coerceEntityExtraction(raw: unknown): z.infer<typeof entityExtractionSchema> {
  const rawEntities = asRecord(raw).entities;
  const entities = (Array.isArray(rawEntities) ? rawEntities : [])
    .map((item) => {
      const record = asRecord(item);
      const name = asNonEmptyString(record.name);
      const description = asNonEmptyString(record.description);
      const evidence = asNonEmptyString(record.evidence);
      if (!name || !description || !evidence) return null;
      const rawType = asNonEmptyString(record.entityType);
      return {
        name,
        aliases: asStringArray(record.aliases, 6),
        entityType: rawType && ENTITY_TYPES.has(rawType as never) ? rawType : 'other',
        description,
        evidence,
      };
    })
    .filter((item): item is z.infer<typeof entityExtractionItemSchema> => Boolean(item))
    .slice(0, 8);
  return entityExtractionSchema.parse({ entities });
}

function coerceDurableFactExtraction(raw: unknown): z.infer<typeof durableFactExtractionSchema> {
  const rawFacts = asRecord(raw).durableFacts;
  const durableFacts = (Array.isArray(rawFacts) ? rawFacts : [])
    .map((item) => {
      const record = asRecord(item);
      const fact = asNonEmptyString(record.fact);
      const evidence = asNonEmptyString(record.evidence);
      if (!fact || !evidence) return null;
      const rawCategory = asNonEmptyString(record.category);
      return {
        fact,
        category:
          rawCategory && DURABLE_FACT_CATEGORIES.has(rawCategory as never) ? rawCategory : 'other',
        ...(asNonEmptyString(record.subject)
          ? { subject: asNonEmptyString(record.subject) as string }
          : {}),
        ...(asNonEmptyString(record.object)
          ? { object: asNonEmptyString(record.object) as string }
          : {}),
        evidence,
      };
    })
    .filter((item): item is z.infer<typeof durableFactExtractionItemSchema> => Boolean(item))
    .slice(0, 10);
  return durableFactExtractionSchema.parse({ durableFacts });
}

function coerceSummaryExtraction(raw: unknown): z.infer<typeof summaryExtractionSchema> {
  const record = asRecord(raw);
  const summary = asNonEmptyString(record.summary) || 'No salient summary extracted.';
  const actionRelevance =
    asNonEmptyString(record.actionRelevance) || 'Useful for future retrieval and decision support.';
  return summaryExtractionSchema.parse({
    summary,
    keyPoints: asStringArray(record.keyPoints, 6),
    actionRelevance,
  });
}

function coerceCurrentStateExtraction(raw: unknown): z.infer<typeof currentStateExtractionSchema> {
  const record = asRecord(raw);
  const state = asNonEmptyString(record.state) || 'No current state extracted.';
  const scope = asNonEmptyString(record.scope) || 'unknown';
  const status = asNonEmptyString(record.status) || 'unknown';
  const rawVolatility = asNonEmptyString(record.volatility);
  return currentStateExtractionSchema.parse({
    state,
    scope,
    status,
    volatility:
      rawVolatility && VOLATILITY_VALUES.has(rawVolatility as never)
        ? rawVolatility
        : 'semi-stable',
    evidence: asNonEmptyString(record.evidence) || state,
  });
}

export function coerceExtractionPayload(
  kind: ExtractionKind,
  raw: unknown
): MemoryExtractions[ExtractionKind] {
  switch (kind) {
    case 'entity':
      return coerceEntityExtraction(raw);
    case 'durable_fact':
      return coerceDurableFactExtraction(raw);
    case 'summary':
      return coerceSummaryExtraction(raw);
    case 'current_state':
      return coerceCurrentStateExtraction(raw);
  }
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

interface ExtractionResult {
  normalized: MemoryExtractions[ExtractionKind];
  raw: unknown;
}

function buildRuntimeConfig(): ExtractionRuntimeConfig {
  const enabledKinds: ExtractionKind[] = [];
  if (env.MEMORY_LLM_ENTITY_ENABLED) enabledKinds.push('entity');
  if (env.MEMORY_LLM_DURABLE_FACT_ENABLED) enabledKinds.push('durable_fact');
  if (env.MEMORY_LLM_SUMMARY_ENABLED) enabledKinds.push('summary');
  if (env.MEMORY_LLM_CURRENT_STATE_ENABLED) enabledKinds.push('current_state');

  return {
    enabled: env.MEMORY_LLM_EXTRACTION_ENABLED,
    model: env.MEMORY_LLM_MODEL || DEFAULT_MEMORY_LLM_MODEL,
    baseUrl: env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL,
    hasApiKey: Boolean(env.OPENAI_API_KEY),
    maxInputChars: env.MEMORY_LLM_MAX_INPUT_CHARS,
    enabledKinds,
  };
}

function sanitizeSource(
  source: MemoryExtractionSource,
  maxInputChars: number
): MemoryExtractionSource {
  return {
    ...source,
    summary: source.summary
      ? clampSourceText(source.summary, Math.min(maxInputChars, 2000))
      : source.summary,
    content: clampSourceText(source.content, maxInputChars),
  };
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('LLM extraction response did not contain a JSON object');
  }
  return trimmed.slice(firstBrace, lastBrace + 1);
}

export class MemoryLlmExtractor {
  private readonly config: ExtractionRuntimeConfig;

  constructor(config: ExtractionRuntimeConfig = buildRuntimeConfig()) {
    this.config = config;
  }

  isEnabled(): boolean {
    return this.config.enabled && this.config.enabledKinds.length > 0;
  }

  getEnabledKinds(): ExtractionKind[] {
    return [...this.config.enabledKinds];
  }

  async extract(source: MemoryExtractionSource): Promise<MemoryExtractions | null> {
    if (!this.isEnabled()) return null;
    if (!this.config.hasApiKey) {
      logger.warn('Memory LLM extraction enabled without OPENAI_API_KEY; skipping extraction', {
        model: this.config.model,
        enabledKinds: this.config.enabledKinds,
      });
      return null;
    }

    const sanitizedSource = sanitizeSource(source, this.config.maxInputChars);
    const entries = await Promise.all(
      this.config.enabledKinds.map(
        async (kind) => [kind, await this.extractKind(kind, sanitizedSource)] as const
      )
    );

    const extractedAt = new Date().toISOString();
    const payload: Partial<MemoryExtractions> = {
      version: MEMORY_EXTRACTION_VERSION,
      provider: 'openai',
      model: this.config.model,
      extractedAt,
      raw: {
        provider: 'openai',
        model: this.config.model,
        extractedAt,
      },
    };

    for (const [kind, result] of entries) {
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

  private async extractKind(
    kind: ExtractionKind,
    source: MemoryExtractionSource
  ): Promise<ExtractionResult | null> {
    const prompt = buildExtractionPrompt(source, kind);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    try {
      const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `${prompt.systemPrompt}\n${prompt.schemaDescription}`,
            },
            {
              role: 'user',
              content: prompt.userPrompt,
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Memory LLM extraction failed (${response.status})`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content?.trim()) throw new Error('Memory LLM extraction returned empty content');

      const parsedJson = JSON.parse(extractJsonObject(content));
      return {
        normalized: coerceExtractionPayload(kind, parsedJson),
        raw: parsedJson,
      };
    } catch (error) {
      logger.warn('Memory LLM extraction failed for kind', {
        kind,
        model: this.config.model,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
