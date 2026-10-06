import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * Every backend spawn chat.ts makes must declare the chat process's own
 * attachment. The child inherits this process's INK_SESSION_ID, and its
 * on-prompt hook writes the declared value onto that session; a headless run
 * whose children declared themselves attached had every trigger during the run
 * delivered inline to nobody (PR #685, Lumen). The type checker requires the
 * field at each site; this pins which value it carries.
 *
 * The behavioural check through runChat is in chat.integration.test.ts, which
 * CI does not run. This one it does.
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

describe('attachment reaches every backend spawn in chat.ts', () => {
  const calls = spawnCallArgs(chatSource);

  it('wires the shared provider composition to the same runtime and attachment', () => {
    expect(cliSource).toMatch(/createSessionProviderTurn\(\s*\{\s*runtime,/);
    expect(cliSource).toMatch(/sbSlug,\s*cliAttached,\s*passthroughArgs,/);
    expect(cliSource).toContain('startTurn: startBackendTurn');
  });

  it('derives attachment once, from the run mode', () => {
    const derivations = chatSource.match(/\bconst cliAttached = [^;]+;/g) ?? [];
    expect(derivations).toEqual([
      'const cliAttached = !options.nonInteractive && !options.message;',
    ]);
  });

  it('finds the spawn sites (delivery, reseed, continuation, compaction, clone)', () => {
    expect(calls.length).toBeGreaterThanOrEqual(5);
  });

  it.each(calls.map((c, i) => [i, c] as const))(
    'spawn site #%i passes the derived attachment',
    (_i, call) => {
      const line = chatSource.slice(0, call.at).split('\n').length;
      expect(
        /(?:^|[\s,{])cliAttached(?:\s*,|\s*$|\s*\})/m.test(call.literal),
        `chat.ts:${line}`
      ).toBe(true);
    }
  );
});
