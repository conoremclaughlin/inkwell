/**
 * Recall curation — live PCP integration.
 *
 * Exercises the full recall → score → curate_recall pipeline:
 * 1. Run scenario (which calls recall internally with its topicSignal)
 * 2. Score the results against the scenario rubric
 * 3. Programmatically accept/dismiss based on scoring
 * 4. Optionally call curate_recall to persist the feedback
 * 5. Print a curation report with score distribution
 *
 * Persistence is OPT-IN: set CURATE_PERSIST=true to write recall_feedback
 * rows. Without it, the test scores and reports but does not persist.
 *
 * Run with:
 *   INK_SERVER_URL=http://localhost:3001 npx vitest run src/repl/real-scenarios/curation.integration.test.ts
 *   CURATE_PERSIST=true INK_SERVER_URL=http://localhost:3001 npx vitest run src/repl/real-scenarios/curation.integration.test.ts
 */

import { describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { runScenario, type RecallFn } from './runner.js';
import { loadScenariosFromDir, defaultFixturesDir } from './loader.js';
import type { ScenarioResult } from './types.js';

const PCP_URL = process.env.INK_SERVER_URL || 'http://localhost:3001';
const AGENT_ID = process.env.AGENT_ID || 'wren';
const PERSIST_ENABLED = process.env.CURATE_PERSIST === 'true';

let serverAvailable = false;
let curateToolAvailable = false;
try {
  const result = execSync(`curl -sf -m 2 ${PCP_URL}/health`, { encoding: 'utf-8' });
  serverAvailable = result.includes('"status":"healthy"');
} catch {
  serverAvailable = false;
}

if (serverAvailable && PERSIST_ENABLED) {
  try {
    const authPath = `${process.env.HOME}/.ink/auth.json`;
    const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
    const token = auth.accessToken || auth.access_token;
    const resp = execSync(
      `curl -sf -m 5 ${PCP_URL}/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'Authorization: Bearer ${token}' -d '${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'curate_recall', arguments: { query: 'probe', accepted: [], dismissed: [], agentId: 'wren' } } })}'`,
      { encoding: 'utf-8' }
    );
    curateToolAvailable = !resp.includes('Tool curate_recall not found');
  } catch {
    curateToolAvailable = false;
  }
}

interface ScoredRecallMemory {
  id: string;
  content: string;
  summary: string | null;
  scores?: {
    semantic: number | null;
    text: number | null;
    final: number;
  };
}

interface RecallResponse {
  success: boolean;
  count: number;
  memories: ScoredRecallMemory[];
}

interface CurateEntry {
  memoryId: string;
  semanticScore?: number;
  textScore?: number;
  finalScore?: number;
}

interface CurateResponse {
  success: boolean;
  feedbackSaved: number;
  dismissedMemoryIds: string[];
}

function getAccessToken(): string {
  const authPath = `${process.env.HOME}/.ink/auth.json`;
  const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
  const accessToken = auth.accessToken || auth.access_token;
  if (!accessToken) throw new Error(`No access token at ${authPath}`);
  return accessToken;
}

async function mcpCall<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`${PCP_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${getAccessToken()}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });

  if (!resp.ok) throw new Error(`${toolName} HTTP ${resp.status}`);
  const raw = await resp.text();
  const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
  if (!dataLine) throw new Error(`no SSE data line in ${toolName} response`);
  const rpc = JSON.parse(dataLine.slice(6)) as {
    result?: { content?: Array<{ text: string }> };
  };
  const text = rpc.result?.content?.[0]?.text;
  if (!text) throw new Error(`empty ${toolName} response body`);
  return JSON.parse(text) as T;
}

async function pcpRecallWithScores(query: string, limit: number): Promise<ScoredRecallMemory[]> {
  const parsed = await mcpCall<RecallResponse>('recall', {
    query,
    agentId: AGENT_ID,
    includeShared: true,
    limit,
    recallMode: 'hybrid',
  });
  return parsed.memories;
}

async function pcpCurateRecall(
  query: string,
  accepted: CurateEntry[],
  dismissed: CurateEntry[]
): Promise<CurateResponse> {
  return mcpCall<CurateResponse>('curate_recall', {
    query,
    accepted,
    dismissed,
    agentId: AGENT_ID,
  });
}

interface CurationStats {
  scenarioId: string;
  topicSignal: string;
  totalSurfaced: number;
  accepted: number;
  dismissed: number;
  acceptedScores: number[];
  dismissedScores: number[];
  feedbackSaved: number;
  passed: boolean;
}

function classifyMemories(
  result: ScenarioResult,
  scored: ScoredRecallMemory[]
): { accepted: CurateEntry[]; dismissed: CurateEntry[] } {
  const matchedIds = new Set(result.surfaced.filter((s) => s.matchedExpectedRef).map((s) => s.id));

  const accepted: CurateEntry[] = [];
  const dismissed: CurateEntry[] = [];

  for (const mem of scored) {
    const entry: CurateEntry = {
      memoryId: mem.id,
      semanticScore: mem.scores?.semantic ?? undefined,
      textScore: mem.scores?.text ?? undefined,
      finalScore: mem.scores?.final,
    };

    if (matchedIds.has(mem.id)) {
      accepted.push(entry);
    } else {
      dismissed.push(entry);
    }
  }

  return { accepted, dismissed };
}

describe('real-scenarios: recall curation (live PCP)', () => {
  it.skipIf(!serverAvailable)(
    'recall → score → curate pipeline for all fixtures',
    { timeout: 120_000 },
    async () => {
      const scenarios = loadScenariosFromDir(defaultFixturesDir());
      const supported = scenarios.filter(
        (s) =>
          !['topic-shift', 're-entry', 'concurrent-threads', 'post-compaction-continuity'].includes(
            s.shape
          )
      );
      expect(supported.length).toBeGreaterThan(0);

      const allStats: CurationStats[] = [];

      for (const scenario of supported) {
        // 1. Score against rubric — runner calls recallFn internally with its topicSignal
        const lastScoredResults: ScoredRecallMemory[] = [];
        let lastQuery = '';

        const scoredRecallFn: RecallFn = async (query, limit) => {
          lastQuery = query;
          const memories = await pcpRecallWithScores(query, limit);
          lastScoredResults.length = 0;
          lastScoredResults.push(...memories);
          return memories.map((m) => ({ id: m.id, content: m.content, summary: m.summary }));
        };

        const result = await runScenario(scenario, scoredRecallFn);

        // 2. Classify using the same recall results the scorer used
        const { accepted, dismissed } = classifyMemories(result, lastScoredResults);

        // 3. Optionally persist via curate_recall (same query the runner used)
        let feedbackSaved = 0;
        if (PERSIST_ENABLED && curateToolAvailable && accepted.length + dismissed.length > 0) {
          const curationResult = await pcpCurateRecall(lastQuery, accepted, dismissed);
          expect(curationResult.success).toBe(true);
          expect(curationResult.dismissedMemoryIds).toHaveLength(dismissed.length);
          feedbackSaved = curationResult.feedbackSaved;
        }

        const hasScores = lastScoredResults.some((m) => m.scores !== undefined);

        allStats.push({
          scenarioId: scenario.id,
          topicSignal: lastQuery,
          totalSurfaced: lastScoredResults.length,
          accepted: accepted.length,
          dismissed: dismissed.length,
          acceptedScores: hasScores ? accepted.map((a) => a.finalScore ?? 0) : [],
          dismissedScores: hasScores ? dismissed.map((d) => d.finalScore ?? 0) : [],
          feedbackSaved,
          passed: result.passed,
        });
      }

      // Print curation report
      if (!PERSIST_ENABLED) {
        console.log('\n(dry run — set CURATE_PERSIST=true to write recall_feedback rows)\n');
      } else if (!curateToolAvailable) {
        console.log(
          '\ncurate_recall tool not available on server — scoring only, no feedback persisted\n'
        );
      }
      console.log('\n## Recall Curation Report\n');
      console.log(
        '| Scenario | Surfaced | Accepted | Dismissed | Avg Accepted Score | Avg Dismissed Score | Rubric |'
      );
      console.log('|---|---|---|---|---|---|---|');

      for (const s of allStats) {
        const avgAccepted =
          s.acceptedScores.length > 0
            ? (s.acceptedScores.reduce((a, b) => a + b, 0) / s.acceptedScores.length).toFixed(3)
            : '—';
        const avgDismissed =
          s.dismissedScores.length > 0
            ? (s.dismissedScores.reduce((a, b) => a + b, 0) / s.dismissedScores.length).toFixed(3)
            : '—';

        console.log(
          `| ${s.scenarioId} | ${s.totalSurfaced} | ${s.accepted} | ${s.dismissed} | ${avgAccepted} | ${avgDismissed} | ${s.passed ? 'PASS' : 'FAIL'} |`
        );
      }

      // Score distribution
      const allAccepted = allStats.flatMap((s) => s.acceptedScores);
      const allDismissed = allStats.flatMap((s) => s.dismissedScores);
      const meanAccepted =
        allAccepted.length > 0 ? allAccepted.reduce((a, b) => a + b, 0) / allAccepted.length : 0;
      const meanDismissed =
        allDismissed.length > 0 ? allDismissed.reduce((a, b) => a + b, 0) / allDismissed.length : 0;

      console.log(
        `\nAggregate: ${allAccepted.length} accepted (mean score ${meanAccepted.toFixed(3)}), ${allDismissed.length} dismissed (mean score ${meanDismissed.toFixed(3)})`
      );
      console.log(`Score gap (accepted - dismissed): ${(meanAccepted - meanDismissed).toFixed(3)}`);

      const totalFeedback = allStats.reduce((sum, s) => sum + s.feedbackSaved, 0);
      console.log(`Total feedback rows saved: ${totalFeedback}\n`);

      // Hard assertions: pipeline ran end-to-end
      expect(allStats.length).toBeGreaterThan(0);
      for (const s of allStats) {
        expect(s.totalSurfaced, `${s.scenarioId} surfaced zero memories`).toBeGreaterThan(0);
      }
      if (PERSIST_ENABLED && curateToolAvailable) {
        for (const s of allStats) {
          expect(s.feedbackSaved, `${s.scenarioId} feedback not saved`).toBeGreaterThan(0);
        }
      }
    }
  );
});
