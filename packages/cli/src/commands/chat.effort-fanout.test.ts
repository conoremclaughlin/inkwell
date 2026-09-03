import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * Every backend spawn the REPL makes must carry the runtime's effort — the
 * delivery spawn, the reseed after a vanished session, tool-loop
 * continuations, the compaction summarizer, and shadow clones. Those calls
 * live inside runChat's closure with no harness that reaches them, so the
 * invariant is pinned where it can be observed: the source. Deleting the
 * `effort:` line at any spawn site turns this red (Lumen, PR #579).
 */
const chatSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'chat.ts'), 'utf-8');

/** The object literal passed to each spawn call, by balanced braces. */
function spawnCallArgs(source: string): Array<{ at: number; literal: string }> {
  const out: Array<{ at: number; literal: string }> = [];
  const re = /\b(?:startBackendTurn|runBackendTurn)\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push({ at: m.index, literal: source.slice(open, i + 1) });
          break;
        }
      }
    }
  }
  return out;
}

describe('effort reaches every backend spawn in chat.ts', () => {
  const calls = spawnCallArgs(chatSource);

  it('finds the spawn sites (delivery, reseed, continuation, compaction, clone)', () => {
    expect(calls.length).toBeGreaterThanOrEqual(5);
  });

  it.each(calls.map((c, i) => [i, c] as const))('spawn site #%i passes effort', (_i, call) => {
    const line = chatSource.slice(0, call.at).split('\n').length;
    expect(
      /\beffort:\s*(runtime\.effort|cloneEffort|effort)\b/.test(call.literal),
      `chat.ts:${line}`
    ).toBe(true);
  });
});
