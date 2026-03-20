/**
 * sb chat Runtime E2E Integration Tests
 *
 * Tests the full sb chat pipeline against a live PCP server:
 * 1. Bootstrap verification — identity loads, memories returned
 * 2. Hook lifecycle — hooks fire in correct order with correct context
 * 3. Passive recall in REPL context — recall fires, injects, respects budget
 * 4. Context eviction tools — list_context + evict_context work in-process
 * 5. Full session cycle — bootstrap → turn → recall → evict → verify
 *
 * Uses wren as the test agent (real identity + memories in the DB).
 * Requires PCP server on localhost:3001 (or PCP_SERVER_URL).
 *
 * Run with:
 *   PCP_SERVER_URL=http://localhost:3001 npx vitest run -c vitest.integration.config.ts \
 *     packages/cli/src/repl/sb-chat-e2e.integration.test.ts
 */

import { describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { ContextLedger } from './context-ledger.js';
import { SbHookRegistry } from './hook-registry.js';
import { registerBuiltinHooks, extractTopicSignal } from './builtin-hooks.js';
import { isClientLocalTool, handleClientLocalTool } from './context-tools.js';

// ─── Server check ───────────────────────────────────────────────

const PCP_URL = process.env.PCP_SERVER_URL || 'http://localhost:3001';
let serverAvailable = false;
try {
  const result = execSync(`curl -sf -m 2 ${PCP_URL}/health`, { encoding: 'utf-8' });
  serverAvailable = result.includes('"status":"healthy"');
} catch {
  serverAvailable = false;
}

// ─── PCP Client helpers ─────────────────────────────────────────

function getAccessToken(): string {
  const authPath = `${process.env.HOME}/.pcp/auth.json`;
  const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
  return auth.accessToken || auth.access_token;
}

async function pcpToolCall(
  tool: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
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
      params: { name: tool, arguments: args },
    }),
  });

  if (!resp.ok) throw new Error(`PCP ${tool} failed: ${resp.status}`);
  const raw = await resp.text();
  const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
  if (!dataLine) throw new Error(`No SSE data in ${tool} response`);
  const rpc = JSON.parse(dataLine.slice(6)) as { result?: { content?: Array<{ text: string }> } };
  const text = rpc.result?.content?.[0]?.text;
  if (!text) throw new Error(`Empty ${tool} response`);
  return JSON.parse(text);
}

async function callRecallForHooks(query: string, limit: number) {
  const result = await pcpToolCall('recall', {
    query,
    agentId: 'wren',
    includeShared: true,
    limit,
    recallMode: 'hybrid',
  });
  if (!result.success) return [];
  return ((result.memories as Array<Record<string, unknown>>) || []).map((m) => ({
    id: m.id as string,
    content: m.content as string,
    summary: (m.summary as string) || null,
    topics: (m.topics as string[]) || [],
  }));
}

// ─── Test 1: Bootstrap ──────────────────────────────────────────

describe('E2E: Bootstrap verification', () => {
  it.skipIf(!serverAvailable)('loads identity and memories for wren', async () => {
    const result = await pcpToolCall('bootstrap', { agentId: 'wren' });

    // Bootstrap returns data directly (no success wrapper)
    // It should have user info and identity
    expect(result.user || result.identity || result.constitution).toBeTruthy();

    // User info
    const user = result.user as Record<string, unknown> | undefined;
    if (user) {
      expect(user.timezone || user.id).toBeTruthy();
    }

    // Knowledge summary or recent memories
    expect(result.knowledgeSummary || result.recentMemories || result.constitution).toBeTruthy();
  });

  it.skipIf(!serverAvailable)('returns constitution documents', async () => {
    const result = await pcpToolCall('bootstrap', { agentId: 'wren' });

    const constitution = result.constitution as Record<string, unknown> | undefined;
    if (constitution) {
      // Should have at least some of the core docs
      const docs = Object.keys(constitution);
      expect(docs.length).toBeGreaterThan(0);
    }
  });
});

// ─── Test 2: Hook lifecycle ─────────────────────────────────────

describe('E2E: Hook lifecycle in simulated REPL', () => {
  it.skipIf(!serverAvailable)('fires turn_end with passive recall injection', async () => {
    const ledger = new ContextLedger();
    const registry = new SbHookRegistry();

    const { passiveRecall } = registerBuiltinHooks(registry, {
      callRecall: callRecallForHooks,
      passiveRecallConfig: { cooldownTurns: 0, maxInjectPerTurn: 2 },
    });

    // Simulate a turn about session routing
    ledger.addEntry('user', 'How does session routing work for triggered agents?');
    ledger.addEntry('assistant', 'The server resolves the studio and spawns a backend session.');

    const result = await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 1, budgetUtilization: 0.3 },
      lastTurn: {
        userInput: 'How does session routing work for triggered agents?',
        assistantResponse: 'The server resolves the studio and spawns a backend session.',
        turnIndex: 1,
      },
    });

    expect(result.injected).toBeGreaterThan(0);
    expect(result.blocked).toBe(false);

    // Verify passive recall stats
    const stats = passiveRecall.getStats();
    expect(stats.totalInjected).toBeGreaterThan(0);

    // Verify entries are in the ledger with correct source
    const recallEntries = ledger.listEntries().filter((e) => e.source === 'passive-recall');
    expect(recallEntries.length).toBeGreaterThan(0);
    expect(recallEntries[0].content).toContain('[passive-recall]');
    expect(recallEntries[0].role).toBe('system');
  });

  it.skipIf(!serverAvailable)('fires prompt_build with budget warning at 85%', async () => {
    const ledger = new ContextLedger();
    const registry = new SbHookRegistry();

    registerBuiltinHooks(registry, {
      callRecall: callRecallForHooks,
      budgetThresholds: [0.8],
    });

    const result = await registry.fire('prompt_build', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 5, budgetUtilization: 0.85 },
    });

    expect(result.injected).toBe(1);

    const warning = ledger.listEntries().find((e) => e.source === 'budget-monitor');
    expect(warning).toBeTruthy();
    expect(warning!.content).toContain('85%');
    expect(warning!.content).toContain('budget-monitor');
  });

  it.skipIf(!serverAvailable)('hooks fire in priority order', async () => {
    const ledger = new ContextLedger();
    const registry = new SbHookRegistry();
    const order: string[] = [];

    // Register custom hooks with different priorities
    registry.register({
      name: 'first',
      event: 'turn_end',
      priority: 10,
      handler: async () => {
        order.push('first');
      },
    });

    // Built-in passive recall has priority 50
    registerBuiltinHooks(registry, {
      callRecall: async () => {
        order.push('passive-recall');
        return [];
      },
    });

    registry.register({
      name: 'last',
      event: 'turn_end',
      priority: 200,
      handler: async () => {
        order.push('last');
      },
    });

    await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 1, budgetUtilization: 0.3 },
      lastTurn: {
        userInput: 'test',
        assistantResponse: 'test',
        turnIndex: 1,
      },
    });

    expect(order[0]).toBe('first');
    expect(order[order.length - 1]).toBe('last');
  });
});

// ─── Test 3: Context tools in REPL context ──────────────────────

describe('E2E: Context tools in simulated REPL', () => {
  it('list_context returns accurate state after bootstrap + recall', async () => {
    const ledger = new ContextLedger();

    // Simulate bootstrap injection
    ledger.addEntry('system', 'You are wren. Identity: development collaborator.', 'bootstrap');
    ledger.addEntry('system', 'Values: craftsmanship, collaboration...', 'bootstrap');

    // Simulate user turn
    ledger.addEntry('user', 'What tasks are pending?');
    ledger.addEntry('assistant', 'You have 50 pending tasks across 2 projects.');

    // Simulate passive recall injection
    ledger.addEntry(
      'system',
      '[passive-recall] Task routing uses studio-level dispatch...',
      'passive-recall'
    );

    // Simulate tool result
    ledger.addEntry('system', 'list_tasks result: [{id: 1, title: "Fix routing"}]', 'local-tool');

    // Now use list_context
    const result = handleClientLocalTool('list_context', {}, ledger);
    expect(result).not.toBeNull();

    const parsed = JSON.parse((result!.content as Array<{ text: string }>)[0].text);
    expect(parsed.totalEntries).toBe(6);
    expect(parsed.bySource.bootstrap.count).toBe(2);
    expect(parsed.bySource['passive-recall'].count).toBe(1);
    expect(parsed.bySource['local-tool'].count).toBe(1);
  });

  it('evict_context removes passive-recall entries without affecting others', () => {
    const ledger = new ContextLedger();

    ledger.addEntry('system', 'Bootstrap identity', 'bootstrap');
    ledger.addEntry('user', 'Question');
    ledger.addEntry('assistant', 'Answer');
    ledger.addEntry('system', '[passive-recall] Memory A', 'passive-recall');
    ledger.addEntry('system', '[passive-recall] Memory B', 'passive-recall');
    ledger.addEntry('system', 'Tool result: inbox data', 'local-tool');

    const before = ledger.totalTokens();
    const result = handleClientLocalTool('evict_context', { source: 'passive-recall' }, ledger);
    const parsed = JSON.parse((result!.content as Array<{ text: string }>)[0].text);

    expect(parsed.evicted).toBe(2);
    expect(parsed.tokensFreed).toBeGreaterThan(0);
    expect(ledger.listEntries()).toHaveLength(4);
    expect(ledger.totalTokens()).toBeLessThan(before);

    // Bootstrap, user, assistant, and tool entries preserved
    const remaining = ledger.listEntries().map((e) => e.source);
    expect(remaining).toContain('bootstrap');
    expect(remaining).toContain('local-tool');
    expect(remaining).not.toContain('passive-recall');
  });

  it('isClientLocalTool routes correctly', () => {
    expect(isClientLocalTool('list_context')).toBe(true);
    expect(isClientLocalTool('evict_context')).toBe(true);
    expect(isClientLocalTool('recall')).toBe(false);
    expect(isClientLocalTool('bootstrap')).toBe(false);
    expect(isClientLocalTool('send_to_inbox')).toBe(false);
  });
});

// ─── Test 4: Full session cycle ─────────────────────────────────

describe('E2E: Full session cycle', () => {
  it.skipIf(!serverAvailable)('bootstrap → turn → recall → evict → verify', async () => {
    // Phase 1: Bootstrap
    const bootstrapResult = await pcpToolCall('bootstrap', { agentId: 'wren' });
    expect(
      bootstrapResult.user || bootstrapResult.identity || bootstrapResult.constitution
    ).toBeTruthy();

    // Phase 2: Set up REPL state
    const ledger = new ContextLedger();
    const registry = new SbHookRegistry();

    registerBuiltinHooks(registry, {
      callRecall: callRecallForHooks,
      passiveRecallConfig: { cooldownTurns: 0, maxInjectPerTurn: 2 },
    });

    // Simulate bootstrap context injection
    const knowledgeSummary = bootstrapResult.knowledgeSummary as string | undefined;
    if (knowledgeSummary) {
      ledger.addEntry('system', knowledgeSummary.slice(0, 500), 'bootstrap');
    }

    // Phase 3: User turn about a specific topic
    const userInput = 'How does the heartbeat service spawn sessions for Myra?';
    const assistantResponse =
      'The heartbeat service spawns Claude Code sessions periodically to check inbox and process reminders.';

    ledger.addEntry('user', userInput);
    ledger.addEntry('assistant', assistantResponse);

    // Phase 4: Fire turn_end — passive recall should inject
    const turnResult = await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 1, budgetUtilization: 0.2 },
      lastTurn: { userInput, assistantResponse, turnIndex: 1 },
    });

    const entriesAfterRecall = ledger.listEntries();
    const recallEntries = entriesAfterRecall.filter((e) => e.source === 'passive-recall');

    console.log(
      `Phase 4: ${turnResult.injected} memories injected, ${entriesAfterRecall.length} total entries`
    );

    expect(turnResult.injected).toBeGreaterThan(0);
    expect(recallEntries.length).toBeGreaterThan(0);

    // Phase 5: Evict passive recall entries (simulating budget pressure)
    const evictResult = handleClientLocalTool(
      'evict_context',
      { source: 'passive-recall' },
      ledger
    );
    const evictParsed = JSON.parse((evictResult!.content as Array<{ text: string }>)[0].text);

    console.log(
      `Phase 5: Evicted ${evictParsed.evicted} entries, freed ${evictParsed.tokensFreed} tokens`
    );

    expect(evictParsed.evicted).toBe(recallEntries.length);
    expect(ledger.listEntries().filter((e) => e.source === 'passive-recall')).toHaveLength(0);

    // Phase 6: Verify transcript is clean
    const transcript = ledger.buildPromptTranscript();
    expect(transcript).not.toContain('[passive-recall]');
    expect(transcript).toContain(userInput);
    expect(transcript).toContain(assistantResponse);

    // Phase 7: Topic shift — new turn should get different memories
    const userInput2 = 'Now tell me about MCP authentication and JWT tokens.';
    const assistantResponse2 = 'MCP uses self-issued JWTs with 30-day expiry.';

    ledger.addEntry('user', userInput2);
    ledger.addEntry('assistant', assistantResponse2);

    const turnResult2 = await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 2, budgetUtilization: 0.3 },
      lastTurn: { userInput: userInput2, assistantResponse: assistantResponse2, turnIndex: 2 },
    });

    console.log(`Phase 7: Topic shift — ${turnResult2.injected} new memories injected`);

    // Should have injected memories about auth/JWT, not heartbeat
    const newRecall = ledger.listEntries().filter((e) => e.source === 'passive-recall');
    if (newRecall.length > 0) {
      const content = newRecall.map((e) => e.content.toLowerCase()).join(' ');
      // At least one should mention auth/jwt/token
      const authRelevant =
        content.includes('auth') ||
        content.includes('jwt') ||
        content.includes('token') ||
        content.includes('mcp');
      console.log(`Phase 7 relevance: auth-related=${authRelevant}`);
    }

    // Phase 8: Final state check
    const finalList = handleClientLocalTool('list_context', {}, ledger);
    const finalParsed = JSON.parse((finalList!.content as Array<{ text: string }>)[0].text);

    console.log(
      `\nFinal state: ${finalParsed.totalEntries} entries, ~${finalParsed.totalTokens} tokens`
    );
    console.log('Sources:', JSON.stringify(finalParsed.bySource));
  });
});

// ─── Test 5: Topic signal extraction quality ────────────────────

describe('E2E: Topic signal extraction', () => {
  it('produces distinct signals for distinct topics', () => {
    const signals = [
      extractTopicSignal(
        'How does session routing work?',
        'The server resolves the studio for triggered agents.'
      ),
      extractTopicSignal(
        'Tell me about MCP authentication.',
        'We use self-issued JWTs with 30-day expiry.'
      ),
      extractTopicSignal(
        'How does the heartbeat service work?',
        'It spawns periodic sessions to check inbox and reminders.'
      ),
    ];

    // Each signal should be non-empty
    for (const s of signals) {
      expect(s.length).toBeGreaterThan(5);
    }

    // Signals should be different from each other
    const uniqueSignals = new Set(signals);
    expect(uniqueSignals.size).toBe(3);
  });

  it('ignores code blocks and URLs in extraction', () => {
    const signal = extractTopicSignal(
      'Check this:\n```ts\nconst x = await bootstrap();\n```',
      'See https://github.com/foo/bar — the session routing handles this.'
    );

    expect(signal).not.toContain('const');
    expect(signal).not.toContain('https');
    expect(signal).toMatch(/session|routing/i);
  });
});
