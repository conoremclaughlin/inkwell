import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isResumeFailedNoSession, findLastBackendSessionId, envelopeShapeKey } from './chat.js';

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

describe('findLastBackendSessionId (cross-process recovery)', () => {
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
    expect(findLastBackendSessionId(join(tmpdir(), 'does-not-exist-xyz.jsonl'))).toBeUndefined();
    expect(findLastBackendSessionId('')).toBeUndefined();
  });

  it('recovers the last backend_session id so the next process resumes it', () => {
    const path = writeTranscript([
      { type: 'user', content: 'hi' },
      { type: 'backend_session', id: 'sess-1' },
      { type: 'user', content: 'more' },
      { type: 'backend_session', id: 'sess-2' },
    ]);
    expect(findLastBackendSessionId(path)).toBe('sess-2');
  });

  it('returns undefined when there is no backend_session marker', () => {
    const path = writeTranscript([
      { type: 'user', content: 'hi' },
      { type: 'system_turn', content: 'heartbeat' },
    ]);
    expect(findLastBackendSessionId(path)).toBeUndefined();
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
    expect(findLastBackendSessionId(path)).toBeUndefined();
  });

  it('a seed AFTER a compaction is the live session (re-established)', () => {
    const path = writeTranscript([
      { type: 'backend_session', id: 'pre-compaction' },
      { type: 'compaction', summary: '[summary]' },
      { type: 'backend_session', id: 'post-compaction' },
      { type: 'user', content: 'next turn' },
    ]);
    expect(findLastBackendSessionId(path)).toBe('post-compaction');
  });

  it('a context_evict AFTER the last seed clears the candidate', () => {
    // /evict or evict_context removed entries; a resumed native session would
    // still hold the evicted content, so recovery must NOT resume it.
    const path = writeTranscript([
      { type: 'backend_session', id: 'pre-evict' },
      { type: 'user', content: 'stuff' },
      { type: 'context_evict', actor: 'sb', refs: [{ hash: 'h' }] },
    ]);
    expect(findLastBackendSessionId(path)).toBeUndefined();
  });

  it('a context_trim AFTER the last seed clears the candidate', () => {
    const path = writeTranscript([
      { type: 'backend_session', id: 'pre-trim' },
      { type: 'context_trim', reason: 'manual' },
    ]);
    expect(findLastBackendSessionId(path)).toBeUndefined();
  });

  it('a seed AFTER an eviction is the live session (re-established)', () => {
    const path = writeTranscript([
      { type: 'backend_session', id: 'old' },
      { type: 'context_evict', actor: 'user', refs: [{ hash: 'h' }] },
      { type: 'backend_session', id: 'post-evict' },
    ]);
    expect(findLastBackendSessionId(path)).toBe('post-evict');
  });

  it('ignores malformed lines', () => {
    dir = mkdtempSync(join(tmpdir(), 'sb-transcript-'));
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(
      path,
      ['not json', JSON.stringify({ type: 'backend_session', id: 'ok-1' }), '', '{bad'].join('\n')
    );
    expect(findLastBackendSessionId(path)).toBe('ok-1');
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
});
