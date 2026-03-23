/**
 * sb chat Runtime Integration Tests
 *
 * Tests the real runtime wiring:
 * 1. PcpClient.callTool('recall') returns the shape our hooks expect
 * 2. turn_end is fire-and-forget — injections appear in NEXT turn's prompt
 * 3. Inbox messages enter the ledger and inform passive recall topic signal
 *
 * Requires PCP server on localhost:3001 (or PCP_SERVER_URL).
 *
 * Run with:
 *   PCP_SERVER_URL=http://localhost:3001 npx vitest run -c vitest.integration.config.ts \
 *     packages/cli/src/repl/sb-chat-runtime.integration.test.ts
 */

import { describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';
import { ContextLedger, estimateTokens } from './context-ledger.js';
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

// ─── PcpClient (real instance) ──────────────────────────────────

// Dynamic import to avoid breaking when not running integration tests
async function createPcpClient() {
  const { PcpClient } = await import('../lib/pcp-client.js');
  const authPath = join(process.env.HOME || '', '.pcp', 'auth.json');
  return new PcpClient(PCP_URL, authPath);
}

// ─── Test 1: callTool('recall') shape validation ────────────────

describe('PcpClient.callTool recall shape', () => {
  it.skipIf(!serverAvailable)(
    'returns { success, memories } directly (not MCP wrapper)',
    async () => {
      const pcp = await createPcpClient();
      const result = await pcp.callTool('recall', {
        query: 'session routing',
        agentId: 'wren',
        includeShared: true,
        limit: 3,
        recallMode: 'hybrid',
      });

      // PcpClient.parseJsonRpcToolPayload extracts content[0].text and JSON-parses it.
      // So we should get the inner object directly.
      expect(result.success).toBe(true);
      expect(Array.isArray(result.memories)).toBe(true);

      const memories = result.memories as Array<Record<string, unknown>>;
      expect(memories.length).toBeGreaterThan(0);

      // Each memory should have the fields our hook expects
      const mem = memories[0];
      expect(typeof mem.id).toBe('string');
      expect(typeof mem.content).toBe('string');
      expect(mem.summary === null || typeof mem.summary === 'string').toBe(true);
      expect(Array.isArray(mem.topics)).toBe(true);
    }
  );

  it.skipIf(!serverAvailable)(
    'the callRecall wrapper produces the right shape for hooks',
    async () => {
      const pcp = await createPcpClient();

      // This mirrors exactly what chat.ts does
      const callRecall = async (query: string, limit: number) => {
        try {
          const result = await pcp.callTool('recall', {
            query,
            agentId: 'wren',
            includeShared: true,
            limit,
            recallMode: 'hybrid',
          });
          const parsed = result as Record<string, unknown>;
          if (!parsed.success) return [];
          const memories = parsed.memories as Array<Record<string, unknown>> | undefined;
          return (memories || []).map((m) => ({
            id: m.id as string,
            content: m.content as string,
            summary: (m.summary as string) || null,
            topics: (m.topics as string[]) || [],
          }));
        } catch {
          return [];
        }
      };

      const memories = await callRecall('session routing triggered agents', 3);

      expect(memories.length).toBeGreaterThan(0);
      expect(typeof memories[0].id).toBe('string');
      expect(typeof memories[0].content).toBe('string');
      // summary can be null
      expect(memories[0].summary === null || typeof memories[0].summary === 'string').toBe(true);
      expect(Array.isArray(memories[0].topics)).toBe(true);
    }
  );

  it.skipIf(!serverAvailable)('callRecall feeds correctly into passive recall hook', async () => {
    const pcp = await createPcpClient();
    const ledger = new ContextLedger();
    const registry = new SbHookRegistry();

    const callRecall = async (query: string, limit: number) => {
      const result = await pcp.callTool('recall', {
        query,
        agentId: 'wren',
        includeShared: true,
        limit,
        recallMode: 'hybrid',
      });
      const parsed = result as Record<string, unknown>;
      if (!parsed.success) return [];
      const memories = parsed.memories as Array<Record<string, unknown>> | undefined;
      return (memories || []).map((m) => ({
        id: m.id as string,
        content: m.content as string,
        summary: (m.summary as string) || null,
        topics: (m.topics as string[]) || [],
      }));
    };

    registerBuiltinHooks(registry, {
      callRecall,
      passiveRecallConfig: { cooldownTurns: 0, maxInjectPerTurn: 2 },
    });

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

    const recallEntries = ledger.listEntries().filter((e) => e.source === 'passive-recall');
    expect(recallEntries.length).toBeGreaterThan(0);
    expect(recallEntries[0].content).toContain('[passive-recall]');
  });
});

// ─── Test 2: turn_end fire-and-forget timing ────────────────────

describe('turn_end fire-and-forget semantics', () => {
  it('injections from turn_end appear in the ledger but after the current response', async () => {
    const ledger = new ContextLedger();
    const registry = new SbHookRegistry();

    // Register a hook that injects a memory
    registry.register({
      name: 'delayed-recall',
      event: 'turn_end',
      priority: 50,
      handler: async () => ({
        inject: [
          {
            role: 'system' as const,
            content: '[passive-recall] A relevant memory about routing',
            source: 'passive-recall',
          },
        ],
      }),
    });

    // Simulate the turn sequence as chat.ts does it:

    // 1. User message → ledger
    ledger.addEntry('user', 'Tell me about routing');

    // 2. Build prompt (before turn) — snapshot the transcript
    const promptBefore = ledger.buildPromptTranscript();
    expect(promptBefore).not.toContain('[passive-recall]');

    // 3. Backend responds → ledger
    ledger.addEntry('assistant', 'Routing works by resolving the studio...');

    // 4. Fire turn_end (fire-and-forget in real code, but we await here for testing)
    const hookResult = await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 1, budgetUtilization: 0.3 },
      lastTurn: {
        userInput: 'Tell me about routing',
        assistantResponse: 'Routing works by resolving the studio...',
        turnIndex: 1,
      },
    });

    expect(hookResult.injected).toBe(1);

    // 5. The injection IS in the ledger now
    expect(ledger.listEntries().some((e) => e.source === 'passive-recall')).toBe(true);

    // 6. But the NEXT prompt will include it
    const promptAfter = ledger.buildPromptTranscript();
    expect(promptAfter).toContain('[passive-recall]');
    expect(promptAfter).toContain('relevant memory about routing');
  });

  it('multiple turn_end hooks fire sequentially, later hooks see earlier injections', async () => {
    const ledger = new ContextLedger();
    const registry = new SbHookRegistry();
    let secondHookSawInjection = false;

    registry.register({
      name: 'injector',
      event: 'turn_end',
      priority: 10,
      handler: async () => ({
        inject: [
          {
            role: 'system' as const,
            content: 'First hook injection',
            source: 'hook-a',
          },
        ],
      }),
    });

    registry.register({
      name: 'observer',
      event: 'turn_end',
      priority: 20,
      handler: async (ctx) => {
        secondHookSawInjection = ctx.ledger.listEntries().some((e) => e.source === 'hook-a');
      },
    });

    await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 1, budgetUtilization: 0.3 },
      lastTurn: { userInput: 'test', assistantResponse: 'test', turnIndex: 1 },
    });

    expect(secondHookSawInjection).toBe(true);
  });

  it('turn_end errors do not propagate (fire-and-forget contract)', async () => {
    const ledger = new ContextLedger();
    const registry = new SbHookRegistry();

    registry.register({
      name: 'crasher',
      event: 'turn_end',
      handler: async () => {
        throw new Error('Network timeout on recall');
      },
    });

    // Simulating the fire-and-forget pattern from chat.ts:
    // hookRegistry.fire(...).catch(() => undefined)
    let caught = false;
    await registry
      .fire('turn_end', {
        ledger,
        runtime: { agentId: 'wren', turnCount: 1, budgetUtilization: 0.3 },
        lastTurn: { userInput: 'test', assistantResponse: 'test', turnIndex: 1 },
      })
      .catch(() => {
        caught = true;
      });

    // The registry catches errors internally, so this should NOT propagate
    expect(caught).toBe(false);
  });
});

// ─── Test 3: Inbox messages and passive recall ──────────────────

describe('Inbox polling + passive recall interaction', () => {
  it('inbox messages in the ledger influence topic signal extraction', () => {
    // Simulate: inbox message arrives and gets added to ledger (as the REPL does)
    const inboxContent = 'Hey Wren, can you review PR #242? It has the context eviction changes.';

    // The topic signal should pick up on PR review + context eviction
    const signal = extractTopicSignal(
      '', // no user input yet — the inbox message IS the trigger
      inboxContent
    );

    expect(signal).toBeTruthy();
    expect(signal).toMatch(/review|context|eviction|pr/i);
  });

  it('passive recall fires on turns that include inbox context', async () => {
    const ledger = new ContextLedger();
    const registry = new SbHookRegistry();

    // Mock recall that returns memories about code review
    const mockRecall = async (_query: string, _limit: number) => [
      {
        id: 'mem-review-1',
        content: 'Lumen prefers concrete code suggestions over general comments in reviews',
        summary: 'Lumen review preference: concrete code suggestions',
        topics: ['review', 'lumen', 'collaboration'],
      },
    ];

    registerBuiltinHooks(registry, {
      callRecall: mockRecall,
      passiveRecallConfig: { cooldownTurns: 0, maxInjectPerTurn: 2 },
    });

    // Simulate: inbox message arrives → gets added to ledger as inbox role
    ledger.addEntry(
      'inbox',
      'From lumen: Please review PR #242 — context eviction + hooks',
      'pcp-inbox'
    );

    // User responds to the inbox message
    ledger.addEntry('user', 'Let me look at that PR review request from Lumen');
    ledger.addEntry('assistant', 'Looking at PR #242 for context eviction changes...');

    const result = await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 1, budgetUtilization: 0.3 },
      lastTurn: {
        userInput: 'Let me look at that PR review request from Lumen',
        assistantResponse: 'Looking at PR #242 for context eviction changes...',
        turnIndex: 1,
      },
    });

    expect(result.injected).toBeGreaterThan(0);

    const recallEntries = ledger.listEntries().filter((e) => e.source === 'passive-recall');
    expect(recallEntries.length).toBeGreaterThan(0);
    // The mock memory about Lumen's review preferences should be injected
    expect(recallEntries[0].content).toContain('Lumen');
  });

  it('evicting inbox entries does not break subsequent recall', () => {
    const ledger = new ContextLedger();

    // Add inbox messages
    ledger.addEntry('inbox', 'Message 1 from myra', 'pcp-inbox');
    ledger.addEntry('inbox', 'Message 2 from lumen', 'pcp-inbox');
    ledger.addEntry('user', 'Got it, processing those');
    ledger.addEntry('assistant', 'Processing inbox messages...');

    // Evict inbox after processing
    handleClientLocalTool('evict_context', { source: 'pcp-inbox' }, ledger);

    expect(ledger.listEntries()).toHaveLength(2); // user + assistant remain
    expect(ledger.listEntries().every((e) => e.source !== 'pcp-inbox')).toBe(true);

    // Topic extraction still works on remaining entries
    const signal = extractTopicSignal('Got it, processing those', 'Processing inbox messages...');
    expect(signal).toBeTruthy();

    // Can still add new entries after eviction
    ledger.addEntry('user', 'What else is in my inbox?');
    expect(ledger.listEntries()).toHaveLength(3);
  });

  it.skipIf(!serverAvailable)(
    'real recall after inbox-informed turn returns relevant memories',
    async () => {
      const pcp = await createPcpClient();
      const ledger = new ContextLedger();
      const registry = new SbHookRegistry();

      const callRecall = async (query: string, limit: number) => {
        const result = await pcp.callTool('recall', {
          query,
          agentId: 'wren',
          includeShared: true,
          limit,
          recallMode: 'hybrid',
        });
        const parsed = result as Record<string, unknown>;
        if (!parsed.success) return [];
        const memories = parsed.memories as Array<Record<string, unknown>> | undefined;
        return (memories || []).map((m) => ({
          id: m.id as string,
          content: m.content as string,
          summary: (m.summary as string) || null,
          topics: (m.topics as string[]) || [],
        }));
      };

      registerBuiltinHooks(registry, {
        callRecall,
        passiveRecallConfig: { cooldownTurns: 0, maxInjectPerTurn: 2 },
      });

      // Simulate inbox-triggered conversation about PR review
      ledger.addEntry(
        'inbox',
        'From lumen: Reviewed PR #242. Two design blockers on hook execution semantics.',
        'pcp-inbox'
      );
      ledger.addEntry('user', 'Let me address Lumen review feedback on the hook system');
      ledger.addEntry(
        'assistant',
        'Looking at the two blockers: hook execution semantics and injection contract.'
      );

      const result = await registry.fire('turn_end', {
        ledger,
        runtime: { agentId: 'wren', turnCount: 1, budgetUtilization: 0.3 },
        lastTurn: {
          userInput: 'Let me address Lumen review feedback on the hook system',
          assistantResponse:
            'Looking at the two blockers: hook execution semantics and injection contract.',
          turnIndex: 1,
        },
      });

      // Should have injected memories related to hooks/review/lumen
      expect(result.injected).toBeGreaterThan(0);

      const recallEntries = ledger.listEntries().filter((e) => e.source === 'passive-recall');
      expect(recallEntries.length).toBeGreaterThan(0);
    }
  );
});

// ─── Test 4: Budget calculation with bootstrap ──────────────────

describe('Budget utilization with bootstrap reservation', () => {
  it('effective budget excludes bootstrap tokens', () => {
    const maxContextTokens = 16000;
    const bootstrapContext = 'x'.repeat(12000); // ~3000 tokens
    const bootstrapTokens = estimateTokens(bootstrapContext);
    const effectiveBudget = maxContextTokens - bootstrapTokens;

    expect(bootstrapTokens).toBe(3000);
    expect(effectiveBudget).toBe(13000);

    // Ledger at 10000 tokens
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'y'.repeat(40000)); // ~10000 tokens

    // Old (wrong) calculation: 10000/16000 = 62.5%
    const wrongUtilization = ledger.totalTokens() / maxContextTokens;
    expect(wrongUtilization).toBeCloseTo(0.625, 1);

    // New (correct) calculation: 10000/13000 = 76.9%
    const correctUtilization = ledger.totalTokens() / effectiveBudget;
    expect(correctUtilization).toBeCloseTo(0.769, 1);

    // The difference matters: 62.5% wouldn't trigger 80% passive recall suppression,
    // but 76.9% is close to the threshold — accurate for decision-making.
  });

  it('budget monitor fires at the right threshold with bootstrap accounted', async () => {
    const registry = new SbHookRegistry();
    const ledger = new ContextLedger();

    registerBuiltinHooks(registry, {
      callRecall: async () => [],
      budgetThresholds: [0.8],
    });

    // At 75% effective budget — no warning
    const r1 = await registry.fire('prompt_build', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 1, budgetUtilization: 0.75 },
    });
    expect(r1.injected).toBe(0);

    // At 82% effective budget — warning fires
    const r2 = await registry.fire('prompt_build', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 2, budgetUtilization: 0.82 },
    });
    expect(r2.injected).toBe(1);
    expect(ledger.listEntries()[0].content).toContain('82%');
  });

  it('passive recall suppressed above 80% effective budget', async () => {
    const registry = new SbHookRegistry();
    const ledger = new ContextLedger();

    registerBuiltinHooks(registry, {
      callRecall: async () => [{ id: 'mem-1', content: 'A memory', summary: null, topics: [] }],
      passiveRecallConfig: { cooldownTurns: 0, budgetCeiling: 0.8 },
    });

    ledger.addEntry('user', 'How does session routing work for triggered agents?');
    ledger.addEntry('assistant', 'The server resolves the studio and spawns a session.');

    // At 79% — recall fires
    const r1 = await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 1, budgetUtilization: 0.79 },
      lastTurn: {
        userInput: 'How does session routing work for triggered agents?',
        assistantResponse: 'The server resolves the studio and spawns a session.',
        turnIndex: 1,
      },
    });
    expect(r1.injected).toBe(1);

    // At 81% — recall suppressed
    const r2 = await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: 'wren', turnCount: 2, budgetUtilization: 0.81 },
      lastTurn: {
        userInput: 'What about the authentication flow?',
        assistantResponse: 'MCP uses self-issued JWTs.',
        turnIndex: 2,
      },
    });
    expect(r2.injected).toBe(0);
  });
});
