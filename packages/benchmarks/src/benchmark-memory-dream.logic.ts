import type { LongMemEvalDreamCase } from './benchmark-data/longmemeval-loader';

export type DreamMode = 'online' | 'batch';

export interface DreamMemoryRow {
  id: string;
  content: string;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface DreamEntity {
  name: string;
  entityType?: string;
  description: string;
  aliases: string[];
  evidence: string;
  evidenceMemoryIds: string[];
  evidenceSessionIds: string[];
  firstSeenSessionId: string;
  lastSeenSessionId: string;
}

export interface DreamDurableFact {
  key: string;
  fact: string;
  category: string;
  subject?: string;
  object?: string;
  evidence: string;
  status: 'active' | 'superseded' | 'uncertain';
  evidenceMemoryIds: string[];
  evidenceSessionIds: string[];
  firstSeenSessionId: string;
  lastSeenSessionId: string;
}

export interface DreamCurrentState {
  key: string;
  state: string;
  scope: string;
  status: string;
  volatility: string;
  evidence: string;
  evidenceMemoryIds: string[];
  evidenceSessionIds: string[];
  lastSeenSessionId: string;
}

export interface DreamTemporalEvent {
  sessionId: string;
  memoryId: string;
  date?: string;
  orderIndex: number;
  summary: string;
  isAnswerSession: boolean;
}

export interface DreamState {
  caseId: string;
  mode: DreamMode;
  sessionCount: number;
  stateSummary: string;
  entities: DreamEntity[];
  durableFacts: DreamDurableFact[];
  currentStates: DreamCurrentState[];
  temporalEvents: DreamTemporalEvent[];
  evidenceMemoryIds: string[];
  evidenceSessionIds: string[];
  updatedAt: string;
}

export interface OrderedDreamSession {
  caseId: string;
  sessionId: string;
  memoryId: string;
  content: string;
  date?: string;
  hasAnswer: boolean;
  isAnswerSession: boolean;
  createdAt: string;
  sourceSummary: string | null;
  extractions: DreamExtractionViews;
}

export interface DreamExtractionViews {
  entities: ExtractedEntity[];
  durableFacts: ExtractedDurableFact[];
  summary: ExtractedSummary | null;
  currentState: ExtractedCurrentState | null;
}

export interface ExtractedEntity {
  name: string;
  aliases: string[];
  entityType?: string;
  description: string;
  evidence: string;
}

export interface ExtractedDurableFact {
  fact: string;
  category: string;
  subject?: string;
  object?: string;
  evidence: string;
}

export interface ExtractedSummary {
  summary: string;
  keyPoints: string[];
  actionRelevance: string;
}

export interface ExtractedCurrentState {
  state: string;
  scope: string;
  status: string;
  volatility: string;
  evidence: string;
}

export interface BuildDreamSessionsResult {
  sessions: OrderedDreamSession[];
  missingSessionIds: string[];
  extraMemoryIds: string[];
}

export interface DreamLimits {
  maxEntities: number;
  maxDurableFacts: number;
  maxCurrentStates: number;
  maxTemporalEvents: number;
  maxStateSummaryChars: number;
}

const DEFAULT_LIMITS: DreamLimits = {
  maxEntities: 80,
  maxDurableFacts: 160,
  maxCurrentStates: 60,
  maxTemporalEvents: 80,
  maxStateSummaryChars: 2500,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clampText(text: string, maxChars: number): string {
  const compacted = compactWhitespace(text);
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeKey(text: string): string {
  return compactWhitespace(text).toLowerCase();
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items.map(compactWhitespace).filter(Boolean)));
}

function mergeEvidenceIds(existing: string[], next: string): string[] {
  return uniqueStrings([...existing, next]);
}

function extractEntities(raw: unknown): ExtractedEntity[] {
  const record = asRecord(raw);
  return asArray(record?.entities)
    .map((item) => {
      const entity = asRecord(item);
      const name = asString(entity?.name);
      const description = asString(entity?.description);
      const evidence = asString(entity?.evidence);
      if (!name || !description || !evidence) return null;
      return {
        name,
        aliases: asArray(entity?.aliases)
          .map(asString)
          .filter((alias): alias is string => Boolean(alias)),
        entityType: asString(entity?.entityType) || undefined,
        description,
        evidence,
      };
    })
    .filter((entity): entity is ExtractedEntity => Boolean(entity));
}

function extractDurableFacts(raw: unknown): ExtractedDurableFact[] {
  const record = asRecord(raw);
  return asArray(record?.durableFacts)
    .map((item) => {
      const fact = asRecord(item);
      const factText = asString(fact?.fact);
      const evidence = asString(fact?.evidence);
      if (!factText || !evidence) return null;
      return {
        fact: factText,
        category: asString(fact?.category) || 'other',
        subject: asString(fact?.subject) || undefined,
        object: asString(fact?.object) || undefined,
        evidence,
      };
    })
    .filter((fact): fact is ExtractedDurableFact => Boolean(fact));
}

function extractSummary(raw: unknown): ExtractedSummary | null {
  const record = asRecord(raw);
  const summary = asString(record?.summary);
  const actionRelevance = asString(record?.actionRelevance);
  if (!summary || !actionRelevance) return null;
  return {
    summary,
    keyPoints: asArray(record?.keyPoints)
      .map(asString)
      .filter((point): point is string => Boolean(point)),
    actionRelevance,
  };
}

function extractCurrentState(raw: unknown): ExtractedCurrentState | null {
  const record = asRecord(raw);
  const state = asString(record?.state);
  const scope = asString(record?.scope);
  const status = asString(record?.status);
  const evidence = asString(record?.evidence);
  if (!state || !scope || !status || !evidence) return null;
  return {
    state,
    scope,
    status,
    volatility: asString(record?.volatility) || 'semi-stable',
    evidence,
  };
}

export function parseLongMemSessionId(content: string): string | null {
  const match = content.match(/^session\s+([^\r\n]+)[\r\n]+/i);
  return match?.[1]?.trim() || null;
}

export function extractDreamViews(metadata: Record<string, unknown> | null): DreamExtractionViews {
  const llmExtractions = asRecord(metadata?.llm_extractions);
  return {
    entities: extractEntities(llmExtractions?.entity),
    durableFacts: extractDurableFacts(llmExtractions?.durable_fact),
    summary: extractSummary(llmExtractions?.summary),
    currentState: extractCurrentState(llmExtractions?.current_state),
  };
}

export function buildOrderedDreamSessions(
  dreamCase: LongMemEvalDreamCase,
  memoryRows: DreamMemoryRow[]
): BuildDreamSessionsResult {
  const bySessionId = new Map<string, DreamMemoryRow>();

  for (const row of memoryRows) {
    const sessionId = parseLongMemSessionId(row.content);
    if (!sessionId) continue;
    bySessionId.set(sessionId, row);
  }

  const sessions: OrderedDreamSession[] = [];
  const missingSessionIds: string[] = [];
  const consumedMemoryIds = new Set<string>();

  for (const rawSession of dreamCase.sessions) {
    const memory = bySessionId.get(rawSession.sessionId);
    if (!memory) {
      missingSessionIds.push(rawSession.sessionId);
      continue;
    }
    consumedMemoryIds.add(memory.id);
    sessions.push({
      caseId: dreamCase.id,
      sessionId: rawSession.sessionId,
      memoryId: memory.id,
      content: memory.content,
      date: rawSession.date,
      hasAnswer: rawSession.hasAnswer,
      isAnswerSession: rawSession.isAnswerSession,
      createdAt: memory.created_at,
      sourceSummary: memory.summary,
      extractions: extractDreamViews(memory.metadata),
    });
  }

  const extraMemoryIds = memoryRows
    .map((row) => row.id)
    .filter((memoryId) => !consumedMemoryIds.has(memoryId));

  return { sessions, missingSessionIds, extraMemoryIds };
}

export function createInitialDreamState(caseId: string, mode: DreamMode): DreamState {
  return {
    caseId,
    mode,
    sessionCount: 0,
    stateSummary: '',
    entities: [],
    durableFacts: [],
    currentStates: [],
    temporalEvents: [],
    evidenceMemoryIds: [],
    evidenceSessionIds: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function factKey(fact: ExtractedDurableFact): string {
  return normalizeKey(
    [fact.category, fact.subject || 'unknown-subject', fact.object || 'unknown-object', fact.fact]
      .filter(Boolean)
      .join('|')
  );
}

function currentStateKey(state: ExtractedCurrentState): string {
  return normalizeKey([state.scope, state.status, state.state].join('|'));
}

function updateStateSummary(params: {
  previousSummary: string;
  session: OrderedDreamSession;
  limits: DreamLimits;
}): string {
  const sessionSummary = params.session.extractions.summary;
  const nextLine = sessionSummary
    ? `session ${params.session.sessionId}: ${sessionSummary.summary}`
    : `session ${params.session.sessionId}: ${clampText(params.session.content, 260)}`;
  const combined = [params.previousSummary, nextLine].filter(Boolean).join('\n');
  if (combined.length <= params.limits.maxStateSummaryChars) return combined;
  return combined.slice(combined.length - params.limits.maxStateSummaryChars).trimStart();
}

export function applyLocalDreamUpdate(
  state: DreamState,
  session: OrderedDreamSession,
  limits: Partial<DreamLimits> = {}
): DreamState {
  const resolvedLimits = { ...DEFAULT_LIMITS, ...limits };
  const entityMap = new Map(state.entities.map((entity) => [normalizeKey(entity.name), entity]));
  const factMap = new Map(state.durableFacts.map((fact) => [fact.key, fact]));
  const currentStateMap = new Map(state.currentStates.map((item) => [item.key, item]));

  for (const entity of session.extractions.entities) {
    const key = normalizeKey(entity.name);
    const existing = entityMap.get(key);
    entityMap.set(key, {
      name: entity.name,
      entityType: entity.entityType || existing?.entityType,
      description: entity.description,
      aliases: uniqueStrings([...(existing?.aliases || []), ...entity.aliases]),
      evidence: entity.evidence,
      evidenceMemoryIds: mergeEvidenceIds(existing?.evidenceMemoryIds || [], session.memoryId),
      evidenceSessionIds: mergeEvidenceIds(existing?.evidenceSessionIds || [], session.sessionId),
      firstSeenSessionId: existing?.firstSeenSessionId || session.sessionId,
      lastSeenSessionId: session.sessionId,
    });
  }

  for (const fact of session.extractions.durableFacts) {
    const key = factKey(fact);
    const existing = factMap.get(key);
    factMap.set(key, {
      key,
      fact: fact.fact,
      category: fact.category,
      subject: fact.subject,
      object: fact.object,
      evidence: fact.evidence,
      status: existing?.status || 'active',
      evidenceMemoryIds: mergeEvidenceIds(existing?.evidenceMemoryIds || [], session.memoryId),
      evidenceSessionIds: mergeEvidenceIds(existing?.evidenceSessionIds || [], session.sessionId),
      firstSeenSessionId: existing?.firstSeenSessionId || session.sessionId,
      lastSeenSessionId: session.sessionId,
    });
  }

  if (session.extractions.currentState) {
    const currentState = session.extractions.currentState;
    const key = currentStateKey(currentState);
    const existing = currentStateMap.get(key);
    currentStateMap.set(key, {
      key,
      state: currentState.state,
      scope: currentState.scope,
      status: currentState.status,
      volatility: currentState.volatility,
      evidence: currentState.evidence,
      evidenceMemoryIds: mergeEvidenceIds(existing?.evidenceMemoryIds || [], session.memoryId),
      evidenceSessionIds: mergeEvidenceIds(existing?.evidenceSessionIds || [], session.sessionId),
      lastSeenSessionId: session.sessionId,
    });
  }

  const summary = session.extractions.summary;
  const eventSummary = summary
    ? [summary.summary, ...summary.keyPoints.slice(0, 3)].join(' | ')
    : clampText(session.content, 400);

  const temporalEvents = [
    ...state.temporalEvents,
    {
      sessionId: session.sessionId,
      memoryId: session.memoryId,
      date: session.date,
      orderIndex: state.sessionCount,
      summary: eventSummary,
      isAnswerSession: session.isAnswerSession,
    },
  ].slice(-resolvedLimits.maxTemporalEvents);

  return {
    ...state,
    sessionCount: state.sessionCount + 1,
    stateSummary: updateStateSummary({
      previousSummary: state.stateSummary,
      session,
      limits: resolvedLimits,
    }),
    entities: Array.from(entityMap.values()).slice(-resolvedLimits.maxEntities),
    durableFacts: Array.from(factMap.values()).slice(-resolvedLimits.maxDurableFacts),
    currentStates: Array.from(currentStateMap.values()).slice(-resolvedLimits.maxCurrentStates),
    temporalEvents,
    evidenceMemoryIds: mergeEvidenceIds(state.evidenceMemoryIds, session.memoryId),
    evidenceSessionIds: mergeEvidenceIds(state.evidenceSessionIds, session.sessionId),
    updatedAt: new Date().toISOString(),
  };
}

export function renderDreamStateForAnswerCheck(state: DreamState): string {
  return [
    state.stateSummary,
    ...state.entities.map(
      (entity) =>
        `${entity.name}: ${entity.description}; evidence: ${entity.evidence}; sessions: ${entity.evidenceSessionIds.join(', ')}`
    ),
    ...state.durableFacts.map(
      (fact) =>
        `${fact.fact}; category: ${fact.category}; subject: ${fact.subject || ''}; object: ${
          fact.object || ''
        }; evidence: ${fact.evidence}; sessions: ${fact.evidenceSessionIds.join(', ')}`
    ),
    ...state.currentStates.map(
      (item) =>
        `${item.state}; scope: ${item.scope}; status: ${item.status}; evidence: ${item.evidence}; sessions: ${item.evidenceSessionIds.join(', ')}`
    ),
    ...state.temporalEvents.map((event) => `${event.sessionId}: ${event.summary}`),
  ].join('\n');
}

export function normalizeForCoverage(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function textContainsAnswer(text: string, answer: string | undefined): boolean | null {
  if (!answer?.trim()) return null;
  const normalizedText = normalizeForCoverage(text);
  const normalizedAnswer = normalizeForCoverage(answer);
  if (!normalizedAnswer) return null;
  return normalizedText.includes(normalizedAnswer);
}

export function buildOnlineDreamPrompt(params: {
  caseId: string;
  question: string;
  previousState: DreamState;
  nextSession: OrderedDreamSession;
}): { systemPrompt: string; userPrompt: string; schemaDescription: string } {
  return {
    systemPrompt:
      'You are an online memory-dream worker. Integrate one new chronological episode into a compact, evidence-grounded state ledger. Return strict JSON only. Do not use benchmark answer labels. Do not review all past raw episodes; use the prior compact state plus this one new episode.',
    schemaDescription:
      'JSON schema: {"stateSummary": string, "entities": [{"name": string, "entityType"?: string, "description": string, "aliases": string[], "evidenceMemoryIds": string[], "evidenceSessionIds": string[]}], "durableFacts": [{"key": string, "fact": string, "category": string, "subject"?: string, "object"?: string, "status": "active"|"superseded"|"uncertain", "evidenceMemoryIds": string[], "evidenceSessionIds": string[]}], "currentStates": [{"key": string, "state": string, "scope": string, "status": string, "volatility": string, "evidenceMemoryIds": string[], "evidenceSessionIds": string[]}], "temporalEvents": [{"sessionId": string, "memoryId": string, "date"?: string, "summary": string}], "notes": string[]}',
    userPrompt: [
      `caseId: ${params.caseId}`,
      `question for later evaluation only, not a label: ${params.question}`,
      '',
      'Integration rules:',
      '- Treat episodes as chronological within this case.',
      '- Preserve current state updates, quantities, decisions, constraints, process rules, list/table mappings, and exact values when evidence supports them.',
      '- If a new episode updates an old value, mark the old fact superseded and write the new active value with evidence links.',
      '- If a value requires arithmetic or accumulation, perform the update and keep both evidence session ids.',
      '- Keep the ledger compact. Do not copy the full transcript.',
      '- Keep cases isolated: never infer from other cases.',
      '',
      'Previous compact dream state JSON:',
      JSON.stringify(params.previousState, null, 2),
      '',
      'New episode JSON:',
      JSON.stringify(
        {
          sessionId: params.nextSession.sessionId,
          memoryId: params.nextSession.memoryId,
          date: params.nextSession.date || null,
          sourceSummary: params.nextSession.sourceSummary,
          extractedViews: params.nextSession.extractions,
          content: params.nextSession.content,
        },
        null,
        2
      ),
    ].join('\n'),
  };
}
