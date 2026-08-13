import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyDetectedModel,
  applyModelSelection,
  buildPromptEnvelope,
  envelopeShapeKey,
  findLastBackendSession,
  findLastDetectedModel,
  isResumeFailedNoSession,
} from './chat.js';
import { ContextLedger } from '../repl/context-ledger.js';

/**
 * Stage 2A — across-turn provider session reuse.
 *
 * The seed/resume decision lives inside runUserTurn (chat.ts), a large closure
 * that isn't unit-addressable directly. Mirror the exact decision as a pure
 * helper here (same idiom as tool-loop stop decision) so the across-turn +
 * compaction-reset behavior is guarded directly, plus test the exported
 * resume-not-found detector against real backend stderr shapes.
 */

// Mirrors chat.ts runUserTurn: first spawn of the session SEEDS a fresh
// provider session (full envelope); every later turn RESUMES it (delta only).
// A compaction resets activeId to undefined, forcing the next turn to re-seed.
function decideProviderSession(
  canReuse: boolean,
  activeId: string | undefined,
  mintId: () => string
): {
  seedId: string | undefined;
  resumeId: string | undefined;
  nextActiveId: string | undefined;
  sendDelta: boolean;
  sendFullEnvelope: boolean;
} {
  const resume = canReuse && activeId !== undefined;
  let seedId: string | undefined;
  let nextActiveId = activeId;
  if (canReuse && !resume) {
    seedId = mintId();
    nextActiveId = seedId;
  }
  return {
    seedId,
    resumeId: resume ? activeId : undefined,
    nextActiveId,
    sendDelta: resume,
    sendFullEnvelope: !resume, // seed turns and stateless backends re-pack the envelope
  };
}

describe('across-turn provider session decision', () => {
  const ids = ['S1', 'S2', 'S3'];
  const minter = () => {
    let i = 0;
    return () => ids[i++]!;
  };

  it('first turn SEEDS a fresh session with the full envelope', () => {
    const d = decideProviderSession(true, undefined, minter());
    expect(d.seedId).toBe('S1');
    expect(d.resumeId).toBeUndefined();
    expect(d.nextActiveId).toBe('S1');
    expect(d.sendDelta).toBe(false);
    expect(d.sendFullEnvelope).toBe(true);
  });

  it('subsequent turn RESUMES the live session with delta only', () => {
    const d = decideProviderSession(true, 'S1', minter());
    expect(d.seedId).toBeUndefined();
    expect(d.resumeId).toBe('S1');
    expect(d.nextActiveId).toBe('S1');
    expect(d.sendDelta).toBe(true);
    expect(d.sendFullEnvelope).toBe(false);
  });

  it('stateless backends (canReuse=false) never seed/resume — always full envelope', () => {
    const d = decideProviderSession(false, undefined, minter());
    expect(d.seedId).toBeUndefined();
    expect(d.resumeId).toBeUndefined();
    expect(d.nextActiveId).toBeUndefined();
    expect(d.sendDelta).toBe(false);
    expect(d.sendFullEnvelope).toBe(true);
  });

  it('a multi-turn conversation reuses ONE session id across turns', () => {
    const mint = minter();
    let active: string | undefined;
    const used: Array<{ seed?: string; resume?: string; delta: boolean }> = [];
    for (let turn = 0; turn < 3; turn++) {
      const d = decideProviderSession(true, active, mint);
      active = d.nextActiveId;
      used.push({ seed: d.seedId, resume: d.resumeId, delta: d.sendDelta });
    }
    // Turn 1 seeds S1; turns 2 and 3 resume S1 with deltas — one coherent jsonl.
    expect(used[0]).toEqual({ seed: 'S1', resume: undefined, delta: false });
    expect(used[1]).toEqual({ seed: undefined, resume: 'S1', delta: true });
    expect(used[2]).toEqual({ seed: undefined, resume: 'S1', delta: true });
  });

  it('ink-owned compaction rolls the provider session: next turn seeds a NEW id', () => {
    const mint = minter();
    let active: string | undefined;

    // Turn 1: seed S1
    let d = decideProviderSession(true, active, mint);
    active = d.nextActiveId;
    expect(active).toBe('S1');

    // Turn 2: resume S1
    d = decideProviderSession(true, active, mint);
    expect(d.resumeId).toBe('S1');
    active = d.nextActiveId;

    // ink compacts the ledger → reset the live provider session id.
    active = undefined;

    // Turn 3: with the summary in the ledger, seed a FRESH session (S2 ≠ S1).
    d = decideProviderSession(true, active, mint);
    expect(d.seedId).toBe('S2');
    expect(d.sendFullEnvelope).toBe(true); // fresh session gets the compacted summary
    expect(d.nextActiveId).toBe('S2');
  });
});

describe('isResumeFailedNoSession', () => {
  it('detects claude "session not found"', () => {
    expect(isResumeFailedNoSession('Error: session not found: abc-123')).toBe(true);
  });

  it('detects "No such session" case-insensitively', () => {
    expect(isResumeFailedNoSession('No such session')).toBe(true);
    expect(isResumeFailedNoSession('NO SUCH SESSION')).toBe(true);
  });

  it('is false for unrelated stderr (provider stall, econnreset)', () => {
    expect(isResumeFailedNoSession('ECONNRESET while streaming')).toBe(false);
    expect(isResumeFailedNoSession('request timed out')).toBe(false);
  });

  it('is false for empty/whitespace stderr', () => {
    expect(isResumeFailedNoSession('')).toBe(false);
    expect(isResumeFailedNoSession('   ')).toBe(false);
  });
});

describe('findLastBackendSession (cross-process recovery)', () => {
  let dir: string;
  const writeTranscript = (events: object[]): string => {
    dir = mkdtempSync(join(tmpdir(), 'sb-transcript-'));
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return path;
  };

  afterEach(() => {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it('returns undefined when the transcript file does not exist', () => {
    expect(findLastBackendSession(join(tmpdir(), 'does-not-exist-xyz.jsonl'))).toBeUndefined();
    expect(findLastBackendSession('')).toBeUndefined();
  });

  it('recovers the last backend_session id so the next process resumes it', () => {
    const path = writeTranscript([
      { type: 'user', content: 'hi' },
      { type: 'backend_session', id: 'sess-1' },
      { type: 'user', content: 'more' },
      { type: 'backend_session', id: 'sess-2' },
    ]);
    expect(findLastBackendSession(path)?.id).toBe('sess-2');
  });

  it('returns undefined when there is no backend_session marker', () => {
    const path = writeTranscript([
      { type: 'user', content: 'hi' },
      { type: 'system_turn', content: 'heartbeat' },
    ]);
    expect(findLastBackendSession(path)).toBeUndefined();
  });

  it('a compaction AFTER the last seed clears the candidate (roll to fresh)', () => {
    // ink compacted and the process ended before seeding again — the next
    // process must NOT resume the pre-compaction session (it would drag the
    // pre-compaction window back in). Seed fresh instead.
    const path = writeTranscript([
      { type: 'backend_session', id: 'pre-compaction' },
      { type: 'user', content: 'lots of turns' },
      { type: 'compaction', summary: '[summary]' },
    ]);
    expect(findLastBackendSession(path)).toBeUndefined();
  });

  it('a seed AFTER a compaction is the live session (re-established)', () => {
    const path = writeTranscript([
      { type: 'backend_session', id: 'pre-compaction' },
      { type: 'compaction', summary: '[summary]' },
      { type: 'backend_session', id: 'post-compaction' },
      { type: 'user', content: 'next turn' },
    ]);
    expect(findLastBackendSession(path)?.id).toBe('post-compaction');
  });

  it('a context_evict AFTER the last seed clears the candidate', () => {
    // /evict or evict_context removed entries; a resumed native session would
    // still hold the evicted content, so recovery must NOT resume it.
    const path = writeTranscript([
      { type: 'backend_session', id: 'pre-evict' },
      { type: 'user', content: 'stuff' },
      { type: 'context_evict', actor: 'sb', refs: [{ hash: 'h' }] },
    ]);
    expect(findLastBackendSession(path)).toBeUndefined();
  });

  it('a context_budget_changed AFTER the last seed clears the candidate (packing-width change)', () => {
    // One-turn process: seeded at 170K, detection raised the budget, exited
    // before any reseed turn. The next process must NOT resume the
    // narrow-seeded session — its omitted history would stay stranded
    // (Lumen, PR #477 round 3).
    const path = writeTranscript([
      { type: 'backend_session', id: 'seeded-at-170k', routing: 'local' },
      { type: 'model_detected', backend: 'claude', model: 'claude-fable-5' },
      { type: 'context_budget_changed', from: 170_000, to: 850_000 },
    ]);
    expect(findLastBackendSession(path)).toBeUndefined();
  });

  it('a seed AFTER a budget change is the live session (post-detection reseed)', () => {
    const path = writeTranscript([
      { type: 'backend_session', id: 'seeded-at-170k', routing: 'local' },
      { type: 'context_budget_changed', from: 170_000, to: 850_000 },
      { type: 'backend_session', id: 'reseeded-at-850k', routing: 'local' },
    ]);
    expect(findLastBackendSession(path)?.id).toBe('reseeded-at-850k');
  });

  it('a context_trim AFTER the last seed clears the candidate', () => {
    const path = writeTranscript([
      { type: 'backend_session', id: 'pre-trim' },
      { type: 'context_trim', reason: 'manual' },
    ]);
    expect(findLastBackendSession(path)).toBeUndefined();
  });

  it('a seed AFTER an eviction is the live session (re-established)', () => {
    const path = writeTranscript([
      { type: 'backend_session', id: 'old' },
      { type: 'context_evict', actor: 'user', refs: [{ hash: 'h' }] },
      { type: 'backend_session', id: 'post-evict' },
    ]);
    expect(findLastBackendSession(path)?.id).toBe('post-evict');
  });

  it('ignores malformed lines', () => {
    dir = mkdtempSync(join(tmpdir(), 'sb-transcript-'));
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(
      path,
      ['not json', JSON.stringify({ type: 'backend_session', id: 'ok-1' }), '', '{bad'].join('\n')
    );
    expect(findLastBackendSession(path)?.id).toBe('ok-1');
  });

  it('recovers the persisted tool routing alongside the id', () => {
    const path = writeTranscript([{ type: 'backend_session', id: 'sess-local', routing: 'local' }]);
    expect(findLastBackendSession(path)).toEqual({ id: 'sess-local', routing: 'local' });
  });

  it('legacy markers (no routing) recover the id with routing undefined', () => {
    // The recovery site treats missing routing as a mismatch — the session's
    // seeded instruction envelope is unknowable, so it reseeds fresh. This is
    // the cross-process routing-flip guard: a session seeded under backend
    // routing must never be resumed with a delta by a local-routing process
    // (it would never receive ink-block syntax), and vice versa.
    const path = writeTranscript([{ type: 'backend_session', id: 'legacy-sess' }]);
    const recovered = findLastBackendSession(path);
    expect(recovered?.id).toBe('legacy-sess');
    expect(recovered?.routing).toBeUndefined();
    // Mirrors the recovery gate in runChat: resume only on an exact match.
    const resumableUnder = (routing: 'backend' | 'local'): boolean =>
      recovered !== undefined && recovered.routing === routing;
    expect(resumableUnder('local')).toBe(false);
    expect(resumableUnder('backend')).toBe(false);
  });

  it('a routing flip across processes refuses the resume; matching routing allows it', () => {
    const path = writeTranscript([
      { type: 'backend_session', id: 'sess-backend', routing: 'backend' },
    ]);
    const recovered = findLastBackendSession(path);
    const resumableUnder = (routing: 'backend' | 'local'): boolean =>
      recovered !== undefined && recovered.routing === routing;
    expect(resumableUnder('backend')).toBe(true);
    expect(resumableUnder('local')).toBe(false);
  });

  it('an invalid routing value is dropped (recovers id, reseeds envelope)', () => {
    const path = writeTranscript([
      { type: 'backend_session', id: 'sess-x', routing: 'weird-mode' },
    ]);
    const recovered = findLastBackendSession(path);
    expect(recovered?.id).toBe('sess-x');
    expect(recovered?.routing).toBeUndefined();
  });
});

// Mirrors runUserTurn's envelope-shape check: a live provider session is
// invalidated when the current envelope shape differs from the one it was
// seeded with. A /backend switch, /tool-routing, /skill-use/clear, /model,
// /refresh, or profile change all shift the shape, so a resumed native session
// is never left stale. `canReuse` (claude-only) gates seeding independently.
function decideWithShape(
  canReuse: boolean,
  currentShape: string,
  activeId: string | undefined,
  activeShape: string | undefined,
  mintId: () => string
): {
  invalidated: boolean;
  resume: boolean;
  seedId: string | undefined;
  nextActiveId: string | undefined;
  nextShape: string | undefined;
} {
  let id = activeId;
  let shape = activeShape;
  let invalidated = false;
  if (id !== undefined) {
    if (shape === undefined) {
      shape = currentShape; // recovered from a prior process — adopt baseline
    } else if (shape !== currentShape) {
      id = undefined;
      shape = undefined;
      invalidated = true;
    }
  }
  const resume = canReuse && id !== undefined;
  let seedId: string | undefined;
  if (canReuse && !resume) {
    seedId = mintId();
    id = seedId;
    shape = currentShape;
  }
  return { invalidated, resume, seedId, nextActiveId: id, nextShape: shape };
}

describe('provider session envelope-shape invalidation', () => {
  const minter = () => {
    const ids = ['S1', 'S2', 'S3'];
    let i = 0;
    return () => ids[i++]!;
  };

  it('/tool-routing drift (same claude backend) reseeds — Lumen P1 concrete case', () => {
    const mint = minter();
    // Seed with the backend-routing envelope shape.
    let d = decideWithShape(true, 'shape:backend-routing', undefined, undefined, mint);
    expect(d.seedId).toBe('S1');
    // /tool-routing local changes the rendered tool instructions → new shape.
    d = decideWithShape(true, 'shape:local-routing', d.nextActiveId, d.nextShape, mint);
    expect(d.invalidated).toBe(true);
    expect(d.resume).toBe(false);
    expect(d.seedId).toBe('S2'); // fresh session carries the new envelope
  });

  it('/skill-use drift reseeds so the new skill instructions are seen', () => {
    const mint = minter();
    let d = decideWithShape(true, 'shape:noskills', undefined, undefined, mint); // S1
    d = decideWithShape(true, 'shape:skill-a', d.nextActiveId, d.nextShape, mint);
    expect(d.invalidated).toBe(true);
    expect(d.seedId).toBe('S2');
  });

  it('/backend claude→codex invalidates and does not resume (codex cannot reuse)', () => {
    const mint = minter();
    const d1 = decideWithShape(true, 'shape:claude', undefined, undefined, mint); // S1
    const d2 = decideWithShape(false, 'shape:codex', d1.nextActiveId, d1.nextShape, mint);
    expect(d2.invalidated).toBe(true);
    expect(d2.resume).toBe(false);
    expect(d2.seedId).toBeUndefined();
    expect(d2.nextActiveId).toBeUndefined();
  });

  it('claude→codex→claude reseeds fresh (never resumes the pre-switch session)', () => {
    const mint = minter();
    const d1 = decideWithShape(true, 'shape:claude', undefined, undefined, mint); // S1
    const onCodex = decideWithShape(false, 'shape:codex', d1.nextActiveId, d1.nextShape, mint);
    const d3 = decideWithShape(true, 'shape:claude', onCodex.nextActiveId, onCodex.nextShape, mint);
    expect(d3.resume).toBe(false);
    expect(d3.seedId).toBe('S2'); // not S1 — intervening codex turns aren't in it
  });

  it('stable shape resumes the same session (no spurious invalidation)', () => {
    const mint = minter();
    const d1 = decideWithShape(true, 'shape:claude', undefined, undefined, mint); // S1
    const d2 = decideWithShape(true, 'shape:claude', d1.nextActiveId, d1.nextShape, mint);
    expect(d2.invalidated).toBe(false);
    expect(d2.resume).toBe(true);
    expect(d2.nextActiveId).toBe('S1');
  });

  it('a recovered session (no baseline shape yet) adopts the shape and resumes', () => {
    // Cross-process reattach: the id is recovered from the transcript but the
    // shape baseline is adopted lazily on this first turn — so it resumes
    // (Myra heartbeat continuity) instead of spuriously reseeding.
    const mint = minter();
    const d = decideWithShape(true, 'shape:claude', 'recovered-id', undefined, mint);
    expect(d.invalidated).toBe(false);
    expect(d.resume).toBe(true);
    expect(d.nextActiveId).toBe('recovered-id');
    expect(d.nextShape).toBe('shape:claude');
  });
});

describe('envelopeShapeKey (real function)', () => {
  type RT = Parameters<typeof envelopeShapeKey>[0];
  const base = {
    backend: 'claude',
    model: 'claude-sonnet-5',
    maxContextTokens: 170_000,
    toolMode: 'backend',
    toolRouting: 'local',
    strictTools: false,
    threadKey: undefined,
    activeSkills: [] as Array<{ name: string }>,
    bootstrapContext: 'ctx',
  };
  const key = (over: Partial<typeof base>): string =>
    envelopeShapeKey({ ...base, ...over } as unknown as RT);

  it('is stable for an identical shape', () => {
    expect(key({})).toBe(key({}));
  });

  it('changes when tool routing changes (the concrete stale-tools case)', () => {
    expect(key({ toolRouting: 'backend' })).not.toBe(key({ toolRouting: 'local' }));
  });

  it('changes on any envelope-shaping field, so no mutation site can be missed', () => {
    const b = key({});
    expect(key({ backend: 'codex' })).not.toBe(b);
    expect(key({ model: 'other-model' })).not.toBe(b);
    expect(key({ toolMode: 'off' })).not.toBe(b);
    expect(key({ strictTools: true })).not.toBe(b);
    expect(key({ activeSkills: [{ name: 'skill-a' }] })).not.toBe(b);
    expect(key({ threadKey: 'pr:1' })).not.toBe(b);
    expect(key({ bootstrapContext: 'different identity context' })).not.toBe(b);
  });

  it('changes when the packing budget changes (detection raised it → reseed)', () => {
    expect(key({ maxContextTokens: 850_000 })).not.toBe(key({ maxContextTokens: 170_000 }));
  });
});

describe('budget-rise reseed flow — >170K history is un-stranded (PR #477 round 2)', () => {
  type RT = Parameters<typeof buildPromptEnvelope>[1];

  it('the raised budget widens the seed envelope AND drifts the shape key', () => {
    // ~300K tokens of history: a legacy large-window transcript reattached
    // before this process has seen an init event.
    const ledger = new ContextLedger();
    const marker = (i: number) => `HISTORY-ENTRY-${i}-MARKER`;
    for (let i = 0; i < 10; i++) {
      ledger.addEntry('user', `${marker(i)} ${'x'.repeat(120_000)}`);
    }

    const rt = {
      backend: 'claude',
      model: undefined,
      maxContextTokens: 170_000,
      toolMode: 'backend',
      toolRouting: 'backend',
      strictTools: false,
      threadKey: undefined,
      activeSkills: [],
      bootstrapContext: undefined,
    } as unknown as RT;

    // Seeded at the conservative default: the oldest history does not fit.
    const seeded = buildPromptEnvelope('wren', rt, ledger, 'hello');
    expect(seeded).not.toContain(marker(0));
    expect(seeded).toContain(marker(9));

    // Init raises the budget (claude-fable-5 → 850K). The shape key MUST
    // drift — that is what invalidates the live native session so the next
    // turn reseeds instead of sending deltas that strand the older history.
    const shapeBefore = envelopeShapeKey(rt);
    rt.maxContextTokens = 850_000;
    expect(envelopeShapeKey(rt)).not.toBe(shapeBefore);

    // And the reseeded envelope now carries the previously omitted history.
    const reseeded = buildPromptEnvelope('wren', rt, ledger, 'hello');
    expect(reseeded).toContain(marker(0));
    expect(reseeded).toContain(marker(9));
  });
});

describe('applyModelSelection — /model transitions invalidate detection (PR #477 round 2)', () => {
  type RT = Parameters<typeof applyModelSelection>[0];
  let dir: string;
  let transcriptPath: string;

  const makeRuntime = (over: Record<string, unknown>): RT =>
    ({
      backend: 'claude',
      model: undefined,
      detectedModel: undefined,
      backendTokenWindow: 200_000,
      maxContextTokens: 170_000,
      transcriptPath,
      ...over,
    }) as unknown as RT;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'ink-model-selection-test-'));
    transcriptPath = join(dir, 'session.jsonl');
  };

  it('CLEARING the override drops to the conservative default and voids detection everywhere', () => {
    setup();
    // Prior state: explicit fable-5, init confirmed it, authority persisted.
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'model_detected', backend: 'claude', model: 'claude-fable-5' }) + '\n'
    );
    const rt = makeRuntime({
      model: 'claude-fable-5',
      detectedModel: 'claude-fable-5',
      backendTokenWindow: 1_000_000,
      maxContextTokens: 850_000,
    });

    applyModelSelection(rt, undefined, true);

    // The default model is UNKNOWN until the next init — conservative state.
    expect(rt.model).toBeUndefined();
    expect(rt.detectedModel).toBeUndefined();
    expect(rt.backendTokenWindow).toBe(200_000);
    expect(rt.maxContextTokens).toBe(170_000);
    // Persisted authority is void too: a reattaching process must not
    // recover the stale fable-5 entry.
    expect(findLastDetectedModel(transcriptPath, 'claude')).toBeUndefined();
  });

  it('SETTING a large-window override raises the budget and voids the small-model detection', () => {
    setup();
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'model_detected', backend: 'claude', model: 'claude-opus-4-6' }) + '\n'
    );
    const rt = makeRuntime({ detectedModel: 'claude-opus-4-6' });

    applyModelSelection(rt, 'claude-fable-5', true);

    expect(rt.model).toBe('claude-fable-5');
    expect(rt.detectedModel).toBeUndefined();
    expect(rt.backendTokenWindow).toBe(1_000_000);
    expect(rt.maxContextTokens).toBe(850_000);
    expect(findLastDetectedModel(transcriptPath, 'claude')).toBeUndefined();
  });

  it('a NEW init event after the reset re-establishes persisted authority', () => {
    setup();
    const rt = makeRuntime({ detectedModel: 'claude-fable-5' });
    applyModelSelection(rt, undefined, true);
    expect(findLastDetectedModel(transcriptPath, 'claude')).toBeUndefined();

    // The next turn's init reports the default model — appended AFTER the
    // reset, so it wins.
    writeFileSync(
      transcriptPath,
      readFileSync(transcriptPath, 'utf-8') +
        JSON.stringify({ type: 'model_detected', backend: 'claude', model: 'claude-opus-4-6' }) +
        '\n'
    );
    expect(findLastDetectedModel(transcriptPath, 'claude')).toBe('claude-opus-4-6');
  });

  it('respects an explicit --max-context-tokens (contextBudgetAuto=false)', () => {
    setup();
    const rt = makeRuntime({ maxContextTokens: 123_456 });
    applyModelSelection(rt, 'claude-fable-5', false);
    expect(rt.backendTokenWindow).toBe(1_000_000);
    expect(rt.maxContextTokens).toBe(123_456);
  });

  it('a budget-changing /model severs recovery of the narrow-seeded session', () => {
    setup();
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'backend_session', id: 'seeded-at-850k', routing: 'local' }) + '\n'
    );
    const rt = makeRuntime({
      model: 'claude-fable-5',
      detectedModel: 'claude-fable-5',
      backendTokenWindow: 1_000_000,
      maxContextTokens: 850_000,
    });
    applyModelSelection(rt, undefined, true); // 850K → 170K
    expect(findLastBackendSession(transcriptPath)).toBeUndefined();
  });
});

describe('one-turn process recovery sequence — detection outlives the seed (PR #477 round 3)', () => {
  type RT = Parameters<typeof applyDetectedModel>[0];
  let dir: string;
  let transcriptPath: string;

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'ink-one-turn-recovery-'));
    transcriptPath = join(dir, 'session.jsonl');
  };

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const makeRuntime = (): RT =>
    ({
      backend: 'claude',
      model: undefined,
      detectedModel: undefined,
      backendTokenWindow: 200_000,
      maxContextTokens: 170_000,
      transcriptPath,
    }) as unknown as RT;

  it('process A seeds narrow, detects Fable 5, exits — process B reseeds instead of resuming', () => {
    setup();
    // Process A, first (and only) turn: seeds the native session at the
    // conservative 170K packing width...
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'backend_session', id: 'seeded-at-170k', routing: 'local' }) + '\n'
    );
    // ...then the init event reports Fable 5 (production writer).
    const a = makeRuntime();
    const { windowChanged } = applyDetectedModel(a, 'claude-fable-5', true);
    expect(windowChanged).toBe(true);
    expect(a.maxContextTokens).toBe(850_000);
    // Process A exits here — no reseed turn ever ran.

    // Process B reattaches: it recovers the REAL model (850K budget before
    // any enforcement)...
    expect(findLastDetectedModel(transcriptPath, 'claude')).toBe('claude-fable-5');
    // ...and MUST NOT recover the narrow-seeded session — resuming it with
    // deltas would strand the history omitted from the 170K seed forever.
    expect(findLastBackendSession(transcriptPath)).toBeUndefined();
  });

  it('detection that does NOT change the packing width preserves session continuity', () => {
    setup();
    // The common heartbeat case: a 200K-window model detected on a session
    // seeded at the matching 170K width. No boundary — the next process
    // resumes the same native session (continuity is the whole point of
    // cross-process recovery).
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'backend_session', id: 'seeded-at-170k', routing: 'local' }) + '\n'
    );
    const a = makeRuntime();
    const { windowChanged } = applyDetectedModel(a, 'claude-sonnet-5', true);
    expect(windowChanged).toBe(false);
    expect(a.maxContextTokens).toBe(170_000);
    expect(findLastDetectedModel(transcriptPath, 'claude')).toBe('claude-sonnet-5');
    expect(findLastBackendSession(transcriptPath)?.id).toBe('seeded-at-170k');
  });

  it('a post-detection reseed in process A re-establishes recovery for process B', () => {
    setup();
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'backend_session', id: 'seeded-at-170k', routing: 'local' }) + '\n'
    );
    const a = makeRuntime();
    applyDetectedModel(a, 'claude-fable-5', true);
    // Process A gets a second turn: shape drift reseeds and persists the new
    // seed marker AFTER the boundary.
    writeFileSync(
      transcriptPath,
      readFileSync(transcriptPath, 'utf-8') +
        JSON.stringify({ type: 'backend_session', id: 'reseeded-at-850k', routing: 'local' }) +
        '\n'
    );
    expect(findLastBackendSession(transcriptPath)?.id).toBe('reseeded-at-850k');
  });
});
