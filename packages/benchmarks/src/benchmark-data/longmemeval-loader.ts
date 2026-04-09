import { readFile } from 'node:fs/promises';
import type { BenchmarkCase } from './datasets';

const DEFAULT_LONGMEMEVAL_URL =
  'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json';

type LongMemEvalTurn = {
  role?: string;
  content?: string;
  has_answer?: boolean;
};

type LongMemEvalInstance = {
  question_id?: string;
  question_type?: string;
  question?: string;
  answer?: string;
  question_date?: string;
  haystack_session_ids?: string[];
  haystack_sessions?: LongMemEvalTurn[][];
  answer_session_ids?: string[];
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

function formatSession(turns: LongMemEvalTurn[]): string {
  return turns
    .map((turn) => {
      const role = typeof turn.role === 'string' ? turn.role : 'unknown';
      const content = typeof turn.content === 'string' ? turn.content.trim() : '';
      if (!content) return null;
      return `${role}: ${content}`;
    })
    .filter((line): line is string => !!line)
    .join('\n');
}

function buildTargetContent(instance: LongMemEvalInstance): string | null {
  const sessionIds = Array.isArray(instance.haystack_session_ids) ? instance.haystack_session_ids : [];
  const sessions = Array.isArray(instance.haystack_sessions) ? instance.haystack_sessions : [];
  const answerIds = new Set(Array.isArray(instance.answer_session_ids) ? instance.answer_session_ids : []);

  const matched = sessionIds
    .map((sessionId, idx) => ({
      sessionId,
      turns: sessions[idx] || [],
    }))
    .filter(({ sessionId }) => answerIds.has(sessionId))
    .map(({ sessionId, turns }) => {
      const formatted = formatSession(turns);
      return formatted ? `session ${sessionId}\n${formatted}` : null;
    })
    .filter((text): text is string => !!text);

  if (matched.length === 0) return null;
  return matched.join('\n\n---\n\n');
}

function buildDistractors(instance: LongMemEvalInstance, maxDistractors: number): string[] {
  const sessionIds = Array.isArray(instance.haystack_session_ids) ? instance.haystack_session_ids : [];
  const sessions = Array.isArray(instance.haystack_sessions) ? instance.haystack_sessions : [];
  const answerIds = new Set(Array.isArray(instance.answer_session_ids) ? instance.answer_session_ids : []);

  const distractors = sessionIds
    .map((sessionId, idx) => ({
      sessionId,
      turns: sessions[idx] || [],
    }))
    .filter(({ sessionId }) => !answerIds.has(sessionId))
    .map(({ sessionId, turns }) => {
      const formatted = formatSession(turns);
      return formatted ? `session ${sessionId}\n${formatted}` : null;
    })
    .filter((text): text is string => !!text);

  return clampArray(distractors, maxDistractors);
}

function mapInstancesToBenchmarkCases(
  instances: LongMemEvalInstance[],
  maxCases: number,
  maxDistractors: number
): BenchmarkCase[] {
  const cases: BenchmarkCase[] = [];

  for (const instance of instances) {
    if (cases.length >= maxCases) break;
    const id = typeof instance.question_id === 'string' ? instance.question_id : null;
    const query = typeof instance.question === 'string' ? instance.question.trim() : null;
    if (!id || !query) continue;

    const targetContent = buildTargetContent(instance);
    if (!targetContent) continue;

    const distractors = buildDistractors(instance, maxDistractors);
    if (distractors.length === 0) continue;

    cases.push({
      id,
      query,
      targetContent,
      distractors,
      provenance: `longmemeval:${instance.question_type || 'unknown'}:${instance.question_date || 'unknown-date'}`,
    });
  }

  return cases;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`LongMemEval download failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

async function loadSourceJson(): Promise<unknown> {
  const localPath = process.env.LONGMEMEVAL_DATASET_PATH;
  if (localPath) {
    const raw = await readFile(localPath, 'utf-8');
    return JSON.parse(raw);
  }

  const url = process.env.LONGMEMEVAL_DATASET_URL || DEFAULT_LONGMEMEVAL_URL;
  return fetchJson(url);
}

export async function loadLongMemEvalDataset(): Promise<{
  cases: BenchmarkCase[];
  source: string;
}> {
  const limit = parsePositiveInt(process.env.LONGMEMEVAL_LIMIT, 100);
  const maxDistractors = parsePositiveInt(process.env.LONGMEMEVAL_MAX_DISTRACTORS, 5);
  const raw = await loadSourceJson();
  if (!Array.isArray(raw)) {
    throw new Error('LongMemEval dataset must be a JSON array of evaluation instances.');
  }

  const cases = mapInstancesToBenchmarkCases(raw as LongMemEvalInstance[], limit, maxDistractors);
  if (cases.length === 0) {
    throw new Error('LongMemEval dataset loaded but produced 0 benchmark cases.');
  }

  return {
    cases,
    source: process.env.LONGMEMEVAL_DATASET_PATH
      ? `file:${process.env.LONGMEMEVAL_DATASET_PATH}`
      : `url:${process.env.LONGMEMEVAL_DATASET_URL || DEFAULT_LONGMEMEVAL_URL}`,
  };
}
