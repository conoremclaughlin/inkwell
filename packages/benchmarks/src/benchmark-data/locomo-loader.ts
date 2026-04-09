import { readFile } from 'node:fs/promises';
import type { BenchmarkCase } from './datasets';

const DEFAULT_LOCOMO_URL =
  'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json';

type LoCoMoTurn = {
  speaker?: string;
  dia_id?: string;
  text?: string;
};

type LoCoMoQuestion = {
  question?: string;
  answer?: string;
  evidence?: string[];
  category?: number;
};

type LoCoMoConversation = Record<string, unknown> & {
  speaker_a?: string;
  speaker_b?: string;
};

type LoCoMoSample = {
  sample_id?: string;
  conversation?: LoCoMoConversation;
  qa?: LoCoMoQuestion[];
};

type SessionRecord = {
  key: string;
  sessionNumber: number;
  dateTime?: string;
  turns: LoCoMoTurn[];
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function clampArray<T>(items: T[], limit: number): T[] {
  return items.slice(0, Math.max(0, limit));
}

function formatSession(session: SessionRecord, evidenceIds: Set<string>): string | null {
  const lines = session.turns
    .map((turn) => {
      const speaker = typeof turn.speaker === 'string' ? turn.speaker.trim() : 'unknown';
      const diaId = typeof turn.dia_id === 'string' ? turn.dia_id.trim() : '';
      const text = typeof turn.text === 'string' ? turn.text.trim() : '';
      if (!text) return null;
      const prefix = evidenceIds.has(diaId) ? '[evidence] ' : '';
      return `${prefix}${speaker}: ${text}`;
    })
    .filter((line): line is string => !!line);

  if (lines.length === 0) return null;

  const header = session.dateTime
    ? `${session.key} @ ${session.dateTime}`
    : `${session.key}`;

  return `${header}\n${lines.join('\n')}`;
}

function extractSessions(conversation: LoCoMoConversation | undefined): SessionRecord[] {
  if (!conversation) return [];

  const sessions: SessionRecord[] = [];
  for (const [key, value] of Object.entries(conversation)) {
    const match = /^session_(\d+)$/.exec(key);
    if (!match || !Array.isArray(value)) continue;

    const sessionNumber = Number(match[1]);
    const dateTimeKey = `session_${sessionNumber}_date_time`;
    const dateTime =
      typeof conversation[dateTimeKey] === 'string' ? String(conversation[dateTimeKey]) : undefined;

    sessions.push({
      key,
      sessionNumber,
      dateTime,
      turns: value as LoCoMoTurn[],
    });
  }

  return sessions.sort((a, b) => a.sessionNumber - b.sessionNumber);
}

function mapSamplesToBenchmarkCases(
  samples: LoCoMoSample[],
  maxCases: number,
  maxDistractors: number
): BenchmarkCase[] {
  const cases: BenchmarkCase[] = [];

  for (const sample of samples) {
    if (cases.length >= maxCases) break;

    const sampleId = typeof sample.sample_id === 'string' ? sample.sample_id : 'unknown-sample';
    const sessions = extractSessions(sample.conversation);
    const qaItems = Array.isArray(sample.qa) ? sample.qa : [];
    const sessionByNumber = new Map<number, SessionRecord>(
      sessions.map((session) => [session.sessionNumber, session])
    );

    for (let qaIndex = 0; qaIndex < qaItems.length && cases.length < maxCases; qaIndex += 1) {
      const qa = qaItems[qaIndex];
      const question = typeof qa.question === 'string' ? qa.question.trim() : '';
      const evidence = Array.isArray(qa.evidence) ? qa.evidence.filter(Boolean) : [];
      if (!question || evidence.length === 0) continue;

      const evidenceIds = new Set(evidence);
      const evidenceSessionNumbers = new Set<number>();
      for (const diaId of evidence) {
        const match = /^D(\d+):/.exec(diaId);
        if (match) evidenceSessionNumbers.add(Number(match[1]));
      }
      if (evidenceSessionNumbers.size === 0) continue;

      const targetSessions = [...evidenceSessionNumbers]
        .map((num) => sessionByNumber.get(num) || null)
        .filter((session): session is SessionRecord => !!session)
        .map((session) => formatSession(session, evidenceIds))
        .filter((text): text is string => !!text);

      if (targetSessions.length === 0) continue;

      const distractors = sessions
        .filter((session) => !evidenceSessionNumbers.has(session.sessionNumber))
        .map((session) => formatSession(session, new Set<string>()))
        .filter((text): text is string => !!text);

      if (distractors.length === 0) continue;

      cases.push({
        id: `${sampleId}-qa-${qaIndex + 1}`,
        query: question,
        targetContent: targetSessions.join('\n\n---\n\n'),
        distractors: clampArray(distractors, maxDistractors),
        provenance: `locomo:${sampleId}:category-${qa.category ?? 'unknown'}`,
      });
    }
  }

  return cases;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`LoCoMo download failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

async function loadSourceJson(): Promise<unknown> {
  const localPath = process.env.LOCOMO_DATASET_PATH;
  if (localPath) {
    const raw = await readFile(localPath, 'utf-8');
    return JSON.parse(raw);
  }

  const url = process.env.LOCOMO_DATASET_URL || DEFAULT_LOCOMO_URL;
  return fetchJson(url);
}

export async function loadLoCoMoDataset(): Promise<{
  cases: BenchmarkCase[];
  source: string;
}> {
  const limit = parsePositiveInt(process.env.LOCOMO_LIMIT, 200);
  const maxDistractors = parsePositiveInt(process.env.LOCOMO_MAX_DISTRACTORS, 5);
  const raw = await loadSourceJson();

  if (!Array.isArray(raw)) {
    throw new Error('LoCoMo dataset must be a JSON array of conversation samples.');
  }

  const cases = mapSamplesToBenchmarkCases(raw as LoCoMoSample[], limit, maxDistractors);
  if (cases.length === 0) {
    throw new Error('LoCoMo dataset loaded but produced 0 benchmark cases.');
  }

  return {
    cases,
    source: process.env.LOCOMO_DATASET_PATH
      ? `file:${process.env.LOCOMO_DATASET_PATH}`
      : `url:${process.env.LOCOMO_DATASET_URL || DEFAULT_LOCOMO_URL}`,
  };
}
