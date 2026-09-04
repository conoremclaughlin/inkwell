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
  source.indexOf(
    'const noteSpawn = (result: BackendRunResult, ledgerIdBeforeSpawn: number): void => {'
  ),
  source.indexOf('/** The continuation spawn')
);

describe('runAgentLoop hosts and their relay budgets', () => {
  it('there are exactly two production hosts: the parent turn and the clone', () => {
    expect(loopCalls).toHaveLength(2);
  });

  it('every host supplies a live relay budget — none takes the static default', () => {
    for (const input of loopCalls) expect(input).toContain('relayBudgetBytes: () =>');
  });

  it("each host hands its budget an occupancy from the provider's reports — native: the last occupancy; stateless: the last prompt plus the rendered bytes of entries added since (Lumen, rounds 6–11)", () => {
    const parent = loopCalls.find((c) => c.includes('relayOccupancy()'))!;
    const clone = loopCalls.find((c) => c.includes('cloneOccupancyTokens'))!;
    expect(parent).toBeDefined();
    expect(clone).toBeDefined();
    expect(source).toMatch(
      /const relayOccupancy = \(\): number \| undefined => \{\s*if \(nativeSession\(\)\) return loopOccupancyTokens;\s*if \(statelessPromptTokens === undefined\) return undefined;\s*const addedBytes = ledger\s*\.listEntries\(\)\s*\.filter\(\(e\) => e\.id > ledgerMaxIdAtReport\)\s*\.reduce\(\(n, e\) => n \+ ledgerEntryPromptBytes\(e\), 0\);\s*return statelessPromptTokens \+ addedBytes;/
    );
    // Never a net total: an eviction of older entries cannot hide an addition.
    expect(source).not.toMatch(/ledger\.totalTokens\(\) - ledgerTokensAtReport/);
    expect(source).not.toMatch(/measurePreparedPromptBytes|hiddenContextBytes|MEDIA_TOKEN_RESERVE/);
  });

  it('the continuation and clone spawns go through their request builders', () => {
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

  it('a native spawn that reported nothing leaves the window UNKNOWN; a stateless one records the prompt count and the high-water id captured BEFORE the spawn (Lumen, rounds 7–12)', () => {
    expect(source).toContain('noteSpawn(runResult, ledgerIdBeforeSpawn);');
    expect(source).toContain('noteSpawn(contResult, ledgerIdBeforeSpawn);');
    expect(noteSpawn).toMatch(
      /if \(nativeSession\(\)\) \{\s*loopOccupancyTokens = occupancyTokens\(runtime\.backend, result\.usage\);\s*return;\s*\}/
    );
    expect(noteSpawn).toMatch(
      /statelessPromptTokens = promptTokensOf\(runtime\.backend, result\.usage\);[\s\S]*?ledgerMaxIdAtReport = ledgerIdBeforeSpawn;/
    );
    // Captured with request construction, before the awaited spawn — both paths.
    const initialCapture = source.indexOf('const ledgerIdBeforeSpawn = maxLedgerId();');
    const initialSpawn = source.indexOf('const turn = startBackendTurn({', initialCapture);
    expect(initialCapture).toBeGreaterThan(0);
    expect(initialSpawn - initialCapture).toBeLessThan(120);
    const contCapture = source.indexOf(
      'const ledgerIdBeforeSpawn = maxLedgerId();',
      initialCapture + 1
    );
    const contSpawn = source.indexOf(
      'const contTurn = startBackendTurn(continuationRequest(continuationPrompt));'
    );
    expect(contCapture).toBeGreaterThan(0);
    expect(contSpawn - contCapture).toBeLessThan(120);
    expect(contSpawn).toBeGreaterThan(contCapture);
    expect(source).not.toMatch(/ResidentBytes/);
    expect(source).toMatch(
      /cloneOccupancyTokens = cloneCanReuseSession\s*\?\s*occupancyTokens\(cloneBackend, result\.usage\)/
    );
    expect(source).toMatch(
      /const prompt = promptTokensOf\(cloneBackend, result\.usage\);[\s\S]*?return prompt === undefined\s*\? undefined\s*: prompt \+ utf8Bytes\(text\) \+ 2 \* utf8Bytes\(CLONE_HISTORY_SEPARATOR\);/
    );
    expect(source).toMatch(/join\(CLONE_HISTORY_SEPARATOR\)/);
  });

  it('a context-mutating local tool drops the stateless count to unknown until the next report (Lumen, round 12)', () => {
    expect(source).toMatch(
      /if \(CONTEXT_MUTATING_TOOLS\.has\(bareToolName\(result\.tool\)\)\) \{\s*statelessPromptTokens = undefined;\s*\}/
    );
  });
});
