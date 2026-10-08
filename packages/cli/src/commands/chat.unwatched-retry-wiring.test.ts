import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * Source-level pin of who may retry after a refused iteration. The loop's
 * behaviour is unit-tested in shared/src/runtime/agent-loop.test.ts; this pins
 * the wiring a unit test cannot reach: an unwatched (`--non-interactive`) turn
 * retries a call that FAILED, so one invalid argument no longer ends a
 * server-spawned turn on the FINAL relay. That is how an inkling's reply to its
 * owner was lost on Oct 7, and it is the same for every SB on ink.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'chat.ts'), 'utf8');

const parentComposition = readFileSync(
  join(here, '../../../shared/src/providers/session-agent-turn.ts'),
  'utf8'
);
const loopCalls = [...source.matchAll(/await runAgentLoop\(\s*\{([\s\S]*?)\n\s*\},\s*\{/g)].map(
  (m) => m[1]!
);
const parent = source.match(/await runSessionAgentTurn\(\s*\{([\s\S]*?)\n\s*\},\s*\{/)?.[1];
const clone = loopCalls.find((c) => c.includes('cloneOccupancyTokens'));

describe('which runAgentLoop host retries after a refused iteration', () => {
  it('finds both hosts, the parent turn and the clone', () => {
    expect(loopCalls).toHaveLength(1);
    expect(parentComposition).toContain('continueOnFailure: input.continueOnFailure,');
    expect(parentComposition.match(/await runAgentLoop\(/g)).toHaveLength(1);
    expect(parent).toBeDefined();
    expect(clone).toBeDefined();
  });

  it('the parent turn retries a failed call exactly when it is non-interactive', () => {
    expect(parent).toContain('continueOnFailure: Boolean(options.nonInteractive),');
  });

  it('only the parent turn sets continueOnFailure; the clone keeps continueOnBlocked', () => {
    expect(source.match(/continueOnFailure:/g)).toHaveLength(1);
    expect(clone).toContain('continueOnBlocked: true,');
    expect(parent).not.toContain('continueOnBlocked');
  });
});
