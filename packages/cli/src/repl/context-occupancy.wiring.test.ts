import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  buildPromptEnvelope,
  buildContinuationPrompt,
  decideContinuationSession,
  turnContextOccupancy,
} from '../commands/chat';
import { ContextLedger } from './context-ledger';
import {
  computeContextOccupancy,
  formatContextStamp,
  handleClientLocalTool,
} from './context-tools';

/**
 * WIRING tests: they execute the production call site, not a copy of it.
 *
 * Originally Lumen's review probe for PR #639, kept because it caught what a
 * pure-function test structurally cannot. All three continuation modes had the
 * right helpers in scope and simply did not pass the stamp — a bug that lives
 * in the call site, where a unit test of the callee never looks.
 *
 * The technique — slice the block out of chat.ts, transpile it, run it with
 * injected dependencies — is unusual and deliberately so. It is also brittle:
 * a renamed marker comment would silently slice an empty string, so there is a
 * control test below asserting the markers still delimit a real block. Read
 * that control as part of the suite, not decoration.
 *
 * Wren adapted the dependency set: the fix made the block call
 * turnContextOccupancy/formatContextStamp/buildContinuationPrompt itself, so
 * the original set produced a ReferenceError against a fixed head — which
 * would prove nothing either way.
 *
 * Every value is synthetic. No provider, DB, shell, or transcript writer runs.
 */
describe('PR 639 recovery advice', () => {
  it('does not advertise the immutable bootstrap as evictable ledger tokens', () => {
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'x'.repeat(400), 'repl');
    const occ = computeContextOccupancy(ledger.totalTokens(), 900, 2000, { contextTokens: 1000 });
    const result = handleClientLocalTool('evict_context', { source: 'repl' }, ledger)!;
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.tokensFreed).toBe(100);
    expect(ledger.totalTokens()).toBe(0);
    expect(occ.ledgerTokens).toBeLessThanOrEqual(payload.tokensFreed);
  });

  it('control: production eviction resets a native session even for a tiny stub', () => {
    const source = readFileSync(new URL('../commands/chat.ts', import.meta.url), 'utf8');
    const writer = source.slice(
      source.indexOf('  const recordEviction = ('),
      source.indexOf('  const trimContextToPercent = async (')
    );
    // Pin the production mutation, not a mock of what we think it does.
    expect(writer).toContain('activeBackendSessionId = undefined;');
    expect(writer).toContain('activeBackendSessionShape = undefined;');
    expect(writer).toContain('providerSample.clear();');
    const ledger = new ContextLedger();
    ledger.addEntry('system', 'stub', 'pcp');
    let notified = false;
    handleClientLocalTool('evict_context', { source: 'pcp' }, ledger, undefined, {
      onEvict: ({ refs }) => {
        notified = refs.length === 1;
      },
    });
    expect(notified).toBe(true);
  });

  it('does not claim compaction is the exclusive way to clear provider excess', () => {
    const occ = computeContextOccupancy(100, 0, 2000, { contextTokens: 1500 });
    expect(formatContextStamp(occ)).not.toContain('only by compact_context');
  });

  it.each(['resume', 'seed', 'stateless'])(
    'refreshes the stamp before a %s tool-loop continuation',
    (mode) => {
      const source = readFileSync(new URL('../commands/chat.ts', import.meta.url), 'utf8');
      const start = source.indexOf('      // ── Continuation ──');
      const end = source.indexOf('      // Recorded for a later reseed in this same turn;', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      // Execute the production prompt-selection block only. Backend launches,
      // persistence, printing and native-session lookup are outside this probe.
      const js = ts.transpileModule(
        source.slice(start, end) + '\nreturn { continuationPrompt, continuationStamp };',
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
      ).outputText;
      const ledger = new ContextLedger();
      ledger.addEntry('user', 'synthetic user input', 'repl');
      const runtime = {
        backend: 'claude',
        maxContextTokens: 2000,
        toolMode: 'off',
        toolRouting: 'local',
        strictTools: false,
        activeSkills: [],
      };
      // The measurement the block must pick up. It exists only because an
      // earlier spawn in this turn was sampled — which is the whole reason the
      // stamp has to be regenerated here rather than inherited from the opening.
      const measurement = { contextTokens: 1500 };
      const dependencies = {
        decideContinuationSession: () => ({ mode, id: 'synthetic-session' }),
        canReuseBackendSession: mode !== 'stateless',
        activeBackendSessionId: undefined,
        activeBackendSessionShape: undefined,
        randomUUID: () => 'synthetic-session',
        body: 'synthetic tool result',
        runtime,
        ledger,
        sbSlug: 'review-fixture',
        envelopeShapeKey: () => 'synthetic-shape',
        appendTranscript: () => {},
        printEvent: () => {},
        chalk: { dim: (s: string) => s },
        turnDialogue: [],
        buildPromptEnvelope,
        buildMidTurnReseedBody: () => 'synthetic reseed body',
        // Added for the fixed head: the block now regenerates rather than
        // inheriting, so it reaches for these three itself.
        buildContinuationPrompt,
        turnContextOccupancy,
        formatContextStamp,
        providerContextMeasurement: () => measurement,
      };
      const { continuationPrompt, continuationStamp } = new Function(
        ...Object.keys(dependencies),
        js
      )(...Object.values(dependencies));

      expect(continuationPrompt).toContain(continuationStamp);
      // Regenerated, not inherited: the block computed a stamp carrying the
      // provider measurement sampled from the preceding spawn.
      expect(continuationStamp).toContain('[context]');
      expect(continuationStamp).toContain('1,500');
    }
  );
});

// A pure-function test cannot see the call site, and the call site is where
// this bug lived — all three modes had correct helpers available and simply
// did not pass the stamp. This pins the wiring itself.
describe('the production continuation block wires a regenerated stamp', () => {
  it('computes continuationStamp and hands it to buildContinuationPrompt', () => {
    const source = readFileSync(new URL('../commands/chat.ts', import.meta.url).pathname, 'utf8');
    const start = source.indexOf('      // ── Continuation ──');
    const end = source.indexOf('      // Recorded for a later reseed in this same turn;', start);
    const block = source.slice(start, end);

    expect(block).toContain('const continuationStamp = formatContextStamp(');
    expect(block).toContain('turnContextOccupancy(ledger, runtime, providerContextMeasurement())');
    expect(block).toContain('buildContinuationPrompt(');
    expect(block).toContain('continuationStamp,');
    // The three four-argument buildPromptEnvelope calls that dropped the stamp
    // against fd068a65 are gone from this block.
    expect(block).not.toContain('buildPromptEnvelope(sbSlug, runtime, ledger, body)');
  });

  it('control: the marker comments this test slices on still exist', () => {
    // Without this, a renamed comment turns every assertion above into a
    // vacuous pass over an empty string.
    const source = readFileSync(new URL('../commands/chat.ts', import.meta.url).pathname, 'utf8');
    const start = source.indexOf('      // ── Continuation ──');
    const end = source.indexOf('      // Recorded for a later reseed in this same turn;', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(end - start).toBeGreaterThan(200);
  });
});
