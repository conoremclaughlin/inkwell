import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * Source-level pin of the two production hosts of runAgentLoop (Lumen, PR
 * #576 round 3): both must ask for a live relay budget, and both budgets must
 * account for what their loop has already put in the provider's context. The
 * budget arithmetic has its own unit tests; this pins the wiring a unit test
 * cannot reach.
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
    for (const input of loopCalls) expect(input).toContain('relayBudgetChars: () =>');
  });

  it("the parent's budget shrinks by this loop's resident traffic, and the clone's by its own", () => {
    const parent = loopCalls.find((c) => c.includes('loopResidentChars'));
    const clone = loopCalls.find((c) => c.includes('cloneResidentChars'));
    expect(parent).toBeDefined();
    expect(clone).toBeDefined();
    expect(clone).toContain('cloneLedgerFor(record.transcriptPath)');
  });

  it('the parent accumulates every continuation body and every reply it receives', () => {
    expect(source).toMatch(
      /loopResidentChars \+= continuationPrompt\.length \+ \(contResult\.responseText \?\? ''\)\.length;/
    );
    expect(source).toMatch(/loopResidentChars \+= \(runResult\.responseText \?\? ''\)\.length;/);
  });

  it('the clone accumulates for a native session and tracks the latest prompt for a stateless one', () => {
    expect(source).toMatch(
      /cloneResidentChars = cloneCanReuseSession\s*\?\s*cloneResidentChars \+ prompt\.length \+ text\.length\s*:\s*prompt\.length \+ text\.length;/
    );
  });
});
