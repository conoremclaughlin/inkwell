/**
 * Real-scenario memory eval — live PCP integration.
 *
 * Runs the bundled fixtures against the running PCP server's `recall` tool
 * and asserts that the curated memory set supports each scenario's rubric.
 *
 * Two query modes:
 * - keyword: extractTopicSignal bag-of-words (current passive recall)
 * - llm: LLM-constructed natural language query (experiment)
 *
 * Run with:
 *   INK_SERVER_URL=http://localhost:3001 npx vitest run src/repl/real-scenarios/runner.integration.test.ts
 *   ANTHROPIC_API_KEY=... INK_SERVER_URL=http://localhost:3001 npx vitest run src/repl/real-scenarios/runner.integration.test.ts
 */

import { describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { runScenario, type RecallFn, type QueryMode } from './runner.js';
import { loadScenariosFromDir, defaultFixturesDir } from './loader.js';
import { writeMarkdownReport } from './report.js';
import { createLlmQueryFn } from './llm-query.js';
import type { SurfacedMemory } from './scorer.js';
import type { ScenarioResult } from './types.js';

const PCP_URL = process.env.INK_SERVER_URL || 'http://localhost:3001';
const HAS_ANTHROPIC_KEY = Boolean(process.env.ANTHROPIC_API_KEY);

let serverAvailable = false;
try {
  const result = execSync(`curl -sf -m 2 ${PCP_URL}/health`, { encoding: 'utf-8' });
  serverAvailable = result.includes('"status":"healthy"');
} catch {
  serverAvailable = false;
}

interface RecallMemory {
  id: string;
  content: string;
  summary: string | null;
}

interface RecallResponse {
  success: boolean;
  count: number;
  memories: RecallMemory[];
}

async function pcpRecall(
  query: string,
  limit: number,
  extraArgs: Record<string, unknown> = {}
): Promise<SurfacedMemory[]> {
  const authPath = `${process.env.HOME}/.ink/auth.json`;
  const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
  const accessToken = auth.accessToken || auth.access_token;
  if (!accessToken) throw new Error(`No access token at ${authPath}`);

  const resp = await fetch(`${PCP_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'recall',
        arguments: {
          query,
          agentId: 'wren',
          includeShared: true,
          limit,
          recallMode: 'hybrid',
          ...extraArgs,
        },
      },
    }),
  });

  if (!resp.ok) throw new Error(`recall HTTP ${resp.status}`);
  const raw = await resp.text();
  const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
  if (!dataLine) throw new Error('no SSE data line in recall response');
  const rpc = JSON.parse(dataLine.slice(6)) as {
    result?: { content?: Array<{ text: string }> };
  };
  const text = rpc.result?.content?.[0]?.text;
  if (!text) throw new Error('empty recall response body');
  const parsed = JSON.parse(text) as RecallResponse;
  return parsed.memories.map((m) => ({ id: m.id, content: m.content, summary: m.summary }));
}

const recall: RecallFn = (query, limit) => pcpRecall(query, limit);
const recallWithIntent: (intent: string) => RecallFn = (intent) => (query, limit) =>
  pcpRecall(query, limit, { recallIntent: intent });

function printComparisonTable(
  keywordResults: ScenarioResult[],
  llmResults: ScenarioResult[]
): void {
  console.log('\n## Query Mode Comparison: keyword vs LLM\n');
  console.log('| Scenario | KW Prec | KW Rec | KW Pass | LLM Prec | LLM Rec | LLM Pass | Winner |');
  console.log('|---|---|---|---|---|---|---|---|');

  let kwWins = 0;
  let llmWins = 0;
  let ties = 0;

  for (let i = 0; i < keywordResults.length; i++) {
    const kw = keywordResults[i];
    const llm = llmResults[i];

    const kwF1 =
      kw.metrics.precision + kw.metrics.recall > 0
        ? (2 * kw.metrics.precision * kw.metrics.recall) /
          (kw.metrics.precision + kw.metrics.recall)
        : 0;
    const llmF1 =
      llm.metrics.precision + llm.metrics.recall > 0
        ? (2 * llm.metrics.precision * llm.metrics.recall) /
          (llm.metrics.precision + llm.metrics.recall)
        : 0;

    let winner: string;
    if (llmF1 > kwF1 + 0.01) {
      winner = 'LLM';
      llmWins++;
    } else if (kwF1 > llmF1 + 0.01) {
      winner = 'KW';
      kwWins++;
    } else {
      winner = 'TIE';
      ties++;
    }

    console.log(
      `| ${kw.scenarioId} | ${pct(kw.metrics.precision)} | ${pct(kw.metrics.recall)} | ${kw.passed ? 'Y' : 'N'} | ${pct(llm.metrics.precision)} | ${pct(llm.metrics.recall)} | ${llm.passed ? 'Y' : 'N'} | ${winner} |`
    );
  }

  const avgKwP = avg(keywordResults.map((r) => r.metrics.precision));
  const avgKwR = avg(keywordResults.map((r) => r.metrics.recall));
  const avgLlmP = avg(llmResults.map((r) => r.metrics.precision));
  const avgLlmR = avg(llmResults.map((r) => r.metrics.recall));
  const kwPassRate = keywordResults.filter((r) => r.passed).length;
  const llmPassRate = llmResults.filter((r) => r.passed).length;

  console.log(`\n**Aggregates:**`);
  console.log(
    `- Keyword: precision=${pct(avgKwP)}, recall=${pct(avgKwR)}, passed=${kwPassRate}/${keywordResults.length}`
  );
  console.log(
    `- LLM:     precision=${pct(avgLlmP)}, recall=${pct(avgLlmR)}, passed=${llmPassRate}/${llmResults.length}`
  );
  console.log(`- Wins: KW=${kwWins}, LLM=${llmWins}, TIE=${ties}`);

  console.log('\n### Query Comparison\n');
  for (let i = 0; i < keywordResults.length; i++) {
    console.log(`**${keywordResults[i].scenarioId}**`);
    console.log(`  KW:  "${keywordResults[i].topicSignal}"`);
    console.log(`  LLM: "${llmResults[i].topicSignal}"`);
  }
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

describe('real-scenarios: live PCP', () => {
  it.skipIf(!serverAvailable)(
    'keyword mode — runs all bundled fixtures and reports results',
    { timeout: 60_000 },
    async () => {
      const scenarios = loadScenariosFromDir(defaultFixturesDir());
      expect(scenarios.length).toBeGreaterThan(0);

      const results = [];
      for (const scenario of scenarios) {
        const result = await runScenario(scenario, recall);
        results.push(result);
      }

      const report = writeMarkdownReport(results, {
        title: 'Real-Scenario Eval — keyword mode (live PCP)',
      });
      console.log('\n' + report + '\n');

      const supported = results.filter(
        (r) => !r.failureReasons.some((f) => /not yet implemented/.test(f))
      );
      expect(supported.length).toBeGreaterThan(0);
      for (const r of supported) {
        expect(r.surfacedCount, `${r.scenarioId} surfaced zero memories`).toBeGreaterThan(0);
      }

      const passed = supported.filter((r) => r.passed).length;
      const passRate = supported.length === 0 ? 0 : passed / supported.length;
      console.log(`Pass rate: ${passed}/${supported.length} (${(passRate * 100).toFixed(0)}%)`);
    }
  );

  it.skipIf(!serverAvailable || !HAS_ANTHROPIC_KEY)(
    'keyword vs LLM comparison benchmark',
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

      const llmQueryFn = createLlmQueryFn();

      const keywordResults: ScenarioResult[] = [];
      const llmResults: ScenarioResult[] = [];

      for (const scenario of supported) {
        const kwResult = await runScenario(scenario, recall, { queryMode: 'keyword' });
        keywordResults.push(kwResult);

        const llmResult = await runScenario(scenario, recall, {
          queryMode: 'llm',
          llmQueryFn,
        });
        llmResults.push(llmResult);
      }

      printComparisonTable(keywordResults, llmResults);

      // Both modes should surface something for each scenario
      for (const r of keywordResults) {
        expect(r.surfacedCount, `keyword: ${r.scenarioId} surfaced zero`).toBeGreaterThan(0);
      }
      for (const r of llmResults) {
        expect(r.surfacedCount, `llm: ${r.scenarioId} surfaced zero`).toBeGreaterThan(0);
      }
    }
  );

  it.skipIf(!serverAvailable)(
    'recallIntent comparison: default vs knowledge',
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

      const defaultResults: ScenarioResult[] = [];
      const knowledgeResults: ScenarioResult[] = [];

      for (const scenario of supported) {
        const defaultResult = await runScenario(scenario, recall);
        defaultResults.push(defaultResult);

        const knowledgeResult = await runScenario(scenario, recallWithIntent('knowledge'));
        knowledgeResults.push(knowledgeResult);
      }

      console.log('\n## recallIntent Comparison: default vs knowledge\n');
      console.log(
        '| Scenario | Def Prec | Def Rec | Def Pass | Know Prec | Know Rec | Know Pass | Winner |'
      );
      console.log('|---|---|---|---|---|---|---|---|');

      let defWins = 0;
      let knowWins = 0;
      let ties = 0;

      for (let i = 0; i < defaultResults.length; i++) {
        const def = defaultResults[i];
        const know = knowledgeResults[i];

        const defF1 =
          def.metrics.precision + def.metrics.recall > 0
            ? (2 * def.metrics.precision * def.metrics.recall) /
              (def.metrics.precision + def.metrics.recall)
            : 0;
        const knowF1 =
          know.metrics.precision + know.metrics.recall > 0
            ? (2 * know.metrics.precision * know.metrics.recall) /
              (know.metrics.precision + know.metrics.recall)
            : 0;

        let winner: string;
        if (knowF1 > defF1 + 0.01) {
          winner = 'KNOW';
          knowWins++;
        } else if (defF1 > knowF1 + 0.01) {
          winner = 'DEF';
          defWins++;
        } else {
          winner = 'TIE';
          ties++;
        }

        console.log(
          `| ${def.scenarioId} | ${pct(def.metrics.precision)} | ${pct(def.metrics.recall)} | ${def.passed ? 'Y' : 'N'} | ${pct(know.metrics.precision)} | ${pct(know.metrics.recall)} | ${know.passed ? 'Y' : 'N'} | ${winner} |`
        );
      }

      const avgDefP = avg(defaultResults.map((r) => r.metrics.precision));
      const avgDefR = avg(defaultResults.map((r) => r.metrics.recall));
      const avgKnowP = avg(knowledgeResults.map((r) => r.metrics.precision));
      const avgKnowR = avg(knowledgeResults.map((r) => r.metrics.recall));
      const defPassRate = defaultResults.filter((r) => r.passed).length;
      const knowPassRate = knowledgeResults.filter((r) => r.passed).length;

      console.log(`\n**Aggregates:**`);
      console.log(
        `- Default:   precision=${pct(avgDefP)}, recall=${pct(avgDefR)}, passed=${defPassRate}/${defaultResults.length}`
      );
      console.log(
        `- Knowledge: precision=${pct(avgKnowP)}, recall=${pct(avgKnowR)}, passed=${knowPassRate}/${knowledgeResults.length}`
      );
      console.log(`- Wins: DEF=${defWins}, KNOW=${knowWins}, TIE=${ties}`);

      for (const r of defaultResults) {
        expect(r.surfacedCount, `default: ${r.scenarioId} surfaced zero`).toBeGreaterThan(0);
      }
      for (const r of knowledgeResults) {
        expect(r.surfacedCount, `knowledge: ${r.scenarioId} surfaced zero`).toBeGreaterThan(0);
      }
    }
  );
});
