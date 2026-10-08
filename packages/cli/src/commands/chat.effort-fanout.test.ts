import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * Every backend spawn the REPL makes must carry the runtime's effort — the
 * delivery spawn, the reseed after a vanished session, tool-loop
 * continuations, the compaction summarizer, and shadow clones. This scan follows the CLI and shared provider request sites;
 * behavioural tests of the extracted composer live beside it. Deleting the
 * `effort:` line at any spawn site turns this red (Lumen, PR #579).
 */
const here = dirname(fileURLToPath(import.meta.url));
const cliSource = readFileSync(join(here, 'chat.ts'), 'utf8');
const providerSource = readFileSync(
  join(here, '../../../shared/src/providers/session-provider.ts'),
  'utf8'
);
// Scan the remaining CLI spawns AND the extracted delivery/reseed/continuation sites.
const chatSource = cliSource + '\n' + providerSource;

/** The object literal passed to each spawn call, by balanced braces. */
function spawnCallArgs(source: string): Array<{ at: number; literal: string }> {
  const out: Array<{ at: number; literal: string }> = [];
  // A spawn's request may be built by a named builder (continuationRequest,
  // cloneRequest) that the budget measurer shares — those literals are spawn
  // sites too.
  const re =
    /\b(?:startBackendTurn|runBackendTurn|ports\.startTurn)\(\{|: BackendRunRequest => \(\{/g;
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

  it('wires the shared provider composition to the same runtime and attachment', () => {
    expect(cliSource).toMatch(/const providerPorts: SessionProviderPorts = \{\s*runtime,/);
    expect(cliSource).toMatch(/sbSlug,\s*cliAttached,\s*passthroughArgs,/);
    expect(cliSource).toContain('startTurn: startBackendTurn');
    expect(cliSource).toContain('provider: providerPorts,');
    expect(cliSource).toContain('await runSessionAgentTurn(');
  });

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
