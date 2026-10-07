/**
 * No provider tools, latched at the dispatch seam (task 0321ccf1).
 *
 * `ink chat --no-provider-tools`, or the inkling profile, latches this once
 * for the process. Every spawn the chat makes passes startBackendTurn, so the
 * restriction is pinned here, on what reaches the adapter: the parent's turn,
 * compaction (which names no routing), a caller asking for backend routing
 * with arguments that would reopen tools, and a backend that can't withhold
 * its own.
 */

import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  prepareConfigs: [] as Array<Record<string, unknown>>,
}));

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('../backends/index.js', () => ({
  getBackend: (backend: string) => ({
    name: backend,
    binary: 'mock-backend',
    prepare: (config: Record<string, unknown>) => {
      state.prepareConfigs.push({ backend, ...config });
      return { binary: 'mock-backend', args: [], env: {}, cleanup: () => undefined };
    },
  }),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

function closingChild(): EventEmitter {
  const stream = (): EventEmitter & { setEncoding: () => void } =>
    Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  const child = Object.assign(new EventEmitter(), { stdout: stream(), stderr: stream() });
  queueMicrotask(() => child.emit('close', 0));
  return child;
}

// A fresh module per test: the latch has no way to be cleared, by design.
async function freshRunner(): Promise<typeof import('./backend-runner.js')> {
  vi.resetModules();
  return import('./backend-runner.js');
}

const REOPENING_ARGS = ['--tools', 'Bash,Read', '--add-dir', '/', '--dangerously-skip-permissions'];

describe('startBackendTurn with provider tools withheld', () => {
  beforeEach(() => {
    state.prepareConfigs = [];
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => closingChild());
  });

  it('passes a request through unchanged until the chat latches it (the control)', async () => {
    const runner = await freshRunner();
    expect(runner.providerToolsWithheldForThisProcess()).toBe(false);
    await runner.runBackendTurn({
      backend: 'claude',
      sbSlug: 'kindle-0a1b2c3d',
      prompt: 'ping',
      toolRouting: 'backend',
      passthroughArgs: REOPENING_ARGS,
      cliAttached: false,
    });
    expect(state.prepareConfigs[0]).toMatchObject({
      toolRouting: 'backend',
      passthroughArgs: REOPENING_ARGS,
    });
    expect('withholdProviderTools' in state.prepareConfigs[0]!).toBe(false);
  });

  it('gives every claude spawn local routing, no passthrough and the withheld flag, whatever it asked for', async () => {
    const runner = await freshRunner();
    runner.withholdProviderToolsForThisProcess();
    const requests = [
      // The parent's own turn.
      { toolRouting: 'local' as const, passthroughArgs: ['--allowedTools', ''] },
      // Compaction, which names no routing at all.
      {},
      // A caller asking for the provider's loop, with arguments that would undo it.
      { toolRouting: 'backend' as const, passthroughArgs: REOPENING_ARGS },
      // A resume and a fresh seed.
      { toolRouting: 'local' as const, backendSessionId: 'resumed-provider-session' },
      { toolRouting: 'local' as const, backendSessionSeedId: 'seeded-provider-session' },
    ];
    for (const extra of requests) {
      await runner.runBackendTurn({
        backend: 'claude',
        sbSlug: 'kindle-0a1b2c3d',
        prompt: 'ping',
        cliAttached: false,
        ...extra,
      });
    }
    expect(state.prepareConfigs).toHaveLength(requests.length);
    for (const config of state.prepareConfigs) {
      expect(config.toolRouting).toBe('local');
      expect(config.passthroughArgs).toEqual([]);
      expect(config.withholdProviderTools).toBe(true);
    }
    expect(runner.providerToolsWithheldForThisProcess()).toBe(true);
  });

  it('refuses a backend that runs tools of its own, before anything is prepared or spawned', async () => {
    const runner = await freshRunner();
    runner.withholdProviderToolsForThisProcess();
    for (const backend of ['codex', 'gemini']) {
      const result = await runner.runBackendTurn({
        backend,
        sbSlug: 'kindle-0a1b2c3d',
        prompt: 'ping',
        toolRouting: 'local',
        cliAttached: false,
      });
      expect(result.success, backend).toBe(false);
      expect(result.exitCode, backend).toBe(78);
      expect(result.stderr, backend).toContain(`the ${backend} backend can't withhold its own`);
    }
    expect(state.prepareConfigs).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
