/**
 * Passive Recall Relevance Benchmark
 *
 * Tests whether passive recall surfaces the RIGHT memories — not just any memories.
 * Uses curated conversation/memory pairs where we know what should be recalled.
 *
 * Three categories:
 * 1. Relevance precision — does it return useful memories for the topic?
 * 2. Topic drift — does it shift when the conversation shifts?
 * 3. Noise ratio — how often does it inject irrelevant content?
 *
 * Run with: PCP_SERVER_URL=http://localhost:3001 npx vitest run -c vitest.integration.config.ts packages/cli/src/repl/passive-recall-benchmark.integration.test.ts
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import { ContextLedger } from './context-ledger.js';
import { SbHookRegistry, type HookResult, type HookRuntimeState } from './hook-registry.js';
import { readFileSync } from 'fs';

// ─── PCP Client ─────────────────────────────────────────────────

const PCP_URL = process.env.PCP_SERVER_URL || 'http://localhost:3001';

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
  source: string;
  salience: string;
  topics: string[];
  agentId: string | null;
  createdAt: string;
}

interface RecallResponse {
  success: boolean;
  count: number;
  memories: RecallMemory[];
}

async function pcpRecall(
  query: string,
  options?: { limit?: number; agentId?: string; recallMode?: string }
): Promise<RecallResponse> {
  const authPath = `${process.env.HOME}/.pcp/auth.json`;
  let accessToken: string;
  try {
    const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
    accessToken = auth.accessToken || auth.access_token;
    if (!accessToken) throw new Error('No access token');
  } catch {
    throw new Error(`Cannot read PCP auth from ${authPath}`);
  }

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
          agentId: options?.agentId || 'wren',
          includeShared: true,
          limit: options?.limit || 5,
          recallMode: options?.recallMode || 'hybrid',
        },
      },
    }),
  });

  if (!resp.ok) throw new Error(`PCP recall failed: ${resp.status}`);
  const raw = await resp.text();
  const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
  if (!dataLine) throw new Error('No SSE data line');
  const rpc = JSON.parse(dataLine.slice(6)) as { result?: { content?: Array<{ text: string }> } };
  const text = rpc.result?.content?.[0]?.text;
  if (!text) throw new Error('Empty recall response');
  return JSON.parse(text) as RecallResponse;
}

// ─── Topic signal extraction ────────────────────────────────────

function extractTopicSignal(userInput: string, assistantResponse: string): string {
  const stripped = [userInput, assistantResponse]
    .join(' ')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\{[\s\S]*?\}/g, '')
    .replace(/https?:\/\/\S+/g, '');

  const stopWords = new Set([
    'the',
    'and',
    'for',
    'are',
    'but',
    'not',
    'you',
    'all',
    'can',
    'had',
    'her',
    'was',
    'one',
    'our',
    'out',
    'has',
    'have',
    'been',
    'would',
    'could',
    'should',
    'will',
    'just',
    'this',
    'that',
    'with',
    'from',
    'they',
    'were',
    'what',
    'when',
    'make',
    'like',
    'time',
    'very',
    'your',
    'know',
    'about',
    'some',
    'them',
    'than',
    'then',
    'into',
    'also',
    'more',
    'here',
    'there',
    'does',
    'don',
    'let',
  ]);

  const tokens = stripped
    .toLowerCase()
    .split(/[\s,.;:!?()\[\]]+/)
    .filter((t) => t.length >= 3 && !stopWords.has(t));

  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([token]) => token)
    .join(' ')
    .slice(0, 200);
}

// ─── Benchmark scenarios ────────────────────────────────────────

interface BenchmarkScenario {
  name: string;
  /** Simulated conversation turn */
  userInput: string;
  assistantResponse: string;
  /** Keywords that SHOULD appear in recalled memories */
  expectedKeywords: string[];
  /** Keywords that should NOT appear (wrong topic) */
  unexpectedKeywords?: string[];
}

const SCENARIOS: BenchmarkScenario[] = [
  {
    name: 'Session routing debugging',
    userInput:
      'The trigger to Lumen failed again. How does session routing work for triggered agents?',
    assistantResponse:
      'When send_to_inbox triggers an agent, the server resolves the recipient studio and spawns a backend session. The trigger includes the thread key for conversation continuity.',
    expectedKeywords: ['session', 'routing', 'trigger', 'studio'],
    unexpectedKeywords: ['calendar', 'kindle', 'whatsapp'],
  },
  {
    name: 'Context window management',
    userInput:
      'Myra has been running for 5 days and her context window is degraded. What do we know about compaction issues?',
    assistantResponse:
      'Context compaction can evict MCP tool schemas from the model awareness. The tool definitions are supposed to survive compaction but they get swept up with old conversation turns.',
    expectedKeywords: ['compaction', 'context', 'schema', 'tool'],
    unexpectedKeywords: ['calendar', 'kindle', 'billing'],
  },
  {
    name: 'Multi-agent collaboration',
    userInput:
      'How has the cross-agent review process worked so far? What did we learn from Lumen reviewing our PRs?',
    assistantResponse:
      'The first real cross-agent code review was PR #11 where Lumen caught a concurrency bug in the stateless transport. Complementary perspectives work well — Lumen thinks about request isolation from the Codex side.',
    expectedKeywords: ['review', 'lumen', 'agent'],
    unexpectedKeywords: ['kindle', 'whatsapp', 'calendar'],
  },
  {
    name: 'MCP authentication flow',
    userInput: 'How does our MCP auth work? I thought we moved to self-issued JWTs.',
    assistantResponse:
      'Yes, MCP access tokens are self-signed with JWT_SECRET, 30-day expiry. Supabase is only used for initial identity verification during login. The refresh is a local jwt.sign, no network call.',
    expectedKeywords: ['jwt', 'auth', 'token'],
    unexpectedKeywords: ['calendar', 'kindle'],
  },
  {
    name: 'Task management system',
    userInput: 'We just built the tasks dashboard. What was the design for task groups?',
    assistantResponse:
      'Task groups are autonomous work packages with their own sessions budget. They can be scoped to a project and assigned to an agent. The dashboard nests tasks under their groups.',
    expectedKeywords: ['task'],
    unexpectedKeywords: ['calendar', 'kindle'],
  },
  {
    name: 'Heartbeat and session continuity',
    userInput: 'How should heartbeat sessions work for long-lived agents like Myra?',
    assistantResponse:
      'Myra runs continuously on Telegram. The heartbeat service spawns sessions periodically to check inbox, emails, and reminders. The challenge is session continuity — context compaction can break tool availability mid-session.',
    expectedKeywords: ['heartbeat', 'myra', 'session'],
    unexpectedKeywords: ['kindle', 'billing'],
  },
];

// ─── Scoring helpers ────────────────────────────────────────────

function scoreRelevance(memories: RecallMemory[], expectedKeywords: string[]): number {
  if (memories.length === 0) return 0;
  const content = memories
    .map((m) => (m.content + ' ' + (m.summary || '')).toLowerCase())
    .join(' ');
  const hits = expectedKeywords.filter((kw) => content.includes(kw.toLowerCase()));
  return hits.length / expectedKeywords.length;
}

function scoreNoise(memories: RecallMemory[], unexpectedKeywords: string[]): number {
  if (memories.length === 0 || !unexpectedKeywords?.length) return 0;
  const content = memories
    .map((m) => (m.content + ' ' + (m.summary || '')).toLowerCase())
    .join(' ');
  const noise = unexpectedKeywords.filter((kw) => content.includes(kw.toLowerCase()));
  return noise.length / unexpectedKeywords.length;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('Passive recall: relevance benchmark', () => {
  it.skipIf(!serverAvailable)('scores relevance across all scenarios', async () => {
    const results: Array<{
      scenario: string;
      signal: string;
      memoryCount: number;
      relevance: number;
      noise: number;
      latencyMs: number;
      topMemoryPreview: string;
    }> = [];

    for (const scenario of SCENARIOS) {
      const signal = extractTopicSignal(scenario.userInput, scenario.assistantResponse);
      const start = performance.now();
      const recall = await pcpRecall(signal, { limit: 5 });
      const latency = performance.now() - start;

      const relevance = scoreRelevance(recall.memories, scenario.expectedKeywords);
      const noise = scoreNoise(recall.memories, scenario.unexpectedKeywords || []);

      results.push({
        scenario: scenario.name,
        signal: signal.slice(0, 60),
        memoryCount: recall.memories.length,
        relevance: Math.round(relevance * 100),
        noise: Math.round(noise * 100),
        latencyMs: Math.round(latency),
        topMemoryPreview: recall.memories[0]
          ? (recall.memories[0].summary || recall.memories[0].content).slice(0, 80)
          : '(none)',
      });
    }

    // Print results table
    console.log('\n=== Passive Recall Relevance Benchmark ===\n');
    for (const r of results) {
      console.log(`${r.scenario}`);
      console.log(`  signal:    "${r.signal}..."`);
      console.log(
        `  memories:  ${r.memoryCount}, relevance: ${r.relevance}%, noise: ${r.noise}%, latency: ${r.latencyMs}ms`
      );
      console.log(`  top match: "${r.topMemoryPreview}..."`);
      console.log('');
    }

    // Aggregate stats
    const avgRelevance = results.reduce((s, r) => s + r.relevance, 0) / results.length;
    const avgNoise = results.reduce((s, r) => s + r.noise, 0) / results.length;
    const avgLatency = results.reduce((s, r) => s + r.latencyMs, 0) / results.length;
    const scenariosWithMemories = results.filter((r) => r.memoryCount > 0).length;

    console.log('--- Aggregate ---');
    console.log(`  Scenarios with results: ${scenariosWithMemories}/${results.length}`);
    console.log(`  Avg relevance: ${avgRelevance.toFixed(0)}%`);
    console.log(`  Avg noise:     ${avgNoise.toFixed(0)}%`);
    console.log(`  Avg latency:   ${avgLatency.toFixed(0)}ms`);
    console.log('');

    // Assertions — these define "good enough"
    expect(scenariosWithMemories).toBeGreaterThanOrEqual(SCENARIOS.length * 0.8); // 80%+ scenarios return results
    expect(avgRelevance).toBeGreaterThan(40); // 40%+ keyword hit rate
    expect(avgNoise).toBeLessThan(30); // <30% noise
  });

  it.skipIf(!serverAvailable)(
    'topic drift: different topics return different memories',
    async () => {
      const topics = [
        {
          label: 'routing',
          input: 'session routing triggered agents studio resolution',
          assistantResponse:
            'The server resolves the studio for the target agent and spawns a backend session.',
        },
        {
          label: 'auth',
          input: 'MCP authentication JWT tokens self-issued',
          assistantResponse: 'Access tokens are self-signed JWTs with 30-day expiry.',
        },
        {
          label: 'heartbeat',
          input: 'heartbeat service Myra Telegram long-running sessions',
          assistantResponse:
            'The heartbeat service spawns periodic sessions to check inbox and reminders.',
        },
      ];

      const memoryIdSets: Map<string, Set<string>> = new Map();

      for (const topic of topics) {
        const signal = extractTopicSignal(topic.input, topic.assistantResponse);
        const recall = await pcpRecall(signal, { limit: 5 });
        memoryIdSets.set(topic.label, new Set(recall.memories.map((m) => m.id)));
      }

      // Calculate pairwise overlap
      const labels = [...memoryIdSets.keys()];
      let totalOverlap = 0;
      let pairCount = 0;

      console.log('\n=== Topic Drift: Memory Overlap ===\n');
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          const setA = memoryIdSets.get(labels[i])!;
          const setB = memoryIdSets.get(labels[j])!;
          const overlap = [...setA].filter((id) => setB.has(id)).length;
          const unionSize = new Set([...setA, ...setB]).size;
          const jaccardSimilarity = unionSize > 0 ? overlap / unionSize : 0;

          console.log(
            `  ${labels[i]} ↔ ${labels[j]}: ${overlap} shared, Jaccard=${(jaccardSimilarity * 100).toFixed(0)}%`
          );
          totalOverlap += jaccardSimilarity;
          pairCount++;
        }
      }

      const avgOverlap = totalOverlap / pairCount;
      console.log(`  Avg Jaccard similarity: ${(avgOverlap * 100).toFixed(0)}%\n`);

      // Different topics should return mostly different memories
      // Jaccard < 50% means they're reasonably distinct
      expect(avgOverlap).toBeLessThan(0.5);
    }
  );

  it.skipIf(!serverAvailable)('multi-turn session simulation with relevance tracking', async () => {
    const registry = new SbHookRegistry();
    const ledger = new ContextLedger();

    // Track what gets injected and whether the "SB" would reference it
    const injectionLog: Array<{
      turn: number;
      topic: string;
      memoriesInjected: number;
      relevanceScore: number;
    }> = [];

    // Simulated session with 3 distinct phases
    const sessionTurns = [
      // Phase 1: Session routing (turns 1-2)
      {
        topic: 'routing',
        user: 'How does the trigger system route messages to the right agent session?',
        assistant:
          'The trigger dispatches to the agent studio, resolves or creates a session, and spawns the backend with the message.',
        keywords: ['trigger', 'session', 'routing', 'studio'],
      },
      {
        topic: 'routing',
        user: 'What about when multiple agents share a worktree? Does that cause conflicts?',
        assistant:
          'Yes, backendSessionId collision is a known issue. When Myra is triggered in a shared worktree, she claims the session ID.',
        keywords: ['collision', 'worktree', 'session', 'agent'],
      },
      // Phase 2: Context management (turns 3-4)
      {
        topic: 'context',
        user: 'Switching gears — how should we handle context window pressure?',
        assistant:
          'We built context eviction tools. The SB can call list_context to introspect and evict_context to drop entries by ID, source, or role.',
        keywords: ['context', 'eviction', 'evict', 'ledger'],
      },
      {
        topic: 'context',
        user: 'And the passive recall layer — will it add too much to the context?',
        assistant:
          'Passive recall is budget-aware. It suppresses injection above 80% utilization and uses a cooldown between turns.',
        keywords: ['recall', 'budget', 'passive', 'memory'],
      },
      // Phase 3: Auth (turn 5)
      {
        topic: 'auth',
        user: 'Quick question about MCP auth — does Codex send the Authorization header?',
        assistant:
          'No, that was the bug. The Codex runner set PCP_ACCESS_TOKEN in the env but never told Codex to send it as a header.',
        keywords: ['auth', 'codex', 'header', 'token'],
      },
    ];

    const injectedMemoryIds = new Set<string>();
    const COOLDOWN = 0; // no cooldown for benchmark

    // Register passive recall hook
    registry.register({
      name: 'passive-recall-bench',
      event: 'turn_end',
      handler: async (ctx): Promise<HookResult | void> => {
        if (!ctx.lastTurn) return;
        const signal = extractTopicSignal(ctx.lastTurn.userInput, ctx.lastTurn.assistantResponse);
        if (!signal || signal.length < 5) return;

        let recall: RecallResponse;
        try {
          recall = await pcpRecall(signal, { limit: 3, agentId: 'wren' });
        } catch {
          return;
        }

        const novel = recall.memories.filter((m) => !injectedMemoryIds.has(m.id));
        if (novel.length === 0) return;

        const toInject = novel.slice(0, 2);
        return {
          inject: toInject.map((m) => {
            injectedMemoryIds.add(m.id);
            return {
              role: 'system' as const,
              content: `[passive-recall] ${m.summary || m.content.slice(0, 300)}`,
              source: 'passive-recall',
              memoryId: m.id,
            };
          }),
        };
      },
    });

    // Run the session
    console.log('\n=== Multi-Turn Session Simulation ===\n');

    for (let i = 0; i < sessionTurns.length; i++) {
      const turn = sessionTurns[i];
      ledger.addEntry('user', turn.user);
      ledger.addEntry('assistant', turn.assistant);

      const result = await registry.fire('turn_end', {
        ledger,
        runtime: { agentId: 'wren', turnCount: i + 1, budgetUtilization: 0.3 },
        lastTurn: { userInput: turn.user, assistantResponse: turn.assistant, turnIndex: i + 1 },
      });

      // Score relevance of injected memories against this turn's keywords
      const injectedThisTurn = ledger
        .listEntries()
        .filter((e) => e.source === 'passive-recall')
        .slice(-result.injected); // last N entries are the new ones

      const relevance =
        result.injected > 0
          ? scoreRelevance(
              injectedThisTurn.map(
                (e) => ({ content: e.content, summary: null }) as unknown as RecallMemory
              ),
              turn.keywords
            )
          : 0;

      injectionLog.push({
        turn: i + 1,
        topic: turn.topic,
        memoriesInjected: result.injected,
        relevanceScore: Math.round(relevance * 100),
      });

      console.log(
        `Turn ${i + 1} [${turn.topic}]: +${result.injected} memories, relevance: ${Math.round(relevance * 100)}%`
      );
      if (result.injected > 0) {
        for (const entry of injectedThisTurn) {
          console.log(`  → "${entry.content.slice(0, 100)}..."`);
        }
      }
    }

    // Aggregate
    const totalInjected = injectionLog.reduce((s, l) => s + l.memoriesInjected, 0);
    const turnsWithInjection = injectionLog.filter((l) => l.memoriesInjected > 0).length;
    const avgRelevance =
      injectionLog.filter((l) => l.memoriesInjected > 0).length > 0
        ? injectionLog
            .filter((l) => l.memoriesInjected > 0)
            .reduce((s, l) => s + l.relevanceScore, 0) /
          injectionLog.filter((l) => l.memoriesInjected > 0).length
        : 0;

    console.log(`\n--- Session Summary ---`);
    console.log(`  Turns: ${sessionTurns.length}`);
    console.log(`  Turns with injection: ${turnsWithInjection}/${sessionTurns.length}`);
    console.log(`  Total memories injected: ${totalInjected}`);
    console.log(`  Unique memories: ${injectedMemoryIds.size}`);
    console.log(`  Avg relevance (injected turns): ${avgRelevance.toFixed(0)}%`);
    console.log(`  Context entries at end: ${ledger.listEntries().length}`);
    console.log(`  Context tokens at end: ~${ledger.totalTokens()}`);
    console.log('');

    // Assertions
    expect(turnsWithInjection).toBeGreaterThan(0); // at least some turns got memories
    expect(totalInjected).toBeGreaterThan(0);
    // Relevance should be reasonable — at least some keywords hit
    if (turnsWithInjection > 0) {
      expect(avgRelevance).toBeGreaterThan(20);
    }
  });
});
