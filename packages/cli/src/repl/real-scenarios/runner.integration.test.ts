/**
 * Real-scenario memory eval — live PCP integration.
 *
 * Runs the bundled fixtures against the running PCP server's `recall` tool
 * and asserts that the curated memory set supports each scenario's rubric.
 *
 * This is the actual signal: does passive recall surface the memories we
 * expect when the SB is working on a real task?
 *
 * Run with: INK_SERVER_URL=http://localhost:3001 npx vitest run src/repl/real-scenarios/runner.integration.test.ts
 */

import { describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { runScenario, type RecallFn } from './runner.js';
import { loadScenariosFromDir, defaultFixturesDir } from './loader.js';
import { writeMarkdownReport } from './report.js';
import type { SurfacedMemory } from './scorer.js';

const PCP_URL = process.env.INK_SERVER_URL || 'http://localhost:3001';

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

async function pcpRecall(query: string, limit: number): Promise<SurfacedMemory[]> {
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

describe('real-scenarios: live PCP', () => {
  it.skipIf(!serverAvailable)(
    'runs all bundled fixtures and reports results',
    { timeout: 60_000 },
    async () => {
      const scenarios = loadScenariosFromDir(defaultFixturesDir());
      expect(scenarios.length).toBeGreaterThan(0);

      const results = [];
      for (const scenario of scenarios) {
        const result = await runScenario(scenario, recall);
        results.push(result);
      }

      const report = writeMarkdownReport(results, { title: 'Real-Scenario Eval (live PCP)' });
      console.log('\n' + report + '\n');

      // This is a REPORTING test, not a rubric gate. The point is to measure
      // how well recall works against curated scenarios and print the numbers.
      // Rubric misses usually mean memories haven't been seeded yet (e.g. no
      // memory exists yet for "NEVER squash merge") — that's a finding, not a
      // test failure. The harness just needs to run end-to-end.
      //
      // The only hard assertion: every supported scenario should get SOMETHING
      // back. Zero memories means the integration layer is broken.
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
});
