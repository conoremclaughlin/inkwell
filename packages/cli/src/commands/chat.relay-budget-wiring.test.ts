import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * Source-level pin of the two production hosts of runAgentLoop (Lumen, PR
 * #576 rounds 3–4): both must ask for a live relay budget, both budgets must
 * account for what their loop has already put in the provider's context, and
 * the clone's must describe the window it was spawned into. The budget
 * arithmetic has its own unit tests; this pins the wiring a unit test cannot
 * reach.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'chat.ts'), 'utf8');

const loopCalls = [...source.matchAll(/await runAgentLoop\(\s*\{([\s\S]*?)\n\s*\},\s*\{/g)].map(
  (m) => m[1]!
);

describe('runAgentLoop hosts and their relay budgets', () => {
  it('there are exactly two production hosts: the parent turn and the clone', () => {
    expect(loopCalls).toHaveLength(2);
  });

  it('every host supplies a live relay budget — none takes the static default', () => {
    for (const input of loopCalls) expect(input).toContain('relayBudgetBytes: () =>');
  });

  it("the parent's budget shrinks by this loop's resident traffic, and the clone's by its own", () => {
    const parent = loopCalls.find((c) => c.includes('loopResidentBytes'));
    const clone = loopCalls.find((c) => c.includes('cloneResidentBytes'));
    expect(parent).toBeDefined();
    expect(clone).toBeDefined();
    expect(clone).toContain('cloneLedgerFor(record.transcriptPath)');
  });

  it("the clone's window is frozen at spawn — never the parent's mutable runtime (Lumen, round 4)", () => {
    const clone = loopCalls.find((c) => c.includes('cloneResidentBytes'))!;
    expect(clone).toContain('maxContextTokens: cloneMaxContextTokens');
    expect(clone).toContain('bootstrapContext: cloneIdentityPrompt');
    expect(clone).not.toContain('runtime.maxContextTokens');
    expect(clone).not.toContain('runtime.systemPromptOverride');
    expect(source).toContain('const cloneMaxContextTokens = runtime.maxContextTokens;');
  });

  it('the parent counts the continuation BODY and the reply — never the re-packed envelope (Lumen, round 4)', () => {
    expect(source).toMatch(
      /loopResidentBytes \+= utf8Bytes\(body\) \+ utf8Bytes\(contResult\.responseText \?\? ''\);/
    );
    expect(source).toMatch(/loopResidentBytes \+= utf8Bytes\(runResult\.responseText \?\? ''\);/);
    expect(source).not.toMatch(/loopResidentBytes \+= [^;]*continuationPrompt/);
  });

  it('the clone accumulates for a native session and tracks the latest prompt for a stateless one', () => {
    expect(source).toMatch(
      /cloneResidentBytes = cloneCanReuseSession\s*\?\s*cloneResidentBytes \+ utf8Bytes\(prompt\) \+ utf8Bytes\(text\)\s*:\s*utf8Bytes\(prompt\) \+ utf8Bytes\(text\);/
    );
  });
});
