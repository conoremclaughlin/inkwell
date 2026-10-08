import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/**
 * Source-level pin of every writer of a session's attached and poll flags
 * (poll-gate.ts presenceRefused). The decision is unit-tested in
 * poll-gate.test.ts; this pins that each writer asks it, by the session's
 * canonical identity, and that a refused stamp clears rather than skips, so an
 * earlier true value can't stand as a live client (Lumen, #779 44e6a13d).
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const hookRoute = read('../../routes/hook-lifecycle.ts');
const memoryHandlers = read('../../mcp/tools/memory-handlers.ts');

describe('every writer of attached or poll presence asks presenceRefused', () => {
  it('the hook route clears both flags for an inkling, before either write path', () => {
    expect(hookRoute).toMatch(
      /if \(\s*\(updates\.cliAttached === true \|\| updates\.cliPollAt !== undefined\) &&\s*\(await presenceRefused\(dataComposer\.getClient\(\), session\.sbId\)\)\s*\) \{\s*updates\.cliAttached = false;\s*updates\.cliPollAt = null;\s*\}/
    );
    // Both the plain update and the fenced ride-along read `updates` after it.
    expect(hookRoute.indexOf('presenceRefused(')).toBeLessThan(
      hookRoute.indexOf('fencedRideAlong.cli_attached')
    );
  });

  it('update_session_state never keeps a true cliAttached for an inkling', () => {
    expect(memoryHandlers).toMatch(
      /updates\.cliAttached =\s*params\.cliAttached &&\s*!\(await presenceRefused\(dataComposer\.getClient\(\), priorSession\?\.sbId\)\);/
    );
  });

  it('start_session writes the refusal, not nothing, onto a possibly existing row', () => {
    expect(memoryHandlers).toMatch(
      /cliAttached: !\(await presenceRefused\(dataComposer\.getClient\(\), session\.sbId\)\),/
    );
  });

  it('no writer sets cliAttached: true unconditionally any more', () => {
    expect(memoryHandlers).not.toMatch(/cliAttached: true,\s*\}\);/);
  });
});
