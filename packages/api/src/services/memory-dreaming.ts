import type { Memory } from '../data/models/memory';

export interface DreamFactCandidate {
  text: string;
  score: number;
}

export interface DreamDuplicateCandidate {
  canonicalId: string;
  duplicateId: string;
  similarity: number;
}

export interface DreamSupersessionCandidate {
  newerId: string;
  olderId: string;
  confidence: number;
  reason: 'override-cue' | 'replacement-cue';
}

const CHRONOLOGY_QUERY_CUES = [
  'latest',
  'current',
  'newest',
  'recent',
  'now',
  'override',
  'overrides',
  'supersede',
  'supersedes',
  'replace',
  'replaces',
  'replaced',
  'deprecated',
];

const FORWARD_LOOKING_MEMORY_CUES = [
  'override',
  'overrides',
  'supersede',
  'supersedes',
  'replace',
  'replaces',
  'replaced',
  'current',
  'new policy',
  'now uses',
  'instead of',
];

const STALE_MEMORY_CUES = ['deprecated', 'old policy', 'previous policy', 'former'];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 2);
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const aSet = new Set(a);
  const bSet = new Set(b);
  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection += 1;
  }
  const union = new Set([...aSet, ...bSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function sentenceScore(sentence: string): number {
  const lowered = normalize(sentence);
  let score = 0;
  if (/\d/.test(sentence)) score += 0.2;
  if (FORWARD_LOOKING_MEMORY_CUES.some((cue) => lowered.includes(cue))) score += 0.4;
  if (/\b(must|should|requires|important|decided|because|policy|convention)\b/.test(lowered)) {
    score += 0.3;
  }
  const tokens = tokenize(lowered);
  const uniqueTokens = new Set(tokens);
  score += Math.min(0.2, uniqueTokens.size / Math.max(tokens.length, 1));
  return score;
}

export function queryHasChronologyIntent(query: string): boolean {
  const lowered = normalize(query);
  return CHRONOLOGY_QUERY_CUES.some((cue) => lowered.includes(cue));
}

export function computeChronologyAwareBoost(params: {
  query: string;
  memory: Pick<Memory, 'content' | 'summary' | 'topicKey' | 'createdAt'>;
  minCreatedAt: Date;
  maxCreatedAt: Date;
}): number {
  if (!queryHasChronologyIntent(params.query)) return 0;

  const combined = normalize(
    [params.memory.summary || '', params.memory.topicKey || '', params.memory.content].join('\n')
  );
  const spanMs = Math.max(1, params.maxCreatedAt.getTime() - params.minCreatedAt.getTime());
  const recencyRatio =
    (params.memory.createdAt.getTime() - params.minCreatedAt.getTime()) / spanMs;

  let boost = recencyRatio * 0.08;
  if (FORWARD_LOOKING_MEMORY_CUES.some((cue) => combined.includes(cue))) boost += 0.05;
  if (STALE_MEMORY_CUES.some((cue) => combined.includes(cue))) boost -= 0.03;

  return Math.max(-0.05, Math.min(0.15, boost));
}

export function extractDreamDurableFacts(memory: Pick<Memory, 'content' | 'summary'>): DreamFactCandidate[] {
  const source = [memory.summary || '', memory.content]
    .join('\n')
    .replace(/\r/g, '\n')
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((part) => part.trim())
    .filter((part) => part.length >= 32 && part.length <= 280);

  const ranked = source
    .map((text) => ({ text, score: sentenceScore(text) }))
    .filter((candidate) => candidate.score > 0.25)
    .sort((a, b) => b.score - a.score || b.text.length - a.text.length);

  const deduped: DreamFactCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of ranked) {
    const key = normalize(candidate.text);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
    if (deduped.length >= 5) break;
  }
  return deduped;
}

export function findDreamDuplicateCandidates(
  memories: Array<Pick<Memory, 'id' | 'content' | 'summary' | 'topicKey'>>
): DreamDuplicateCandidate[] {
  const duplicates: DreamDuplicateCandidate[] = [];

  for (let i = 0; i < memories.length; i += 1) {
    for (let j = i + 1; j < memories.length; j += 1) {
      const left = memories[i];
      const right = memories[j];
      if (left.topicKey && right.topicKey && left.topicKey !== right.topicKey) continue;

      const similarity = jaccard(
        tokenize(`${left.summary || ''} ${left.content}`),
        tokenize(`${right.summary || ''} ${right.content}`)
      );
      if (similarity < 0.82) continue;

      duplicates.push({
        canonicalId: left.id,
        duplicateId: right.id,
        similarity: Number(similarity.toFixed(4)),
      });
    }
  }

  return duplicates;
}

export function findDreamSupersessionCandidates(
  memories: Array<Pick<Memory, 'id' | 'content' | 'summary' | 'topicKey' | 'createdAt'>>
): DreamSupersessionCandidate[] {
  const candidates: DreamSupersessionCandidate[] = [];

  const byTopic = new Map<string, Array<Pick<Memory, 'id' | 'content' | 'summary' | 'createdAt'>>>();
  for (const memory of memories) {
    if (!memory.topicKey) continue;
    const bucket = byTopic.get(memory.topicKey) || [];
    bucket.push(memory);
    byTopic.set(memory.topicKey, bucket);
  }

  for (const bucket of byTopic.values()) {
    const ordered = [...bucket].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (let i = 1; i < ordered.length; i += 1) {
      const older = ordered[i - 1];
      const newer = ordered[i];
      const combined = normalize(`${newer.summary || ''} ${newer.content}`);

      const reason = combined.includes('override') || combined.includes('supersede')
        ? 'override-cue'
        : combined.includes('replace') || combined.includes('instead of')
          ? 'replacement-cue'
          : null;
      if (!reason) continue;

      const tokenSimilarity = jaccard(
        tokenize(`${older.summary || ''} ${older.content}`),
        tokenize(`${newer.summary || ''} ${newer.content}`)
      );

      candidates.push({
        newerId: newer.id,
        olderId: older.id,
        confidence: Number(Math.min(0.99, 0.55 + tokenSimilarity * 0.35).toFixed(4)),
        reason,
      });
    }
  }

  return candidates;
}
