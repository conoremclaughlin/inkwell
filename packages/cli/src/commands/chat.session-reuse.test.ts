import { describe, it, expect } from 'vitest';
import { isResumeFailedNoSession } from './chat.js';

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
