import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * Source-level pin of the host wiring for the provider sample (Lumen, PR #583
 * findings 1 and 3). The decision logic lives in pure modules with their own
 * tests; what this pins is WHERE chat.ts takes the sample and what it does
 * with the verdict — the part a unit test cannot reach.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'chat.ts'), 'utf8');

describe('chat.ts provider-sample wiring', () => {
  const cloneStart = source.indexOf('const cloneRunTurn = async (');
  const cloneEnd = source.indexOf('\n    };\n', cloneStart);
  const cloneTurn = source.slice(cloneStart, cloneEnd);
  const parent = source.slice(0, cloneStart) + source.slice(cloneEnd);

  it("samples usage where each of the parent's spawn results lands — right after it is recorded, before the loop goes on", () => {
    const sites = [...parent.matchAll(/recordRunUsage\((\w+)\.usage\);\n\s*(\S[^\n]*)/g)];
    expect(sites.length).toBeGreaterThanOrEqual(3);
    for (const [, result, nextLine] of sites) {
      expect(nextLine).toBe(`sampleProviderContext(${result}.usage);`);
    }
  });

  it("a clone's turn is costed but never sampled — its window is not the parent's", () => {
    expect(cloneStart).toBeGreaterThan(0);
    expect(cloneTurn).toContain('recordRunUsage(result.usage)');
    expect(cloneTurn).not.toContain('sampleProviderContext');
  });

  it('no longer waits for the end of the turn to take the sample', () => {
    expect(source).not.toMatch(/let lastBackendUsage\b/);
    expect(source).not.toMatch(/lastBackendUsage = /);
  });

  it('provider-only excess rolls the native session; a compaction that did not shrink the ledger rolls it too', () => {
    const rolls = source.match(/rollProviderSession\(\s*'provider-context-over-budget'/g) ?? [];
    expect(rolls.length).toBe(2);
    expect(source).toContain('hasProviderSession: activeBackendSessionId !== undefined');
    expect(source).toMatch(
      /if \(!outcome\.ok && pressure\.providerOver && activeBackendSessionId !== undefined\)/
    );
  });

  it('every path that rolls the session also drops the sample it measured', () => {
    const helper = source.slice(
      source.indexOf('const rollProviderSession = '),
      source.indexOf('printEvent(chalk.yellow(`  ⛁ provider session rolled')
    );
    expect(helper).toContain('providerSample.clear();');
    expect(helper).toContain('activeBackendSessionId = undefined;');
  });
});
