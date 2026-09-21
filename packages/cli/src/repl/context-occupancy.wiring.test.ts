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
import { ProviderSampleTracker } from './provider-sample';
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
    ledger.addEntry('system', 'stub', 'ink');
    let notified = false;
    handleClientLocalTool('evict_context', { source: 'ink' }, ledger, undefined, {
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

/**
 * The FOURTH parent request, and the last one Lumen's sweep turned up: when a
 * resume fails because the provider session vanished, the turn mints a fresh
 * native id and retries with the full envelope. Against 9f9d00e7 that retry
 * called buildPromptEnvelope with four arguments and shipped no stamp.
 *
 * It is not a request that gets skipped: the stamped resume died before any
 * model read it, so this seed is the first thing the turn sends that anything
 * answers — and on the server heartbeat path it may be the only one.
 *
 * The block is sliced and executed for the same reason as the continuation
 * block above. What a source-text assertion could not check is the ORDERING:
 * the stamp has to be built AFTER activeBackendSessionId moves to the reseed
 * id, because providerScope() keys on that id and the dead session's
 * measurement must stop matching. So the probe declares the id and
 * providerContextMeasurement inside the executed scope, over a real
 * ProviderSampleTracker holding a sample recorded under the OLD id.
 */
describe('PR 639 resume-not-found recovery seed', () => {
  const STALE_SESSION = 'stale-native-session';
  const RESEED_SESSION = 'reseeded-native-session';
  const MEASURED_TOKENS = 1500;

  const sliceRecoveryBlock = (): string => {
    const source = readFileSync(new URL('../commands/chat.ts', import.meta.url), 'utf8');
    const start = source.indexOf(
      '          // Mint a fresh native session, re-send the FULL envelope (the ledger'
    );
    const end = source.indexOf('          currentTurnAbort = reseedTurn.abort;', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  };

  /**
   * Runs the production recovery block with everything outside it stubbed.
   * `mintedId` is what randomUUID hands the block — passing STALE_SESSION back
   * is the control: the scope then still matches and the same code path is
   * proven able to report the measurement.
   */
  const runRecoveryBlock = (mintedId: string) => {
    const providerSample = new ProviderSampleTracker();
    const ledger = new ContextLedger();
    ledger.addEntry('user', 'synthetic user input', 'repl');
    const runtime = {
      backend: 'claude',
      model: 'synthetic-model',
      effort: 'medium',
      verbose: false,
      systemPromptOverride: undefined,
      backendTurnTimeoutMs: 1000,
      backendIdleTimeoutMs: 1000,
      transcriptPath: '/dev/null/synthetic',
      maxContextTokens: 2000,
      // Nonzero deliberately: a zeroed bootstrap leaves the fixed bucket empty,
      // and an empty bucket cannot disagree with anything.
      bootstrapContext: 'x'.repeat(400),
      toolMode: 'off',
      toolRouting: 'local',
      strictTools: false,
      activeSkills: [],
    };
    let captured: { prompt: string } | undefined;
    const dependencies = {
      providerSample,
      staleSession: STALE_SESSION,
      measuredTokens: MEASURED_TOKENS,
      randomUUID: () => mintedId,
      currentEnvelopeShape: 'synthetic-shape',
      runtime,
      ledger,
      raw: 'synthetic user input',
      sbSlug: 'review-fixture',
      passthroughArgs: [] as string[],
      handleBackendEvent: () => {},
      sessionAttachmentDirs: [] as string[],
      turnMedia: [] as unknown[],
      appendTranscript: () => {},
      printEvent: () => {},
      chalk: { yellow: (s: string) => s },
      beginSpawn: () => {},
      buildPromptEnvelope,
      formatContextStamp,
      turnContextOccupancy,
      startBackendTurn: (request: { prompt: string }) => {
        captured = request;
        return { abort: () => {}, result: Promise.resolve({}) };
      },
    };
    // The prelude reproduces the two things the block reads from its enclosing
    // scope and mutates: the live native id, and a measurement lookup scoped to
    // it. The sample is recorded under the STALE id — the session that just
    // failed to resume.
    const prelude = `
      let activeBackendSessionId = staleSession;
      let activeBackendSessionShape = 'synthetic-shape';
      const providerScope = () => ({
        backend: runtime.backend,
        model: runtime.model,
        backendSessionId: activeBackendSessionId,
        envelopeShape: 'synthetic-shape',
      });
      providerSample.record({ contextTokens: measuredTokens }, {
        backend: runtime.backend,
        model: runtime.model,
        backendSessionId: staleSession,
        envelopeShape: 'synthetic-shape',
      });
      const providerContextMeasurement = () => providerSample.measurement(providerScope());
    `;
    const js = ts.transpileModule(prelude + sliceRecoveryBlock() + '\nreturn reseedStamp;', {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const reseedStamp = new Function(...Object.keys(dependencies), js)(
      ...Object.values(dependencies)
    ) as string | undefined;
    return { reseedStamp, captured };
  };

  it('stamps the recovery retry envelope', () => {
    const { reseedStamp, captured } = runRecoveryBlock(RESEED_SESSION);
    expect(captured).toBeDefined();
    expect(reseedStamp).toContain('[context]');
    expect(captured!.prompt).toContain(reseedStamp!);
  });

  it('builds that stamp after the new native id lands, so the dead session is not quoted', () => {
    const { reseedStamp } = runRecoveryBlock(RESEED_SESSION);
    // The failed session's 1,500-token reading describes a window that no
    // longer exists. Reading it before the reassignment would put it here.
    expect(reseedStamp).not.toContain('1,500');
    expect(reseedStamp).toContain('the provider has not reported this session');
  });

  it('control: the same block DOES report a measurement whose scope still matches', () => {
    // Without this, the assertion above passes for any reason at all — a stamp
    // that is empty, a tracker that never recorded, a scope typo. Handing the
    // block back the id it was already on keeps the scope matching, and the
    // measurement appears.
    const { reseedStamp } = runRecoveryBlock(STALE_SESSION);
    expect(reseedStamp).toContain('1,500');
    expect(reseedStamp).not.toContain('the provider has not reported this session');
    // And the fixed bucket is populated, so the three-bucket line is exercised
    // rather than skipped past a zero.
    expect(reseedStamp).toContain('identity envelope 100');
  });

  it('control: the marker comments this test slices on still delimit a real block', () => {
    const block = sliceRecoveryBlock();
    expect(block.length).toBeGreaterThan(200);
    expect(block).toContain('const reseedId = randomUUID();');
    expect(block).toContain('activeBackendSessionId = reseedId;');
    // Ordering, pinned in the text as well as executed above.
    expect(block.indexOf('activeBackendSessionId = reseedId;')).toBeLessThan(
      block.indexOf('const reseedStamp = formatContextStamp(')
    );
  });
});
