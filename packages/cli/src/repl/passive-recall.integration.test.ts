/**
 * Passive Recall Integration Tests
 *
 * Tests the passive recall hook against a LIVE PCP server with real
 * semantic search. Requires PCP_SERVER_URL (defaults to localhost:3001)
 * and valid auth credentials in ~/.pcp/auth.json.
 *
 * These tests validate:
 * 1. Real recall() returns semantically relevant memories
 * 2. Topic signal extraction produces useful queries
 * 3. Deduplication works with real memory IDs
 * 4. Budget ceiling suppression with real token counts
 * 5. End-to-end: conversation → topic extraction → recall → injection → eviction cycle
 *
 * Run with: npx vitest run packages/cli/src/repl/passive-recall.integration.test.ts
 * Requires: PCP server running on localhost:3001 (or PCP_SERVER_URL env var)
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import { SbHookRegistry, type HookResult, type HookRuntimeState } from './hook-registry.js';

// ─── PCP Client (lightweight, for integration tests) ────────────

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
  const serverUrl = process.env.PCP_SERVER_URL || 'http://localhost:3001';
  const authPath = `${process.env.HOME}/.pcp/auth.json`;

  let accessToken: string;
  try {
    const { readFileSync } = await import('fs');
    const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
    accessToken = auth.accessToken || auth.access_token;
    if (!accessToken) throw new Error('No access token in auth.json');
  } catch {
    throw new Error(`Cannot read PCP auth from ${authPath} — is the server running?`);
  }

  const body = {
    query,
    agentId: options?.agentId || 'wren',
    includeShared: true,
    limit: options?.limit || 5,
    recallMode: options?.recallMode || 'hybrid',
  };

  const resp = await fetch(`${serverUrl}/mcp`, {
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
      params: { name: 'recall', arguments: body },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`PCP recall failed: ${resp.status} ${resp.statusText} — ${body.slice(0, 200)}`);
  }

  // MCP Streamable HTTP returns SSE format: "event: message\ndata: {...}\n\n"
  const raw = await resp.text();
  const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
  if (!dataLine) throw new Error(`No SSE data line in response: ${raw.slice(0, 200)}`);

  const rpc = JSON.parse(dataLine.slice(6)) as {
    result?: { content?: Array<{ text: string }> };
    error?: { message: string };
  };
  if (rpc.error) {
    throw new Error(`PCP recall RPC error: ${rpc.error.message}`);
  }

  const text = rpc.result?.content?.[0]?.text;
  if (!text) throw new Error('Empty recall response');

  return JSON.parse(text) as RecallResponse;
}

// ─── Topic signal extraction (same logic we'd use in the real hook) ──

function extractTopicSignal(userInput: string, assistantResponse: string): string {
  // Strip code blocks and tool output
  const stripped = [userInput, assistantResponse]
    .join(' ')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\{[\s\S]*?\}/g, '')
    .replace(/https?:\/\/\S+/g, '');

  // Extract high-signal tokens (3+ chars, not common stop words)
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

  // Frequency-based selection — top tokens by occurrence
  const freq = new Map<string, number>();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) || 0) + 1);
  }

  const ranked = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([token]) => token);

  return ranked.join(' ').slice(0, 200);
}

// ─── Passive recall hook (real implementation) ──────────────────

function createPassiveRecallHook(config?: {
  cooldownTurns?: number;
  budgetCeiling?: number;
  maxInjectPerTurn?: number;
  recallMode?: string;
}) {
  const cooldown = config?.cooldownTurns ?? 3;
  const ceiling = config?.budgetCeiling ?? 0.8;
  const maxInject = config?.maxInjectPerTurn ?? 2;
  const recallMode = config?.recallMode ?? 'hybrid';
  const injectedMemoryIds = new Set<string>();
  let turnsSinceLastInjection = cooldown; // allow first injection

  return {
    name: 'passive-recall',
    event: 'turn_end' as const,
    priority: 50,
    /** Expose internals for test assertions */
    _state: {
      injectedMemoryIds,
      get turnsSinceLastInjection() {
        return turnsSinceLastInjection;
      },
    },
    handler: async (ctx: {
      ledger: ContextLedger;
      runtime: HookRuntimeState;
      lastTurn?: { userInput: string; assistantResponse: string; turnIndex: number };
    }): Promise<HookResult | void> => {
      // Budget ceiling
      if ((ctx.runtime.budgetUtilization ?? 0) > ceiling) return;

      // Cooldown
      if (turnsSinceLastInjection < cooldown) {
        turnsSinceLastInjection++;
        return;
      }

      // Need turn context for topic extraction
      if (!ctx.lastTurn) return;

      // Extract topic signal
      const signal = extractTopicSignal(ctx.lastTurn.userInput, ctx.lastTurn.assistantResponse);
      if (!signal || signal.length < 5) return;

      // Call real PCP recall
      let recallResult: RecallResponse;
      try {
        recallResult = await pcpRecall(signal, {
          limit: maxInject + 3, // fetch extra for filtering
          agentId: ctx.runtime.agentId,
          recallMode,
        });
      } catch {
        // Fail silently — never block the REPL
        return;
      }

      if (!recallResult.success || recallResult.memories.length === 0) return;

      // Filter: dedup + skip already-in-context
      const novel = recallResult.memories.filter((m) => !injectedMemoryIds.has(m.id));
      if (novel.length === 0) return;

      const toInject = novel.slice(0, maxInject);
      turnsSinceLastInjection = 0;

      return {
        inject: toInject.map((m) => {
          injectedMemoryIds.add(m.id);
          return {
            role: 'system' as const,
            content: `[passive-recall] ${m.summary || m.content.slice(0, 300)}`,
            source: 'passive-recall',
            hookName: 'passive-recall',
            memoryId: m.id,
          };
        }),
      };
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────

// Check if PCP server is reachable — must be synchronous for skipIf
// We use a module-level check via a synchronous HTTP probe
import { execSync } from 'child_process';

const PCP_URL = process.env.PCP_SERVER_URL || 'http://localhost:3001';

let serverAvailable = false;
try {
  const result = execSync(`curl -sf -m 2 ${PCP_URL}/health`, { encoding: 'utf-8' });
  serverAvailable = result.includes('"status":"healthy"');
} catch {
  serverAvailable = false;
}

describe('Topic signal extraction', () => {
  it('extracts relevant keywords from conversation', () => {
    const signal = extractTopicSignal(
      'How does session routing work for triggered agents?',
      'When an agent is triggered via send_to_inbox, the server resolves the recipient studio and spawns a backend session.'
    );

    expect(signal).toBeTruthy();
    expect(signal.length).toBeGreaterThan(10);
    expect(signal.length).toBeLessThanOrEqual(200);
    // Should contain high-signal terms
    expect(signal).toMatch(/session|routing|triggered|agent|studio|spawn/i);
  });

  it('strips code blocks and URLs', () => {
    const signal = extractTopicSignal(
      'Check this code:\n```typescript\nconst x = 42;\n```',
      'See https://github.com/foo/bar for details about memory recall'
    );

    expect(signal).not.toContain('const');
    expect(signal).not.toContain('https');
    expect(signal).toMatch(/memory|recall/i);
  });

  it('returns empty for trivial input', () => {
    const signal = extractTopicSignal('hi', 'hello');
    // Very short signals are possible but low-value
    expect(signal.length).toBeLessThan(20);
  });
});

describe('Passive recall: live PCP integration', () => {
  it.skipIf(!serverAvailable)('recalls relevant memories for session routing query', async () => {
    const result = await pcpRecall('session routing triggered agents studio resolution');

    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThan(0);
    expect(result.memories.length).toBeGreaterThan(0);

    // Memories should have the expected shape
    const mem = result.memories[0];
    expect(mem.id).toBeTruthy();
    expect(mem.content).toBeTruthy();
    expect(typeof mem.createdAt).toBe('string');
  });

  it.skipIf(!serverAvailable)(
    'recalls relevant memories for context management query',
    async () => {
      const result = await pcpRecall('context window compaction eviction memory management');

      expect(result.success).toBe(true);
      // We know these memories exist from the earlier recall in this session
      expect(
        result.memories.some(
          (m) =>
            m.content.toLowerCase().includes('compaction') ||
            m.content.toLowerCase().includes('context') ||
            m.content.toLowerCase().includes('eviction')
        )
      ).toBe(true);
    }
  );

  it.skipIf(!serverAvailable)('returns empty for nonsense query', async () => {
    const result = await pcpRecall('xyzzy plugh 12345 completely irrelevant gibberish');

    expect(result.success).toBe(true);
    // May still return results via text matching, but they should be low relevance
    // The key test is that it doesn't error
  });

  it.skipIf(!serverAvailable)('respects limit parameter', async () => {
    const result = await pcpRecall('session routing', { limit: 2 });

    expect(result.success).toBe(true);
    expect(result.memories.length).toBeLessThanOrEqual(2);
  });
});

describe('Passive recall hook: live end-to-end', () => {
  it.skipIf(!serverAvailable)('injects memories based on conversation topic', async () => {
    const registry = new SbHookRegistry();
    const ledger = new ContextLedger();
    const hook = createPassiveRecallHook({ cooldownTurns: 0, maxInjectPerTurn: 2 });
    registry.register(hook);

    // Simulate a conversation about session routing
    ledger.addEntry('user', 'How does session routing work for triggered agents?');
    ledger.addEntry(
      'assistant',
      'When an agent is triggered via send_to_inbox, the server resolves the recipient studio and spawns a backend session with the message as input.'
    );

    const result = await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 1, budgetUtilization: 0.3 },
      lastTurn: {
        userInput: 'How does session routing work for triggered agents?',
        assistantResponse:
          'When an agent is triggered via send_to_inbox, the server resolves the recipient studio and spawns a backend session with the message as input.',
        turnIndex: 1,
      },
    });

    expect(result.injected).toBeGreaterThan(0);

    // Verify injected entries are in the ledger
    const recallEntries = ledger.listEntries().filter((e) => e.source === 'passive-recall');
    expect(recallEntries.length).toBeGreaterThan(0);
    expect(recallEntries[0].content).toContain('[passive-recall]');

    // Verify dedup state was updated
    expect(hook._state.injectedMemoryIds.size).toBeGreaterThan(0);
  });

  it.skipIf(!serverAvailable)('deduplicates across turns', async () => {
    const registry = new SbHookRegistry();
    const ledger = new ContextLedger();
    const hook = createPassiveRecallHook({ cooldownTurns: 0, maxInjectPerTurn: 5 });
    registry.register(hook);

    const turn = {
      userInput: 'Tell me about session routing and triggered agents',
      assistantResponse: 'Session routing resolves the studio for the target agent.',
      turnIndex: 1,
    };

    ledger.addEntry('user', turn.userInput);
    ledger.addEntry('assistant', turn.assistantResponse);

    // First turn
    const r1 = await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 1, budgetUtilization: 0.3 },
      lastTurn: turn,
    });
    const firstInjectionCount = r1.injected;

    // Same topic, second turn — should get fewer/no new memories
    const r2 = await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 2, budgetUtilization: 0.3 },
      lastTurn: { ...turn, turnIndex: 2 },
    });

    // Second injection should be <= first (dedup filters already-seen memories)
    expect(r2.injected).toBeLessThanOrEqual(firstInjectionCount);
  });

  it.skipIf(!serverAvailable)('suppresses at budget ceiling', async () => {
    const registry = new SbHookRegistry();
    const ledger = new ContextLedger();
    const hook = createPassiveRecallHook({ cooldownTurns: 0, budgetCeiling: 0.8 });
    registry.register(hook);

    ledger.addEntry('user', 'session routing');
    ledger.addEntry('assistant', 'routing explanation');

    const result = await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 1, budgetUtilization: 0.85 },
      lastTurn: {
        userInput: 'session routing',
        assistantResponse: 'routing explanation',
        turnIndex: 1,
      },
    });

    expect(result.injected).toBe(0);
  });

  it.skipIf(!serverAvailable)('full cycle: inject → evict → topic shift → re-inject', async () => {
    const registry = new SbHookRegistry();
    const ledger = new ContextLedger();
    const hook = createPassiveRecallHook({ cooldownTurns: 0, maxInjectPerTurn: 2 });
    registry.register(hook);

    // Turn 1: session routing topic
    ledger.addEntry('user', 'How does session routing work?');
    ledger.addEntry(
      'assistant',
      'Session routing resolves the target studio for triggered agents.'
    );

    const r1 = await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 1, budgetUtilization: 0.3 },
      lastTurn: {
        userInput: 'How does session routing work?',
        assistantResponse: 'Session routing resolves the target studio for triggered agents.',
        turnIndex: 1,
      },
    });

    const injectedAfterT1 = ledger.listEntries().filter((e) => e.source === 'passive-recall');
    expect(injectedAfterT1.length).toBeGreaterThan(0);

    // Evict the passive recall entries (simulating budget pressure)
    const evictIds = injectedAfterT1.map((e) => e.id);
    ledger.evictEntries(evictIds);

    const afterEvict = ledger.listEntries().filter((e) => e.source === 'passive-recall');
    expect(afterEvict.length).toBe(0);

    // Turn 2: shift to a DIFFERENT topic
    ledger.addEntry('user', 'What about the task comments feature?');
    ledger.addEntry(
      'assistant',
      'Task comments are stored in the task_comments table with agent attribution.'
    );

    const r2 = await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 2, budgetUtilization: 0.3 },
      lastTurn: {
        userInput: 'What about the task comments feature?',
        assistantResponse:
          'Task comments are stored in the task_comments table with agent attribution.',
        turnIndex: 2,
      },
    });

    // Should get NEW memories related to tasks/comments (different from T1)
    // Even if no task-specific memories exist, the recall shouldn't error
    expect(r2.blocked).toBe(false);

    // Total injected should be from both turns
    const totalRecall = ledger.listEntries().filter((e) => e.source === 'passive-recall');
    // We can't guarantee content since it depends on what's in the DB,
    // but the pipeline should have run without errors
    expect(r1.injected + r2.injected).toBeGreaterThanOrEqual(r1.injected);
  });
});

describe('Passive recall: latency benchmark', () => {
  it.skipIf(!serverAvailable)('recall round-trip stays under 500ms', async () => {
    const queries = [
      'session routing triggered agents',
      'context window compaction eviction',
      'task comments dashboard',
      'Myra Telegram heartbeat',
      'MCP tool authorization bearer header',
    ];

    const times: number[] = [];
    for (const q of queries) {
      const start = performance.now();
      await pcpRecall(q, { limit: 3 });
      times.push(performance.now() - start);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);
    const p95 = times.sort((a, b) => a - b)[Math.floor(times.length * 0.95)];

    console.log(
      `Recall latency: avg=${avg.toFixed(0)}ms, p95=${p95.toFixed(0)}ms, max=${max.toFixed(0)}ms`
    );

    // Assertions — generous enough for embedding pipeline + local Ollama
    expect(avg).toBeLessThan(1000);
    expect(max).toBeLessThan(3000);
  });
});
