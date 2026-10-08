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
const cli = readFileSync(join(here, 'chat.ts'), 'utf8');
const clones = readFileSync(join(here, '../../../shared/src/node-host/session-clones.ts'), 'utf8');
const source = cli + '\n' + clones;
const provider = readFileSync(
  join(here, '../../../shared/src/providers/session-provider.ts'),
  'utf8'
);

const parentComposition = readFileSync(
  join(here, '../../../shared/src/providers/session-agent-turn.ts'),
  'utf8'
);
const loopCalls = [
  ...`${source}\n${parentComposition}`.matchAll(
    /await runAgentLoop\(\s*\{([\s\S]*?)\n\s*\},\s*\{/g
  ),
].map((m) => m[1]!);
const noteSpawn = provider.slice(
  provider.indexOf('const noteSpawn = ('),
  provider.indexOf('/** The continuation spawn')
);

describe('runAgentLoop hosts and their relay budgets', () => {
  it('there are exactly two production hosts: the parent turn and the clone', () => {
    expect(loopCalls).toHaveLength(2);
    expect(cli).toMatch(
      /createSessionClones\(\{[\s\S]*?registry: cloneRegistry,\s*sessionContext,/
    );
    expect(source.match(/await runSessionAgentTurn\(/g)).toHaveLength(1);
    expect(source).not.toContain('createSessionProviderTurn(');
    expect(parentComposition).toContain('backend: { runTurn: providerTurn.runTurn }');
  });

  it('every host supplies a live relay budget — none takes the static default', () => {
    for (const input of loopCalls) expect(input).toContain('relayBudgetBytes: () =>');
  });

  it("each host hands its budget an occupancy from the provider's reports — native: the last occupancy; stateless: the last prompt plus the rendered bytes of entries added since, within its generation (Lumen, rounds 6–13)", () => {
    const parent = loopCalls.find((c) => c.includes('relayOccupancy()'))!;
    const clone = loopCalls.find((c) => c.includes('cloneOccupancyTokens'))!;
    expect(parent).toBeDefined();
    expect(parent).toContain('providerTurn.relayOccupancy()');
    expect(source).toContain('contextGeneration: () => sessionContext.generation');
    expect(source).toContain('mutationsInFlight: () => sessionContext.mutationsInFlight');
    expect(clone).toBeDefined();
    expect(provider).toMatch(
      /const relayOccupancy = \(\): number \| undefined => \{\s*if \(nativeSession\(\)\) return loopOccupancyTokens;\s*if \(statelessPromptTokens === undefined\) return undefined;[\s\S]*?if \(\s*ports\.mutationsInFlight\(\) > 0 \|\|\s*statelessGenerationAtReport !== ports\.contextGeneration\(\)\s*\) \{\s*return undefined;\s*\}\s*const addedBytes = ledger\s*\.listEntries\(\)\s*\.filter\(\(e\) => e\.id > ledgerMaxIdAtReport\)\s*\.reduce\(\(n, e\) => n \+ ledgerEntryPromptBytes\(e\), 0\);\s*return statelessPromptTokens \+ addedBytes;/
    );
    // Never a net total: an eviction of older entries cannot hide an addition.
    expect(source).not.toMatch(/ledger\.totalTokens\(\) - ledgerTokensAtReport/);
    expect(source).not.toMatch(/measurePreparedPromptBytes|hiddenContextBytes|MEDIA_TOKEN_RESERVE/);
  });

  it("the continuation spawn goes through the request builder WITH the decision's session args and delivery (Lumen, PR #577 final pass)", () => {
    expect(provider).toMatch(
      /const contTurn = ports\.startTurn\(\s*continuationRequest\(\s*continuationPrompt,\s*contSpawn,\s*contImages\)\s*\);/
    );
    // Keep the main-branch image delivery target coupled to the shared decision.
    expect(provider).toContain(
      'const contSpawn = continuationSpawnArgs(decision, turnMedia.length > 0);'
    );
    expect(provider).toMatch(
      /const contSessionId =\s*contSpawn\.sessionArgs\.backendSessionId \?\? contSpawn\.sessionArgs\.backendSessionSeedId;\s*const contImages = ports\.contextImagesFor\?\.\(contSessionId\);/
    );
    expect(source).toContain('const turn = ports.startTurn(cloneRequest(prompt, sessionArgs));');
    const builder = provider.slice(
      provider.indexOf('const continuationRequest = ('),
      provider.indexOf('const relayOccupancy =')
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
    expect(provider).toContain('noteSpawn(runResult, ledgerIdBeforeSpawn, generationBeforeSpawn);');
    expect(provider).toContain(
      'noteSpawn(contResult, ledgerIdBeforeSpawn, generationBeforeSpawn);'
    );
    expect(noteSpawn).toMatch(
      /if \(nativeSession\(\)\) \{\s*loopOccupancyTokens = occupancyTokens\(runtime\.backend, result\.usage\);\s*return;\s*\}/
    );
    expect(noteSpawn).toMatch(
      /statelessPromptTokens = promptTokensOf\(runtime\.backend, result\.usage\);[\s\S]*?ledgerMaxIdAtReport = ledgerIdBeforeSpawn;\s*statelessGenerationAtReport = generationBeforeSpawn;/
    );
    // Captured with request construction, before the awaited spawn — both paths.
    const initialCapture = provider.indexOf('const ledgerIdBeforeSpawn = maxLedgerId();');
    const initialSpawn = provider.indexOf('const turn = ports.startTurn({', initialCapture);
    expect(initialCapture).toBeGreaterThan(0);
    expect(provider.slice(initialCapture, initialSpawn).replace(/\s+/g, ' ').trim()).toBe(
      'const ledgerIdBeforeSpawn = maxLedgerId(); const generationBeforeSpawn = ports.contextGeneration(); let runResult: BackendRunResult; await beforeDispatch(ctx.signal); ports.beginSpawn(); try {'
    );
    const contCapture = provider.indexOf(
      'const ledgerIdBeforeSpawn = maxLedgerId();',
      initialCapture + 1
    );
    const contSpawn = provider.search(
      /const contTurn = ports\.startTurn\(\s*continuationRequest\(\s*continuationPrompt,\s*contSpawn,\s*contImages\)\s*\);/
    );
    expect(contCapture).toBeGreaterThan(0);
    expect(contSpawn).toBeGreaterThan(contCapture);
    expect(provider.slice(contCapture, contSpawn).replace(/\s+/g, ' ').trim()).toBe(
      'const ledgerIdBeforeSpawn = maxLedgerId(); const generationBeforeSpawn = ports.contextGeneration(); await beforeDispatch(ctx.signal); ports.beginSpawn(); try {'
    );
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
      /const beginContextMutationFor = [\s\S]*?sessionContext\.beginMutation\(calls\);/
    );
    // Lifetime accounting is exercised directly in session-context-state.test;
    // these pins ensure both real executors share that same session object.
    const wraps =
      source.match(
        /const settleContextMutation = sessionContext\.beginMutation\(calls\);\s*try \{\s*await executeToolCalls\([\s\S]*?\} finally \{\s*settleContextMutation\(\);\s*\}/g
      ) ?? [];
    expect(wraps).toHaveLength(1); // Clone and parent share one mutation state across the extracted compositions.
    expect(source).toContain('beginContextMutation: beginContextMutationFor,');
    const batch = readFileSync(
      join(here, '../../../shared/src/runtime/session-tool-batch.ts'),
      'utf8'
    );
    expect(batch).toMatch(/const settleMutation = ports\.beginContextMutation\(calls\);\s*try \{/);
    expect(batch).toMatch(/finally \{\s*settleMutation\(\);\s*\}/);
    expect(provider).toMatch(
      /const generationBeforeSpawn = ports\.contextGeneration\(\);\s*let runResult: BackendRunResult;\s*await beforeDispatch\(ctx\.signal\);\s*ports\.beginSpawn\(\);\s*try \{\s*const turn = ports\.startTurn\(\{/
    );
    expect(provider).toMatch(
      /const generationBeforeSpawn = ports\.contextGeneration\(\);\s*await beforeDispatch\(ctx\.signal\);\s*ports\.beginSpawn\(\);\s*try \{\s*const contTurn = ports\.startTurn\(\s*continuationRequest\(\s*continuationPrompt,\s*contSpawn,\s*contImages\)\s*\);/
    );
    expect(source).toMatch(
      /const generationBeforeSpawn = sessionContext\.generation;\s*const turn = ports\.startTurn\(cloneRequest\(prompt, sessionArgs\)\);/
    );
    expect(provider).toMatch(
      /if \(\s*ports\.mutationsInFlight\(\) > 0 \|\|\s*statelessGenerationAtReport !== ports\.contextGeneration\(\)\s*\) \{\s*return undefined;/
    );
    expect(source).toMatch(
      /cloneCanReuseSession \|\|\s*\(sessionContext\.mutationsInFlight === 0 &&\s*cloneGenerationAtReport === sessionContext\.generation\)\s*\? cloneOccupancyTokens\s*: undefined/
    );
    expect(source).not.toMatch(/statelessPromptTokens = undefined;\s*\}\s*iterationResults\.push/);
  });
});
