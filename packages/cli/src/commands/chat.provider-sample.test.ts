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

const provider = readFileSync(
  join(here, '../../../shared/src/providers/session-provider.ts'),
  'utf8'
);

const context = readFileSync(
  join(here, '../../../shared/src/runtime/session-context-state.ts'),
  'utf8'
);

const compaction = readFileSync(
  join(here, '../../../shared/src/providers/session-compaction.ts'),
  'utf8'
);

describe('chat.ts provider-sample wiring', () => {
  const cloneSource = readFileSync(
    join(here, '../../../shared/src/node-host/session-clones.ts'),
    'utf8'
  );
  const cloneStart = cloneSource.indexOf('const cloneRunTurn = async (');
  const cloneEnd = cloneSource.indexOf('\n    };\n', cloneStart);
  const cloneTurn = cloneSource.slice(cloneStart, cloneEnd);
  const parent = source;

  it("samples usage where each of the parent's spawn results lands — right after it is recorded, before the loop goes on", () => {
    const sites = [...provider.matchAll(/ports\.recordUsage\((\w+)\.usage\);\n\s*(\S[^\n]*)/g)];
    expect(sites.length).toBeGreaterThanOrEqual(3);
    expect(parent).toContain('recordUsage: recordRunUsage');
    expect(parent).toContain('sampleContext: sampleProviderContext');
    for (const [, result, nextLine] of sites) {
      expect(nextLine).toBe(`ports.sampleContext(${result}.usage);`);
    }
  });

  it("a clone's turn is costed but never sampled — its window is not the parent's", () => {
    expect(cloneStart).toBeGreaterThan(0);
    expect(cloneTurn).toContain('ports.recordUsage(result.usage)');
    expect(cloneTurn).not.toContain('sampleProviderContext');
  });

  it('no longer waits for the end of the turn to take the sample', () => {
    expect(source).not.toMatch(/let lastBackendUsage\b/);
    expect(source).not.toMatch(/lastBackendUsage = /);
  });

  it('provider-only excess rolls the native session; a compaction that did not shrink the ledger rolls it too', () => {
    const rolls =
      compaction.match(/sessionContext\.roll\(\s*'provider-context-over-budget'/g) ?? [];
    expect(rolls.length).toBe(2);
    expect(compaction).toContain('hasProviderSession: sessionContext.provider.id !== undefined');
    expect(compaction).toMatch(
      /if \(!outcome\.ok && pressure\.providerOver && sessionContext\.provider\.id !== undefined\)/
    );
  });

  it('the sample is scoped to the LIVE envelope key, so stateless providers are scoped too', () => {
    const scope = context.slice(
      context.indexOf('scope(): ProviderSampleScope'),
      context.indexOf('sampleUsage(')
    );
    expect(source).toContain('runtime: () => runtime');
    expect(scope).toContain('envelopeShape: envelopeShapeKey(runtime)');
    expect(scope).not.toContain('activeBackendSessionShape');
  });

  it('every sample is persisted, and the next process replays it', () => {
    const sampler = context.slice(
      context.indexOf('sampleUsage('),
      context.indexOf('measurement():')
    );
    expect(source).toContain('sessionContext.sampleUsage(usage)');
    expect(sampler).toContain("type: 'provider_sample'");
    // A report with no usable measurement is persisted as a tombstone too,
    // so replay cannot resurrect the sample it hid live (Lumen, round 3).
    expect(sampler).toMatch(/\{ type: 'provider_sample', at, \.\.\.scope, unknown: true \}/);
    expect(source).toContain('if (hydrated.providerSample) {');
  });

  it('an eviction (and so a trim) drops the sample', () => {
    const eviction = compaction.slice(
      compaction.indexOf('const recordEviction = ('),
      compaction.indexOf('const trimContextToPercent = async (')
    );
    expect(source).toMatch(/createSessionCompaction\(\{\s*runtime,\s*ledger,\s*sessionContext,/);
    expect(eviction).toContain('sessionContext.clearProvider();');
  });

  it('every path that rolls the session also drops the sample it measured', () => {
    expect(source).toContain('sessionContext.roll(reason, note)');
    expect(context).toContain('this.clearProvider();');
    const helper = context.slice(
      context.indexOf('clearProvider(): void'),
      context.indexOf('roll(reason:')
    );
    expect(helper).toContain('this.sample.clear();');
    expect(helper).toContain('this.provider.id = undefined;');
    expect(helper).toContain('this.provider.shape = undefined;');
  });
});
