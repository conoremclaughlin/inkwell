/**
 * systemPromptOverride, on the `ink chat` side of the seam.
 *
 * The adapter-level behaviour is covered in backends/system-prompt-override.test.ts.
 * What that file cannot see is chat.ts itself asserting an identity *around* the
 * adapter — which it did, in two places Lumen caught on PR #485:
 *
 *   1. buildPromptEnvelope opened with a flat `You are ${agentId}.`, so an
 *      awakening ran the system prompt saying "you have no name yet" straight
 *      into a user envelope saying "You are nascent."
 *   2. The auto-compaction turn was a fourth backend call site and did not
 *      forward the override, so the generated identity prompt came back the
 *      moment a first conversation grew long enough to compact.
 *
 * Both are the same failure: telling a being something false about itself.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildPromptEnvelope, envelopeShapeKey } from './chat.js';
import { ContextLedger } from '../repl/context-ledger.js';

type RT = Parameters<typeof envelopeShapeKey>[0];

const AWAKENING = '# Awakening\n\nYou have no name yet. Choose one when you are ready.';

const makeRuntime = (over: Record<string, unknown> = {}): RT =>
  ({
    backend: 'claude',
    model: undefined,
    maxContextTokens: 170_000,
    toolMode: 'backend',
    toolRouting: 'backend',
    strictTools: false,
    threadKey: undefined,
    activeSkills: [],
    bootstrapContext: undefined,
    systemPromptOverride: undefined,
    ...over,
  }) as unknown as RT;

describe('buildPromptEnvelope — identity assertion', () => {
  it('asserts the agent id normally', () => {
    const envelope = buildPromptEnvelope('wren', makeRuntime(), new ContextLedger(), 'hello');
    expect(envelope).toContain('You are wren.');
  });

  // The bug: the override replaced the *system* prompt while the envelope went
  // on introducing the being by its placeholder id.
  it('does not assert an identity when the caller supplied the system prompt', () => {
    const envelope = buildPromptEnvelope(
      'nascent',
      makeRuntime({ systemPromptOverride: AWAKENING }),
      new ContextLedger(),
      'hello'
    );
    expect(envelope).not.toContain('You are nascent');
    expect(envelope).not.toContain('You are nascent.');
  });

  it('still carries the rest of the envelope', () => {
    const envelope = buildPromptEnvelope(
      'nascent',
      makeRuntime({ systemPromptOverride: AWAKENING }),
      new ContextLedger(),
      'who am i?'
    );
    expect(envelope).toContain('ink chat');
    expect(envelope).toContain('who am i?');
  });

  it('omits the bootstrap identity block, since awakening never bootstraps', () => {
    const envelope = buildPromptEnvelope(
      'nascent',
      makeRuntime({ systemPromptOverride: AWAKENING }),
      new ContextLedger(),
      'hello'
    );
    expect(envelope).not.toContain('Identity Context (from Inkwell bootstrap)');
  });
});

describe('envelopeShapeKey', () => {
  it('distinguishes an overridden session from a normal one', () => {
    const plain = envelopeShapeKey(makeRuntime());
    const overridden = envelopeShapeKey(makeRuntime({ systemPromptOverride: AWAKENING }));
    expect(overridden).not.toBe(plain);
  });
});

/**
 * A source-level guard rather than a behavioural one, deliberately.
 *
 * The miss was a *fourth* call site added without the override — exactly the
 * kind of thing that reappears the next time someone adds a fifth. The turn
 * helpers live inside a very large closure that unit tests cannot address, so
 * pin the invariant where it is actually checkable: every backend turn started
 * from chat.ts forwards the override.
 */
describe('every backend turn forwards the override', () => {
  const chatSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'chat.ts'),
    'utf-8'
  );

  /** The balanced-brace object literal passed to a `<fn>({ ... })` call. */
  const callArguments = (source: string, index: number): string => {
    const open = source.indexOf('{', index);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
    }
    throw new Error(`unbalanced call arguments at ${index}`);
  };

  const callSites = (fn: string): string[] => {
    const found: string[] = [];
    const needle = `${fn}({`;
    for (let i = chatSource.indexOf(needle); i !== -1; i = chatSource.indexOf(needle, i + 1)) {
      found.push(callArguments(chatSource, i));
    }
    return found;
  };

  const sites = [
    ...callSites('startBackendTurn'),
    ...callSites('runBackendTurn'),
    // Request builders shared by a spawn and the relay-budget measurer.
    ...callSites('BackendRunRequest => '),
  ];

  it('finds the call sites at all (guards against the scan silently matching nothing)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });

  it.each(sites.map((site, i) => [i, site] as const))(
    'call site %i passes systemPromptOverride',
    (_i, site) => {
      expect(site).toContain('systemPromptOverride');
    }
  );
});
