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

export interface MemoryExtractionSource {
  summary?: string | null;
  content: string;
  topicKey?: string | null;
  topics?: string[] | null;
  source?: string | null;
  salience?: string | null;
}

export type ExtractionKind = 'entity' | 'durable_fact' | 'summary' | 'current_state';

export interface ExtractionPromptBundle {
  kind: ExtractionKind;
  systemPrompt: string;
  userPrompt: string;
  schemaDescription: string;
}

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
