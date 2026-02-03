/**
 * Compaction Integration Test
 *
 * End-to-end tests that verify the two-phase compaction flow:
 * 1. SessionHost detects token usage exceeding the compaction threshold
 * 2. Sends a compaction message to the real Claude Code backend
 * 3. Claude processes the compaction prompt, calling MCP tools (compact_session, remember, etc.)
 * 4. Session is rotated after compaction completes
 *
 * These tests spawn real Claude Code processes and hit the real database.
 * They are excluded from `yarn test` and run via `yarn test:integration`.
 *
 * Token budget note: A single Claude Code message with MCP tools loaded uses
 * ~25k input tokens (system prompt + tool definitions + prompt cache). Thresholds
 * are calibrated around this baseline.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createEchoTestHost, waitForEvent, type EchoTestHost } from '../test/integration-helpers';
import type { ChannelType } from './types';

describe('Compaction (end-to-end)', () => {
  let echoHost: EchoTestHost | null = null;

  afterEach(async () => {
    if (echoHost) {
      await echoHost.cleanup();
      echoHost = null;
    }
  });

  it('should trigger compaction, persist memories, and rotate', async () => {
    // A single message uses ~25k tokens base, but can spike to 250k+ if the
    // model makes MCP tool calls. Set compaction low (20k) to always trigger,
    // and hard rotation very high (900k) so it never pre-empts compaction.
    // Once compaction starts, `compactionInProgress` prevents hard rotation.
    echoHost = await createEchoTestHost({
      maxContextTokens: 1000000,
      compactionThreshold: 0.02,    // 20k — always hit by the first message
      hardRotationThreshold: 0.9,   // 900k — effectively unreachable
    });

    const { sessionHost, dataComposer, userId } = echoHost;

    // Debug: log token usage and lifecycle events
    const backendManager = (sessionHost as any).backendManager;
    backendManager.on('session:usage', (usage: any) => {
      console.log(`[TEST] session:usage — input: ${usage.inputTokens}, output: ${usage.outputTokens}`);
    });
    sessionHost.on('session:compactionStarted', () => console.log('[TEST] compaction started'));
    sessionHost.on('session:compactionComplete', () => console.log('[TEST] compaction complete'));
    sessionHost.on('session:compactionFailed', (d: any) => console.log('[TEST] compaction failed:', d.error?.message));
    sessionHost.on('session:rotated', () => console.log('[TEST] session rotated'));

    // Subscribe to events BEFORE sending the message
    const compactionStarted = waitForEvent(sessionHost, 'session:compactionStarted', 90000);
    const sessionRotated = waitForEvent(sessionHost, 'session:rotated', 90000);

    // Send a message with high-priority content we want to see saved
    await sessionHost.handleMessage(
      'terminal' as ChannelType,
      'echo-integration-test',
      { id: 'integration-test', name: 'Integration Test' },
      'Hello Echo. Here are important facts to remember:\n' +
      '1. Project launch date is March 15, 2026\n' +
      '2. Critical API key rotation must happen before launch\n' +
      '3. The staging environment URL is staging.example.com\n' +
      'Please acknowledge these facts briefly.',
      { userId }
    );

    // Wait for the compaction lifecycle (compaction fires, then rotation follows)
    await compactionStarted;
    await sessionRotated;

    // Verify session was rotated
    expect(sessionHost.getSessionId()).toBeNull();

    // Check database for memories created by echo during compaction.
    // The agent uses `remember` which sets agent_id='echo' but source='session'.
    const client = dataComposer.getClient();
    const { data: memories } = await client
      .from('memories')
      .select('*')
      .eq('user_id', userId)
      .eq('agent_id', 'echo')
      .order('created_at', { ascending: false });

    console.log(`[TEST] Echo memories found: ${memories?.length ?? 0}`);
    if (memories && memories.length > 0) {
      for (const memory of memories) {
        console.log(`[TEST] Memory: topics=${JSON.stringify(memory.topics)}, salience=${memory.salience}`);
        console.log(`[TEST]   Content: ${memory.content.substring(0, 300)}${memory.content.length > 300 ? '...' : ''}`);
      }
    }

    // Echo should have created at least one memory during compaction
    expect(memories).toBeDefined();
    expect(memories!.length).toBeGreaterThanOrEqual(1);

    // The memory should be a consolidated session summary
    const summary = memories!.find(m =>
      m.topics && (m.topics as string[]).includes('session-summary')
    );
    expect(summary).toBeDefined();
    expect(summary!.salience).toBe('high');
  });

  it('should hard-rotate when tokens exceed the hard threshold', async () => {
    // Both thresholds well below the ~25k single-message usage.
    // Hard rotation (15k) triggers before compaction can start.
    echoHost = await createEchoTestHost({
      maxContextTokens: 20000,
      // compaction at 15k, hard rotate at 17k — both below 25k
    });

    const { sessionHost, userId } = echoHost;

    const sessionRotated = waitForEvent(sessionHost, 'session:rotated', 90000);

    await sessionHost.handleMessage(
      'terminal' as ChannelType,
      'echo-hard-rotate-test',
      { id: 'integration-test', name: 'Integration Test' },
      'Hello Echo.',
      { userId }
    );

    await sessionRotated;

    // Session ID should be cleared after rotation
    expect(sessionHost.getSessionId()).toBeNull();
  });
});
