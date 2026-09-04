import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * Source-level pin of the two production hosts of runAgentLoop (Lumen, PR
 * #576 rounds 3–5): both must ask for a live relay budget, both must hand it
 * the provider's own occupancy when reported, only reusable sessions may
 * accumulate resident traffic, and the clone's window is the one it was
 * spawned into. The budget arithmetic has its own unit tests; this pins the
 * wiring a unit test cannot reach.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'chat.ts'), 'utf8');

const loopCalls = [...source.matchAll(/await runAgentLoop\(\s*\{([\s\S]*?)\n\s*\},\s*\{/g)].map(
  (m) => m[1]!
);
const noteSpawn = source.slice(
  source.indexOf('const noteSpawn = (result: BackendRunResult): void => {'),
  source.indexOf('/** The continuation spawn')
);

describe('runAgentLoop hosts and their relay budgets', () => {
  it('there are exactly two production hosts: the parent turn and the clone', () => {
    expect(loopCalls).toHaveLength(2);
  });

  it('every host supplies a live relay budget — none takes the static default', () => {
    for (const input of loopCalls) expect(input).toContain('relayBudgetBytes: () =>');
  });

  it('each host hands its budget an occupancy: the report for a native session, the whole prepared spawn for a stateless one (Lumen, rounds 6–7)', () => {
    const parent = loopCalls.find((c) => c.includes('relayOccupancy()'))!;
    const clone = loopCalls.find((c) => c.includes('cloneOccupancyTokens'))!;
    expect(parent).toBeDefined();
    expect(source).toMatch(
      /const relayOccupancy = \(\): number \| undefined =>\s*nativeSession\(\)\s*\? loopOccupancyTokens\s*: measurePreparedPromptBytes\(\s*continuationRequest\(buildPromptEnvelope\(agentId, runtime, ledger, ''\)\)\s*\);/
    );
    expect(clone).toMatch(
      /measurePreparedPromptBytes\(\s*cloneRequest\(\[\.\.\.cloneHistory, ''\]\.join/
    );
  });

  it('the continuation spawn and the measurement share one request shape', () => {
    expect(source).toContain(
      'const contTurn = startBackendTurn(continuationRequest(continuationPrompt));'
    );
    expect(source).toContain('const turn = startBackendTurn(cloneRequest(prompt, sessionArgs));');
  });

  it("the clone's window is frozen at spawn — never the parent's mutable runtime (Lumen, round 4)", () => {
    const clone = loopCalls.find((c) => c.includes('cloneOccupancyTokens'))!;
    expect(clone).toContain('maxContextTokens: cloneMaxContextTokens');
    expect(clone).not.toContain('runtime.maxContextTokens');
    expect(source).toContain('const cloneMaxContextTokens = runtime.maxContextTokens;');
  });

  it('a native spawn that reported nothing leaves the window UNKNOWN — no stale checkpoint, no visible-text top-up (Lumen, round 7)', () => {
    expect(source).toContain('noteSpawn(runResult);');
    expect(source).toContain('noteSpawn(contResult);');
    expect(noteSpawn).toMatch(
      /if \(!nativeSession\(\)\) return;\s*loopOccupancyTokens = occupancyTokens\(runtime\.backend, result\.usage\);/
    );
    expect(source).not.toMatch(/ResidentBytes/);
    expect(source).toMatch(
      /if \(cloneCanReuseSession\)\s*cloneOccupancyTokens = occupancyTokens\(cloneBackend, result\.usage\);/
    );
  });
});
