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
  source.indexOf('const noteSpawn = (body: string, result: BackendRunResult): void => {'),
  source.indexOf('const runTurnForLoop = async (')
);

describe('runAgentLoop hosts and their relay budgets', () => {
  it('there are exactly two production hosts: the parent turn and the clone', () => {
    expect(loopCalls).toHaveLength(2);
  });

  it('every host supplies a live relay budget — none takes the static default', () => {
    for (const input of loopCalls) expect(input).toContain('relayBudgetBytes: () =>');
  });

  it('each host hands its budget an occupancy: the report for a native session, the packed envelope bytes for a stateless one (Lumen, round 6)', () => {
    const parent = loopCalls.find((c) => c.includes('loopResidentBytes'))!;
    const clone = loopCalls.find((c) => c.includes('cloneResidentBytes'))!;
    expect(parent).toContain('relayOccupancy()');
    expect(source).toMatch(
      /const relayOccupancy = \(\): number \| undefined =>\s*nativeSession\(\)\s*\? loopOccupancyTokens\s*: utf8Bytes\(buildPromptEnvelope\(agentId, runtime, ledger, ''\)\);/
    );
    expect(clone).toContain('cloneOccupancyTokens');
    expect(clone).toMatch(/utf8Bytes\(cloneIdentityPrompt\) \+ utf8Bytes\(cloneHistory\.join/);
  });

  it("the clone's window is frozen at spawn — never the parent's mutable runtime (Lumen, round 4)", () => {
    const clone = loopCalls.find((c) => c.includes('cloneResidentBytes'))!;
    expect(clone).toContain('maxContextTokens: cloneMaxContextTokens');
    expect(clone).toContain('cloneIdentityPrompt');
    expect(clone).not.toContain('runtime.maxContextTokens');
    expect(clone).not.toContain('runtime.systemPromptOverride');
    expect(source).toContain('const cloneMaxContextTokens = runtime.maxContextTokens;');
  });

  it('every parent spawn result is noted, and a provider report resets resident traffic (Lumen, round 5)', () => {
    expect(source).toContain('noteSpawn(body, runResult);');
    expect(source).toContain('noteSpawn(body, contResult);');
    expect(noteSpawn).toContain(
      'const occupancy = occupancyTokens(runtime.backend, result.usage);'
    );
    expect(noteSpawn).toMatch(/loopOccupancyTokens = occupancy;\s*loopResidentBytes = 0;/);
  });

  it("a stateless parent never carries a dead process's report or accumulates — it leaves noteSpawn at once (Lumen, rounds 5–6)", () => {
    expect(noteSpawn).toMatch(/if \(!nativeSession\(\)\) return;/);
    expect(noteSpawn).toMatch(
      /loopResidentBytes \+= utf8Bytes\(body\) \+ utf8Bytes\(result\.responseText \?\? ''\);/
    );
    expect(source).not.toMatch(/loopResidentBytes \+= [^;]*continuationPrompt/);
  });

  it('the clone records a report or accumulates only for a native session; a stateless one is measured at budget time', () => {
    expect(source).toMatch(
      /if \(cloneCanReuseSession\) \{[\s\S]*?cloneOccupancyTokens = cloneOccupancy;\s*cloneResidentBytes = 0;/
    );
    expect(source).toMatch(/cloneResidentBytes \+= utf8Bytes\(prompt\) \+ utf8Bytes\(text\);/);
  });
});
