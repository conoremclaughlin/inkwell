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

export const DEFAULT_DREAM_LIMITS: DreamLimits = {
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

const QUERY_STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'does',
  'have',
  'how',
  'many',
  'much',
  'what',
  'when',
  'where',
  'which',
  'while',
  'with',
  'your',
]);

function stripSessionHeader(content: string): string {
  return content.replace(/^session\s+[^\r\n]+[\r\n]+/i, '');
}

const EXACT_DETAIL_RULES = [
  '- Preserve exact small details as durableFacts/currentStates even when they seem mundane: counts, quantities, durations, dates, ordinals, yes/no completion or possession, locations, materials, tools, titles, names, quoted wording, and unsupported/conflicting premises.',
  '- User-authored exact details outrank generic assistant advice. For visible user turns, preserve every explicit personal count, amount, duration, date, quantity, possession, location, and completion/status value unless it is clearly not about the user/case state.',
  '- Do not let assistant numbered advice lists crowd out user-state numbers. Generic list numbering from advice is low priority; user statements like "I have 37 coins" are high priority.',
  '- Use precise durableFact categories when helpful: quantity_count, state_transition, possession_location, list_entry, exact_span, negative_or_premise, decision, constraint, process, status.',
  '- For list/table/enumeration content, preserve numbered or ordinal items as durableFacts using the ordinal/key and exact item text when visible.',
  '- For location or possession updates, write the latest active currentStates record and mark older conflicting facts superseded when evidence supports a change.',
  '- For absence or premise-mismatch evidence, write what the source actually states and what remains unsupported; do not invent the missing premise.',
  '- Prefer preserving exact values over broad topical summaries. A compact ledger can omit generic advice before it omits source-grounded values, counts, locations, or exact spans.',
];

function queryTokens(query: string): string[] {
  return uniqueStrings(
    query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3 || /^\d+$/.test(token))
      .filter((token) => !QUERY_STOPWORDS.has(token))
  );
}

function paragraphScore(paragraph: string, tokens: string[]): number {
  const normalized = paragraph.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const tokenScore = tokens.filter((token) => normalized.includes(token)).length;
  const numberScore = /\d/.test(paragraph) ? 1 : 0;
  return tokenScore * 3 + numberScore;
}

function buildContentEdgeExcerpt(content: string, maxChars: number): string {
  const stripped = stripSessionHeader(content).trim();
  if (stripped.length <= maxChars) return stripped;
  const edgeChars = Math.max(200, Math.floor((maxChars - 20) / 2));
  return `${stripped.slice(0, edgeChars).trimEnd()}\n...\n${stripped.slice(-edgeChars).trimStart()}`;
}

function buildRelevantContentExcerpt(
  content: string,
  query: string | null,
  maxChars: number
): string {
  const stripped = stripSessionHeader(content).trim();
  if (stripped.length <= maxChars) return stripped;
  if (!query?.trim()) return buildContentEdgeExcerpt(content, maxChars);

  const tokens = queryTokens(query);
  const paragraphs = stripped
    .split(/\n(?=(?:user|assistant):)|\n{2,}/i)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const scored = paragraphs
    .map((paragraph, index) => ({
      paragraph,
      index,
      score: paragraphScore(paragraph, tokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (scored.length === 0) {
    return buildContentEdgeExcerpt(content, maxChars);
  }

  const selected = scored.slice(0, 4).sort((a, b) => a.index - b.index);
  const separatorBudget = Math.max(0, selected.length - 1) * 5;
  const perParagraphChars = Math.max(
    120,
    Math.floor((maxChars - separatorBudget) / Math.max(1, selected.length))
  );
  return (
    selected.map((entry) => clampText(entry.paragraph, perParagraphChars)).join('\n...\n') ||
    clampText(stripped, maxChars)
  );
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
  // Local dreams are intentionally heuristic accumulators: including the fact
  // text keeps differently worded observations distinct, so this reducer does
  // not infer semantic supersession across "37 coins" -> "38 coins" updates.
  // Real supersession is deferred to the future LLM dream updater.
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
    ? `summary: ${sessionSummary.summary}`
    : `summary: ${clampText(stripSessionHeader(params.session.content), 260)}`;
  const combined = [params.previousSummary, nextLine].filter(Boolean).join('\n');
  if (combined.length <= params.limits.maxStateSummaryChars) return combined;
  // Keep the tail deliberately: the local online reducer is recency-biased for
  // "current state" questions, while raw evidence links preserve chronology.
  return combined.slice(combined.length - params.limits.maxStateSummaryChars).trimStart();
}

function chooseEntityDescription(
  existing: DreamEntity | undefined,
  nextDescription: string
): string {
  if (!existing) return nextDescription;
  return nextDescription.length > existing.description.length
    ? nextDescription
    : existing.description;
}

function moveToEnd<TKey, TValue>(map: Map<TKey, TValue>, key: TKey, value: TValue): void {
  map.delete(key);
  map.set(key, value);
}

export function applyLocalDreamUpdate(
  state: DreamState,
  session: OrderedDreamSession,
  limits: Partial<DreamLimits> = {}
): DreamState {
  const resolvedLimits = { ...DEFAULT_DREAM_LIMITS, ...limits };
  const entityMap = new Map(state.entities.map((entity) => [normalizeKey(entity.name), entity]));
  const factMap = new Map(state.durableFacts.map((fact) => [fact.key, fact]));
  const currentStateMap = new Map(state.currentStates.map((item) => [item.key, item]));

  for (const entity of session.extractions.entities) {
    const key = normalizeKey(entity.name);
    const existing = entityMap.get(key);
    moveToEnd(entityMap, key, {
      name: entity.name,
      entityType: entity.entityType || existing?.entityType,
      description: chooseEntityDescription(existing, entity.description),
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
    moveToEnd(factMap, key, {
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
    moveToEnd(currentStateMap, key, {
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
    : clampText(stripSessionHeader(session.content), 400);

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
  // Render only semantic content for answer checks. Evidence ids, session ids,
  // and counters are intentionally omitted so short answers like "38" do not
  // get credit from lineage metadata instead of remembered content.
  return [
    state.stateSummary,
    ...state.entities.map(
      (entity) => `${entity.name}: ${entity.description}; evidence: ${entity.evidence}`
    ),
    ...state.durableFacts.map(
      (fact) =>
        `${fact.fact}; category: ${fact.category}; subject: ${fact.subject || ''}; object: ${
          fact.object || ''
        }; evidence: ${fact.evidence}`
    ),
    ...state.currentStates.map(
      (item) =>
        `${item.state}; scope: ${item.scope}; status: ${item.status}; evidence: ${item.evidence}`
    ),
    ...state.temporalEvents.map((event) => event.summary),
  ].join('\n');
}

export function buildOnlineDreamPrompt(params: {
  caseId: string;
  question: string;
  previousState: DreamState;
  nextSession: OrderedDreamSession;
  maxContentExcerptChars?: number;
  useQuestionHints?: boolean;
}): { systemPrompt: string; userPrompt: string; schemaDescription: string } {
  const questionHint = params.useQuestionHints
    ? `question for later evaluation only, not a label: ${params.question}`
    : 'No future evaluation question is available to the dream worker.';
  return {
    systemPrompt:
      'You are an online memory-dream worker. Integrate one new chronological episode into a compact, evidence-grounded state ledger. Return strict JSON only. Do not use benchmark answer labels. Do not review all past raw episodes; use the prior compact state plus this one new episode.',
    schemaDescription:
      'JSON schema: {"stateSummary": string, "entities": [{"name": string, "entityType"?: string, "description": string, "aliases": string[], "evidence": string, "evidenceMemoryIds": string[], "evidenceSessionIds": string[]}], "durableFacts": [{"key": string, "fact": string, "category": string, "subject"?: string, "object"?: string, "evidence": string, "status": "active"|"superseded"|"uncertain", "evidenceMemoryIds": string[], "evidenceSessionIds": string[]}], "currentStates": [{"key": string, "state": string, "scope": string, "status": string, "volatility": string, "evidence": string, "evidenceMemoryIds": string[], "evidenceSessionIds": string[]}], "temporalEvents": [{"sessionId": string, "memoryId": string, "date"?: string, "summary": string}], "notes": string[]}',
    userPrompt: [
      `caseId: ${params.caseId}`,
      questionHint,
      '',
      'Integration rules:',
      '- Treat episodes as chronological within this case.',
      '- Preserve current state updates, quantities, decisions, constraints, process rules, list/table mappings, and exact values when evidence supports them.',
      ...EXACT_DETAIL_RULES,
      '- If a new episode updates an old value, mark the old fact superseded and write the new active value with evidence links.',
      '- If a value requires arithmetic or accumulation, perform the update and keep both evidence session ids.',
      '- Explicit aggregate/count statements are authoritative state. Do not replace an explicit total with a smaller count of named examples.',
      '- If an earlier episode says a collection has total N and a later episode adds one item to that collection, write the active total as N+1 with both evidence links.',
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
          extractedViews: compactDreamExtractionViews(params.nextSession.extractions),
          contentExcerpt: buildRelevantContentExcerpt(
            params.nextSession.content,
            params.useQuestionHints ? params.question : null,
            params.maxContentExcerptChars || 4000
          ),
        },
        null,
        2
      ),
    ].join('\n'),
  };
}

function compactDreamExtractionViews(views: DreamExtractionViews): DreamExtractionViews {
  return {
    entities: views.entities.slice(0, 6).map((entity) => ({
      ...entity,
      description: clampText(entity.description, 220),
      evidence: clampText(entity.evidence, 180),
    })),
    durableFacts: views.durableFacts.slice(0, 8).map((fact) => ({
      ...fact,
      fact: clampText(fact.fact, 260),
      evidence: clampText(fact.evidence, 180),
    })),
    summary: views.summary
      ? {
          summary: clampText(views.summary.summary, 500),
          keyPoints: views.summary.keyPoints.slice(0, 6).map((point) => clampText(point, 220)),
          actionRelevance: clampText(views.summary.actionRelevance, 260),
        }
      : null,
    currentState: views.currentState
      ? {
          ...views.currentState,
          state: clampText(views.currentState.state, 240),
          evidence: clampText(views.currentState.evidence, 180),
        }
      : null,
  };
}

function statusFromRaw(raw: unknown): DreamDurableFact['status'] {
  const status = asString(raw);
  return status === 'active' || status === 'superseded' || status === 'uncertain'
    ? status
    : 'active';
}

function evidenceIdsFromRaw(raw: unknown, fallback: string): string[] {
  const ids = asArray(raw)
    .map(asString)
    .filter((id): id is string => Boolean(id));
  return uniqueStrings(ids.length > 0 ? ids : [fallback]);
}

function clampDreamState(state: DreamState, limits: DreamLimits): DreamState {
  return {
    ...state,
    stateSummary: clampText(state.stateSummary, limits.maxStateSummaryChars),
    entities: state.entities.slice(-limits.maxEntities),
    durableFacts: state.durableFacts.slice(-limits.maxDurableFacts),
    currentStates: state.currentStates.slice(-limits.maxCurrentStates),
    temporalEvents: state.temporalEvents.slice(-limits.maxTemporalEvents),
  };
}

export function coerceDreamStateUpdate(
  raw: unknown,
  params: {
    previousState: DreamState;
    currentSession: OrderedDreamSession;
    limits?: Partial<DreamLimits>;
  }
): DreamState {
  const record = asRecord(raw);
  if (!record) {
    throw new Error('Dream update response must be a JSON object.');
  }

  const limits = { ...DEFAULT_DREAM_LIMITS, ...params.limits };
  const currentSessionId = params.currentSession.sessionId;
  const currentMemoryId = params.currentSession.memoryId;
  const stateSummary = asString(record.stateSummary) || params.previousState.stateSummary;

  const entities = asArray(record.entities)
    .map((item) => {
      const entity = asRecord(item);
      const name = asString(entity?.name);
      const description = asString(entity?.description);
      if (!name || !description) return null;
      const evidenceMemoryIds = evidenceIdsFromRaw(entity?.evidenceMemoryIds, currentMemoryId);
      const evidenceSessionIds = evidenceIdsFromRaw(entity?.evidenceSessionIds, currentSessionId);
      return {
        name,
        entityType: asString(entity?.entityType) || undefined,
        description,
        aliases: asArray(entity?.aliases)
          .map(asString)
          .filter((alias): alias is string => Boolean(alias)),
        evidence: asString(entity?.evidence) || description,
        evidenceMemoryIds,
        evidenceSessionIds,
        firstSeenSessionId: evidenceSessionIds[0] || currentSessionId,
        lastSeenSessionId: evidenceSessionIds[evidenceSessionIds.length - 1] || currentSessionId,
      };
    })
    .filter((entity): entity is DreamEntity => Boolean(entity));

  const durableFacts = asArray(record.durableFacts)
    .map((item) => {
      const fact = asRecord(item);
      const factText = asString(fact?.fact);
      if (!factText) return null;
      const category = asString(fact?.category) || 'other';
      const subject = asString(fact?.subject) || undefined;
      const object = asString(fact?.object) || undefined;
      const key =
        asString(fact?.key) || normalizeKey([category, subject, object, factText].join('|'));
      const evidenceMemoryIds = evidenceIdsFromRaw(fact?.evidenceMemoryIds, currentMemoryId);
      const evidenceSessionIds = evidenceIdsFromRaw(fact?.evidenceSessionIds, currentSessionId);
      return {
        key,
        fact: factText,
        category,
        subject,
        object,
        evidence: asString(fact?.evidence) || factText,
        status: statusFromRaw(fact?.status),
        evidenceMemoryIds,
        evidenceSessionIds,
        firstSeenSessionId: evidenceSessionIds[0] || currentSessionId,
        lastSeenSessionId: evidenceSessionIds[evidenceSessionIds.length - 1] || currentSessionId,
      };
    })
    .filter((fact): fact is DreamDurableFact => Boolean(fact));

  const currentStates = asArray(record.currentStates)
    .map((item) => {
      const state = asRecord(item);
      const stateText = asString(state?.state);
      const scope = asString(state?.scope);
      const status = asString(state?.status);
      if (!stateText || !scope || !status) return null;
      const key = asString(state?.key) || normalizeKey([scope, status, stateText].join('|'));
      const evidenceMemoryIds = evidenceIdsFromRaw(state?.evidenceMemoryIds, currentMemoryId);
      const evidenceSessionIds = evidenceIdsFromRaw(state?.evidenceSessionIds, currentSessionId);
      return {
        key,
        state: stateText,
        scope,
        status,
        volatility: asString(state?.volatility) || 'semi-stable',
        evidence: asString(state?.evidence) || stateText,
        evidenceMemoryIds,
        evidenceSessionIds,
        lastSeenSessionId: evidenceSessionIds[evidenceSessionIds.length - 1] || currentSessionId,
      };
    })
    .filter((state): state is DreamCurrentState => Boolean(state));

  const temporalEvents = asArray(record.temporalEvents)
    .map((item, index) => {
      const event = asRecord(item);
      const sessionId = asString(event?.sessionId);
      const memoryId = asString(event?.memoryId);
      const summary = asString(event?.summary);
      if (!sessionId || !memoryId || !summary) return null;
      const rawOrderIndex = typeof event?.orderIndex === 'number' ? event.orderIndex : index;
      return {
        sessionId,
        memoryId,
        date: asString(event?.date) || undefined,
        orderIndex: rawOrderIndex,
        summary,
        isAnswerSession: Boolean(event?.isAnswerSession),
      };
    })
    .filter((event): event is DreamTemporalEvent => Boolean(event));

  const evidenceMemoryIds = uniqueStrings([
    ...params.previousState.evidenceMemoryIds,
    ...entities.flatMap((entity) => entity.evidenceMemoryIds),
    ...durableFacts.flatMap((fact) => fact.evidenceMemoryIds),
    ...currentStates.flatMap((state) => state.evidenceMemoryIds),
    ...temporalEvents.map((event) => event.memoryId),
    currentMemoryId,
  ]);
  const evidenceSessionIds = uniqueStrings([
    ...params.previousState.evidenceSessionIds,
    ...entities.flatMap((entity) => entity.evidenceSessionIds),
    ...durableFacts.flatMap((fact) => fact.evidenceSessionIds),
    ...currentStates.flatMap((state) => state.evidenceSessionIds),
    ...temporalEvents.map((event) => event.sessionId),
    currentSessionId,
  ]);

  return clampDreamState(
    {
      caseId: params.previousState.caseId,
      mode: params.previousState.mode,
      sessionCount: Math.max(params.previousState.sessionCount + 1, temporalEvents.length),
      stateSummary,
      entities,
      durableFacts,
      currentStates,
      temporalEvents,
      evidenceMemoryIds,
      evidenceSessionIds,
      updatedAt: new Date().toISOString(),
    },
    limits
  );
}

export function buildBatchDreamPrompt(params: {
  caseId: string;
  question: string;
  sessions: OrderedDreamSession[];
  mode: DreamMode;
  maxContentExcerptChars: number;
  useQuestionHints?: boolean;
}): { systemPrompt: string; userPrompt: string; schemaDescription: string } {
  const questionHint = params.useQuestionHints
    ? `question for later evaluation only, not a label: ${params.question}`
    : 'No future evaluation question is available to the dream worker.';
  return {
    systemPrompt:
      'You are a batch memory-dream worker. Reconcile a chronological case history into a compact, evidence-grounded state ledger. Return strict JSON only. Do not use benchmark answer labels. Keep cases isolated.',
    schemaDescription:
      'JSON schema: {"stateSummary": string, "entities": [{"name": string, "entityType"?: string, "description": string, "aliases": string[], "evidence": string, "evidenceMemoryIds": string[], "evidenceSessionIds": string[]}], "durableFacts": [{"key": string, "fact": string, "category": string, "subject"?: string, "object"?: string, "evidence": string, "status": "active"|"superseded"|"uncertain", "evidenceMemoryIds": string[], "evidenceSessionIds": string[]}], "currentStates": [{"key": string, "state": string, "scope": string, "status": string, "volatility": string, "evidence": string, "evidenceMemoryIds": string[], "evidenceSessionIds": string[]}], "temporalEvents": [{"sessionId": string, "memoryId": string, "date"?: string, "summary": string}], "notes": string[]}',
    userPrompt: [
      `caseId: ${params.caseId}`,
      questionHint,
      `dream mode: ${params.mode}`,
      '',
      'Reconciliation rules:',
      '- Treat episodes as chronological within this case.',
      '- Preserve current state updates, quantities, decisions, constraints, process rules, list/table mappings, and exact values when evidence supports them.',
      ...EXACT_DETAIL_RULES,
      '- If a later episode updates an earlier value, mark the older fact superseded and keep the latest active value with evidence links.',
      '- If a value requires arithmetic or accumulation, perform the update and keep all supporting evidence session ids.',
      '- Explicit aggregate/count statements are authoritative state. Do not replace an explicit total with a smaller count of named examples.',
      '- If an earlier episode says a collection has total N and a later episode adds one item to that collection, write the active total as N+1 with both evidence links.',
      '- Keep the ledger compact. Do not copy full transcripts.',
      '- Use memoryId/sessionId exactly as supplied for evidence links.',
      '',
      'Chronological episodes JSON:',
      JSON.stringify(
        params.sessions.map((session) => ({
          sessionId: session.sessionId,
          memoryId: session.memoryId,
          date: session.date || null,
          sourceSummary: session.sourceSummary,
          extractedViews: compactDreamExtractionViews(session.extractions),
          contentExcerpt: buildRelevantContentExcerpt(
            session.content,
            params.useQuestionHints ? params.question : null,
            params.maxContentExcerptChars
          ),
        })),
        null,
        2
      ),
    ].join('\n'),
  };
}
