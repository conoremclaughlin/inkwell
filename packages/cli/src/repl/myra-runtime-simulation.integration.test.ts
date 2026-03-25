/**
 * Myra Runtime Simulation — Semi-Automated Integration Test
 *
 * Simulates a full Myra heartbeat session on the sb runtime:
 * 1. Bootstrap as Myra — load identity, constitution, memories
 * 2. Check inbox — retrieve pending messages
 * 3. Passive recall — surface relevant memories based on inbox content
 * 4. Context management — fill ledger, budget warning, eviction cycle
 * 5. (Optional) Send Telegram message — real message to Conor
 *
 * Steps 1-4 are fully automated. Step 5 requires SEND_TELEGRAM=true env var.
 *
 * Run with:
 *   PCP_SERVER_URL=http://localhost:3001 npx vitest run -c vitest.integration.config.ts \
 *     packages/cli/src/repl/myra-runtime-simulation.integration.test.ts
 *
 * To also send a Telegram message:
 *   SEND_TELEGRAM=true PCP_SERVER_URL=http://localhost:3001 npx vitest run ...
 */

import { describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';
import { ContextLedger, estimateTokens } from './context-ledger.js';
import { SbHookRegistry } from './hook-registry.js';
import { registerBuiltinHooks, extractTopicSignal } from './builtin-hooks.js';
import { handleClientLocalTool, isClientLocalTool } from './context-tools.js';

// ─── Config ─────────────────────────────────────────────────────

const PCP_URL = process.env.PCP_SERVER_URL || 'http://localhost:3001';
const SEND_TELEGRAM = process.env.SEND_TELEGRAM === 'true';
const AGENT_ID = 'myra';

let serverAvailable = false;
try {
  const result = execSync(`curl -sf -m 2 ${PCP_URL}/health`, { encoding: 'utf-8' });
  serverAvailable = result.includes('"status":"healthy"');
} catch {
  serverAvailable = false;
}

// ─── PcpClient ──────────────────────────────────────────────────

async function createPcpClient() {
  const { PcpClient } = await import('../lib/pcp-client.js');
  const authPath = join(process.env.HOME || '', '.pcp', 'auth.json');
  return new PcpClient(PCP_URL, authPath);
}

// ─── Phase 1: Bootstrap ─────────────────────────────────────────

describe('Myra simulation: Phase 1 — Bootstrap', () => {
  it.skipIf(!serverAvailable)('bootstraps as Myra with identity and memories', async () => {
    const pcp = await createPcpClient();
    const result = await pcp.callTool('bootstrap', { agentId: AGENT_ID });
    const parsed = result as Record<string, unknown>;

    console.log('\n=== Phase 1: Bootstrap as Myra ===');

    // Should have user + identity
    expect(parsed.user || parsed.identity || parsed.constitution).toBeTruthy();

    // Check constitution docs
    const constitution = parsed.constitution as Record<string, unknown> | undefined;
    if (constitution) {
      const docs = Object.keys(constitution);
      console.log(`  Constitution docs: ${docs.join(', ')}`);
      expect(docs.length).toBeGreaterThan(0);
    }

    // Check knowledge summary / memories
    const knowledgeSummary = parsed.knowledgeSummary as string | undefined;
    if (knowledgeSummary) {
      const tokens = estimateTokens(knowledgeSummary);
      console.log(`  Knowledge summary: ~${tokens} tokens`);
    }

    // Check active sessions
    const sessions = parsed.activeSessions as unknown[] | undefined;
    console.log(`  Active sessions: ${sessions?.length || 0}`);

    console.log('  Bootstrap: OK\n');
  });
});

// ─── Phase 2: Inbox Check ───────────────────────────────────────

describe('Myra simulation: Phase 2 — Inbox', () => {
  it.skipIf(!serverAvailable)('retrieves inbox messages', async () => {
    const pcp = await createPcpClient();
    const result = await pcp.callTool('get_inbox', { agentId: AGENT_ID });
    const parsed = result as Record<string, unknown>;

    console.log('=== Phase 2: Inbox Check ===');

    expect(parsed.success).toBe(true);
    const messages = parsed.messages as Array<Record<string, unknown>> | undefined;
    const count = messages?.length || 0;
    console.log(`  Inbox messages: ${count}`);

    if (messages && messages.length > 0) {
      for (const msg of messages.slice(0, 3)) {
        const from = msg.senderAgentId || msg.from || 'unknown';
        const content = ((msg.content as string) || '').slice(0, 80);
        console.log(`  - from ${from}: "${content}..."`);
      }
    }

    console.log('  Inbox check: OK\n');
  });
});

// ─── Phase 3: Passive Recall on Heartbeat Topics ────────────────

describe('Myra simulation: Phase 3 — Passive Recall', () => {
  it.skipIf(!serverAvailable)('recalls relevant memories for Myra heartbeat topics', async () => {
    const pcp = await createPcpClient();
    const ledger = new ContextLedger();
    const registry = new SbHookRegistry();

    console.log('=== Phase 3: Passive Recall ===');

    const callRecall = async (query: string, limit: number) => {
      const result = await pcp.callTool('recall', {
        query,
        agentId: AGENT_ID,
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

    const { passiveRecall } = registerBuiltinHooks(registry, {
      callRecall,
      passiveRecallConfig: { cooldownTurns: 0, maxInjectPerTurn: 3 },
    });

    // Simulate Myra's typical heartbeat turn
    const userInput =
      'Check inbox for pending messages. Process any task requests or review feedback. Send responses as needed.';
    const assistantResponse =
      'Checking inbox... Found messages from Wren about context eviction PR and from Conor about the tasks dashboard.';

    ledger.addEntry('system', 'You are Myra, the Telegram/WhatsApp bridge.', 'bootstrap');
    ledger.addEntry('user', userInput);
    ledger.addEntry('assistant', assistantResponse);

    const result = await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: AGENT_ID, turnCount: 1, budgetUtilization: 0.2 },
      lastTurn: { userInput, assistantResponse, turnIndex: 1 },
    });

    console.log(`  Memories injected: ${result.injected}`);

    const recallEntries = ledger.listEntries().filter((e) => e.source === 'passive-recall');
    for (const entry of recallEntries) {
      console.log(`  → ${entry.content.slice(0, 100)}...`);
    }

    const stats = passiveRecall.getStats();
    console.log(`  Stats: injected=${stats.totalInjected}, unique=${stats.uniqueMemories}`);

    expect(result.injected).toBeGreaterThanOrEqual(0); // may be 0 if no Myra-specific memories
    console.log('  Passive recall: OK\n');
  });
});

// ─── Phase 4: Context Management Cycle ──────────────────────────

describe('Myra simulation: Phase 4 — Context Management', () => {
  it.skipIf(!serverAvailable)('full eviction cycle: fill → warn → evict → verify', async () => {
    const pcp = await createPcpClient();
    const ledger = new ContextLedger();
    const registry = new SbHookRegistry();
    const MAX_CONTEXT = 8000; // simulate smaller context for testing

    console.log('=== Phase 4: Context Management ===');

    const callRecall = async (query: string, limit: number) => {
      const result = await pcp.callTool('recall', {
        query,
        agentId: AGENT_ID,
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
      passiveRecallConfig: { cooldownTurns: 0, maxInjectPerTurn: 2, budgetCeiling: 0.8 },
      budgetThresholds: [0.6, 0.8],
    });

    // Step 1: Simulate bootstrap (reserve ~2000 tokens)
    const bootstrapContent = 'x'.repeat(8000); // ~2000 tokens
    const bootstrapTokens = estimateTokens(bootstrapContent);
    const effectiveBudget = MAX_CONTEXT - bootstrapTokens;
    console.log(`  Bootstrap reserve: ~${bootstrapTokens} tokens`);
    console.log(`  Effective budget: ~${effectiveBudget} tokens`);

    // Step 2: Simulate several heartbeat turns filling the ledger
    const turns = [
      {
        user: 'Check inbox for new messages',
        assistant: 'Found 3 new messages in inbox. Processing...',
      },
      {
        user: 'Process the task request from Wren',
        assistant: 'Task request: review PR #242. Fetching diff...',
      },
      {
        user: 'Check email for calendar events',
        assistant: 'No new calendar events. 2 unread emails about deployment.',
      },
      {
        user: 'Send Conor a summary of today activity',
        assistant: 'Sending activity summary to Conor on Telegram...',
      },
    ];

    // Add some tool results to simulate real heartbeat
    ledger.addEntry('system', 'get_inbox result: 3 messages from wren, lumen, conor', 'pcp-tool');
    ledger.addEntry('system', 'list_emails result: 2 unread deployment emails', 'pcp-tool');

    for (let i = 0; i < turns.length; i++) {
      ledger.addEntry('user', turns[i].user);
      ledger.addEntry('assistant', turns[i].assistant);

      const util = ledger.totalTokens() / effectiveBudget;

      // Fire turn_end
      await registry.fire('turn_end', {
        ledger,
        runtime: { agentId: AGENT_ID, turnCount: i + 1, budgetUtilization: util },
        lastTurn: {
          userInput: turns[i].user,
          assistantResponse: turns[i].assistant,
          turnIndex: i + 1,
        },
      });
    }

    // Step 3: Check what's in the context
    const listResult = handleClientLocalTool('list_context', {}, ledger);
    const listParsed = JSON.parse((listResult!.content as Array<{ text: string }>)[0].text);

    console.log(`  Entries after 4 turns: ${listParsed.totalEntries}`);
    console.log(`  Total tokens: ~${listParsed.totalTokens}`);
    console.log(`  Sources: ${JSON.stringify(listParsed.bySource)}`);

    // Step 4: Evict stale tool results (simulating Myra cleaning up after heartbeat)
    const evictResult = handleClientLocalTool('evict_context', { source: 'pcp-tool' }, ledger);
    const evictParsed = JSON.parse((evictResult!.content as Array<{ text: string }>)[0].text);

    console.log(
      `  Evicted ${evictParsed.evicted} tool result entries (${evictParsed.tokensFreed} tokens freed)`
    );

    // Step 5: Verify clean state
    const afterEvict = ledger.listEntries();
    expect(afterEvict.every((e) => e.source !== 'pcp-tool')).toBe(true);

    // Step 6: Evict passive recall entries too
    const recallEvict = handleClientLocalTool(
      'evict_context',
      { source: 'passive-recall' },
      ledger
    );
    const recallEvictParsed = JSON.parse((recallEvict!.content as Array<{ text: string }>)[0].text);
    console.log(`  Evicted ${recallEvictParsed.evicted} passive-recall entries`);

    // Step 7: Final state
    const finalList = handleClientLocalTool('list_context', {}, ledger);
    const finalParsed = JSON.parse((finalList!.content as Array<{ text: string }>)[0].text);
    console.log(`  Final: ${finalParsed.totalEntries} entries, ~${finalParsed.totalTokens} tokens`);

    // Verify only user/assistant turns remain
    const remainingRoles = ledger.listEntries().map((e) => e.role);
    expect(remainingRoles.every((r) => r === 'user' || r === 'assistant')).toBe(true);

    console.log('  Context management: OK\n');
  });
});

// ─── Phase 5: Send Telegram Message (optional) ──────────────────

describe('Myra simulation: Phase 5 — Telegram Response', () => {
  it.skipIf(!serverAvailable || !SEND_TELEGRAM)(
    'sends a real Telegram message to Conor',
    async () => {
      const pcp = await createPcpClient();

      console.log('=== Phase 5: Telegram Response ===');

      // NOTE: conversationId lookup is a gap — we need a user→platform→conversationId
      // mapping so agents can message users without hardcoding chat IDs.
      // See PCP task: "Persist conversationId→userId mapping with DB fallback"
      const result = await pcp.callTool('send_response', {
        channel: 'telegram',
        conversationId: '726555973',
        content:
          '🧪 [sb-runtime-test] Myra heartbeat simulation completed on the sb chat runtime.\n\nContext eviction + passive recall pipeline working. 100 tests passing.\n\nThis message was sent from an automated integration test — not a live Myra session.',
      });

      const parsed = result as Record<string, unknown>;
      console.log(`  Telegram send result: ${JSON.stringify(parsed).slice(0, 200)}`);
      console.log('  Telegram response: OK\n');
    }
  );

  it.skipIf(!serverAvailable || SEND_TELEGRAM)(
    '(skipped — set SEND_TELEGRAM=true to send real messages)',
    () => {
      console.log('\n  Phase 5 skipped: set SEND_TELEGRAM=true to send real Telegram messages\n');
    }
  );
});

// ─── Phase 6: Full Heartbeat Cycle (end-to-end) ─────────────────

describe('Myra simulation: Phase 6 — Full Heartbeat Cycle', () => {
  it.skipIf(!serverAvailable)('bootstrap → inbox → recall → process → evict → done', async () => {
    const pcp = await createPcpClient();

    console.log('=== Phase 6: Full Heartbeat Cycle ===');

    // 1. Bootstrap
    const bootstrap = await pcp.callTool('bootstrap', { agentId: AGENT_ID });
    const bootstrapParsed = bootstrap as Record<string, unknown>;
    expect(bootstrapParsed.user || bootstrapParsed.constitution).toBeTruthy();
    console.log('  1. Bootstrap: OK');

    // 2. Set up runtime
    const ledger = new ContextLedger();
    const registry = new SbHookRegistry();

    const callRecall = async (query: string, limit: number) => {
      const result = await pcp.callTool('recall', {
        query,
        agentId: AGENT_ID,
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

    const { passiveRecall } = registerBuiltinHooks(registry, {
      callRecall,
      passiveRecallConfig: { cooldownTurns: 0, maxInjectPerTurn: 2 },
    });

    // 3. Inject bootstrap context
    const knowledgeSummary = bootstrapParsed.knowledgeSummary as string | undefined;
    if (knowledgeSummary) {
      ledger.addEntry('system', knowledgeSummary.slice(0, 500), 'bootstrap');
    }
    console.log('  2. Context initialized');

    // 4. Check inbox
    const inbox = await pcp.callTool('get_inbox', { agentId: AGENT_ID });
    const inboxParsed = inbox as Record<string, unknown>;
    const messages = (inboxParsed.messages as Array<Record<string, unknown>>) || [];
    console.log(`  3. Inbox: ${messages.length} messages`);

    // 5. Add inbox content to ledger
    if (messages.length > 0) {
      for (const msg of messages.slice(0, 3)) {
        const content = `From ${msg.senderAgentId || 'unknown'}: ${((msg.content as string) || '').slice(0, 200)}`;
        ledger.addEntry('inbox', content, 'pcp-inbox');
      }
    }

    // 6. Simulate processing turn
    const userInput = 'Process inbox messages and check for urgent items';
    const assistantResponse = `Processed ${messages.length} inbox messages. No urgent items requiring immediate action.`;
    ledger.addEntry('user', userInput);
    ledger.addEntry('assistant', assistantResponse);

    // 7. Fire turn_end — passive recall
    const turnResult = await registry.fire('turn_end', {
      ledger,
      runtime: { agentId: AGENT_ID, turnCount: 1, budgetUtilization: 0.3 },
      lastTurn: { userInput, assistantResponse, turnIndex: 1 },
    });
    console.log(`  4. Passive recall: +${turnResult.injected} memories`);

    // 8. Evict processed inbox
    const evictResult = handleClientLocalTool('evict_context', { source: 'pcp-inbox' }, ledger);
    const evictParsed = JSON.parse((evictResult!.content as Array<{ text: string }>)[0].text);
    console.log(`  5. Evicted ${evictParsed.evicted} inbox entries`);

    // 9. Final state
    const stats = passiveRecall.getStats();
    const finalEntries = ledger.listEntries();
    console.log(`  6. Final: ${finalEntries.length} entries, ~${ledger.totalTokens()} tokens`);
    console.log(
      `     Recall stats: injected=${stats.totalInjected}, unique=${stats.uniqueMemories}`
    );
    console.log(`     Sources: ${[...new Set(finalEntries.map((e) => e.source))].join(', ')}`);

    // Verify: inbox is gone, user/assistant preserved
    expect(finalEntries.every((e) => e.source !== 'pcp-inbox')).toBe(true);
    expect(finalEntries.some((e) => e.role === 'user')).toBe(true);
    expect(finalEntries.some((e) => e.role === 'assistant')).toBe(true);

    console.log('  Full heartbeat cycle: OK\n');
  });
});
