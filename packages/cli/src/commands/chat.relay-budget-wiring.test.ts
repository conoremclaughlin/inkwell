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
  source.indexOf('const noteSpawn = ('),
  source.indexOf('/** The continuation spawn')
);

describe('runAgentLoop hosts and their relay budgets', () => {
  it('there are exactly two production hosts: the parent turn and the clone', () => {
    expect(loopCalls).toHaveLength(2);
  });

  it('every host supplies a live relay budget — none takes the static default', () => {
    for (const input of loopCalls) expect(input).toContain('relayBudgetBytes: () =>');
  });

  it("each host hands its budget an occupancy from the provider's reports — native: the last occupancy; stateless: the last prompt plus the rendered bytes of entries added since, within its generation (Lumen, rounds 6–13)", () => {
    const parent = loopCalls.find((c) => c.includes('relayOccupancy()'))!;
    const clone = loopCalls.find((c) => c.includes('cloneOccupancyTokens'))!;
    expect(parent).toBeDefined();
    expect(clone).toBeDefined();
    expect(source).toMatch(
      /const relayOccupancy = \(\): number \| undefined => \{\s*if \(nativeSession\(\)\) return loopOccupancyTokens;\s*if \(statelessPromptTokens === undefined\) return undefined;[\s\S]*?if \(mutationsInFlight > 0 \|\| statelessGenerationAtReport !== contextGeneration\) \{\s*return undefined;\s*\}\s*const addedBytes = ledger\s*\.listEntries\(\)\s*\.filter\(\(e\) => e\.id > ledgerMaxIdAtReport\)\s*\.reduce\(\(n, e\) => n \+ ledgerEntryPromptBytes\(e\), 0\);\s*return statelessPromptTokens \+ addedBytes;/
    );
    // Never a net total: an eviction of older entries cannot hide an addition.
    expect(source).not.toMatch(/ledger\.totalTokens\(\) - ledgerTokensAtReport/);
    expect(source).not.toMatch(/measurePreparedPromptBytes|hiddenContextBytes|MEDIA_TOKEN_RESERVE/);
  });

  it("the continuation spawn goes through the request builder WITH the decision's session args and delivery (Lumen, PR #577 final pass)", () => {
    expect(source).toMatch(
      /const contTurn = startBackendTurn\(\s*continuationRequest\(\s*continuationPrompt,\s*continuationSpawnArgs\(decision, turnMedia\.length > 0\)\s*\)\s*\);/
    );
    expect(source).toContain('const turn = startBackendTurn(cloneRequest(prompt, sessionArgs));');
    const builder = source.slice(
      source.indexOf('const continuationRequest = ('),
      source.indexOf('/**\n     * What the window holds for the next relay')
    );
    expect(builder).toContain('...spawn.sessionArgs,');
    expect(builder).toMatch(/\.\.\.\(spawn\.deliverMedia \? \{ deliverMedia: true \} : \{\}\),/);
    expect(builder).not.toContain('backendSessionId: activeBackendSessionId');
  });

  it("the clone's window is frozen at spawn — never the parent's mutable runtime (Lumen, round 4)", () => {
    const clone = loopCalls.find((c) => c.includes('cloneOccupancyTokens'))!;
    expect(clone).toContain('maxContextTokens: cloneMaxContextTokens');
    expect(clone).not.toContain('runtime.maxContextTokens');
    expect(source).toContain('const cloneMaxContextTokens = runtime.maxContextTokens;');
  });

  it('a native spawn that reported nothing leaves the window UNKNOWN; a stateless one records the prompt count, the high-water id and the generation captured BEFORE the spawn (Lumen, rounds 7–13)', () => {
    expect(source).toContain('noteSpawn(runResult, ledgerIdBeforeSpawn, generationBeforeSpawn);');
    expect(source).toContain('noteSpawn(contResult, ledgerIdBeforeSpawn, generationBeforeSpawn);');
    expect(noteSpawn).toMatch(
      /if \(nativeSession\(\)\) \{\s*loopOccupancyTokens = occupancyTokens\(runtime\.backend, result\.usage\);\s*return;\s*\}/
    );
    expect(noteSpawn).toMatch(
      /statelessPromptTokens = promptTokensOf\(runtime\.backend, result\.usage\);[\s\S]*?ledgerMaxIdAtReport = ledgerIdBeforeSpawn;\s*statelessGenerationAtReport = generationBeforeSpawn;/
    );
    // Captured with request construction, before the awaited spawn — both paths.
    const initialCapture = source.indexOf('const ledgerIdBeforeSpawn = maxLedgerId();');
    const initialSpawn = source.indexOf('const turn = startBackendTurn({', initialCapture);
    expect(initialCapture).toBeGreaterThan(0);
    expect(initialSpawn - initialCapture).toBeLessThan(200);
    const contCapture = source.indexOf(
      'const ledgerIdBeforeSpawn = maxLedgerId();',
      initialCapture + 1
    );
    const contSpawn = source.search(
      /const contTurn = startBackendTurn\(\s*continuationRequest\(\s*continuationPrompt,\s*continuationSpawnArgs\(decision, turnMedia\.length > 0\)\s*\)\s*\);/
    );
    expect(contCapture).toBeGreaterThan(0);
    expect(contSpawn).toBeGreaterThan(contCapture);
    expect(contSpawn - contCapture).toBeLessThan(200);
    expect(source).not.toMatch(/ResidentBytes/);
    expect(source).toMatch(
      /cloneOccupancyTokens = cloneCanReuseSession\s*\?\s*occupancyTokens\(cloneBackend, result\.usage\)/
    );
    expect(source).toMatch(
      /const prompt = promptTokensOf\(cloneBackend, result\.usage\);[\s\S]*?return prompt === undefined\s*\? undefined\s*: prompt \+ utf8Bytes\(text\) \+ 2 \* utf8Bytes\(CLONE_HISTORY_SEPARATOR\);/
    );
    expect(source).toMatch(/join\(CLONE_HISTORY_SEPARATOR\)/);
  });

  it('a session-wide context generation covers the whole mutation lifetime — bumped before a mutating call runs and again when it settles, in both executors, with no count trusted while one is in flight (Lumen, rounds 13–14)', () => {
    expect(source).toMatch(
      /const beginContextMutationFor = \(\s*calls: ReadonlyArray<\{ tool: string \}>\s*\): \(\(\) => void\) => \{\s*if \(!calls\.some\(\(c\) => CONTEXT_MUTATING_TOOLS\.has\(bareToolName\(c\.tool\)\)\)\) return \(\) => \{\};\s*contextGeneration \+= 1;\s*mutationsInFlight \+= 1;\s*return \(\) => \{\s*mutationsInFlight -= 1;\s*contextGeneration \+= 1;\s*\};/
    );
    const wraps =
      source.match(
        /const settleContextMutation = beginContextMutationFor\(calls\);\s*try \{\s*await executeToolCalls\([\s\S]*?\} finally \{\s*settleContextMutation\(\);\s*\}/g
      ) ?? [];
    expect(wraps).toHaveLength(2);
    expect(source).toMatch(
      /const generationBeforeSpawn = contextGeneration;\s*(?:beginSpawn\(\);\s*)?const turn = startBackendTurn\(\{/
    );
    expect(source).toMatch(
      /const generationBeforeSpawn = contextGeneration;\s*const contTurn = startBackendTurn\(\s*continuationRequest\(\s*continuationPrompt,\s*continuationSpawnArgs\(decision, turnMedia\.length > 0\)\s*\)\s*\);/
    );
    expect(source).toMatch(
      /const generationBeforeSpawn = contextGeneration;\s*const turn = startBackendTurn\(cloneRequest\(prompt, sessionArgs\)\);/
    );
    expect(source).toMatch(
      /if \(mutationsInFlight > 0 \|\| statelessGenerationAtReport !== contextGeneration\) \{\s*return undefined;/
    );
    expect(source).toMatch(
      /cloneCanReuseSession \|\|\s*\(mutationsInFlight === 0 && cloneGenerationAtReport === contextGeneration\)\s*\? cloneOccupancyTokens\s*: undefined/
    );
    expect(source).not.toMatch(/statelessPromptTokens = undefined;\s*\}\s*iterationResults\.push/);
  });
});
