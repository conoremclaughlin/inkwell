/**
 * The auto-memory export guard, tested on synthetic resolver results only.
 * Nothing here touches a handler or a database: wiring the guard into
 * update_session_state waits for the authoritative profile resolver.
 *
 * The contract, as scoped on spec:live-agent-surfaces:
 *   - only `{ status: 'resolved', profile: 'standard' }`, exactly, allows;
 *   - browser_restricted, absent, read_failed and anything unrecognised
 *     refuse with their own reason code;
 *   - a refusal carries the reason, the session id and the phase class, and
 *     nothing a caller or resolver typed.
 */

import { describe, it, expect } from 'vitest';
import {
  decideAutoMemoryExport,
  lifecyclePhaseClass,
  type ExecutionProfileResolution,
} from './auto-memory-export-guard.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';

/** For inputs the type forbids but a resolver could still produce at runtime. */
function asResolution(value: unknown): ExecutionProfileResolution {
  return value as ExecutionProfileResolution;
}

const LIFECYCLE_PHASES = [
  ['blocked:no-write-perms', 'blocked'],
  ['waiting:lumen-review', 'waiting'],
  ['complete', 'complete'],
] as const;

describe('lifecyclePhaseClass', () => {
  it.each(LIFECYCLE_PHASES)('%s is %s', (phase, phaseClass) => {
    expect(lifecyclePhaseClass(phase)).toBe(phaseClass);
  });

  it('classifies a prefix with an empty suffix', () => {
    expect(lifecyclePhaseClass('blocked:')).toBe('blocked');
    expect(lifecyclePhaseClass('waiting:')).toBe('waiting');
  });

  // The handler's own predicate is case-sensitive and exact on `complete`,
  // so these never reach the auto-memory write and get no class.
  it.each([
    'blocked',
    'waiting',
    'Blocked:x',
    'WAITING:x',
    ' waiting:x',
    'Complete',
    ' complete',
    'complete ',
    'completed',
    'complete:done',
    'implementing',
    '',
  ])('%j has no lifecycle class', (phase) => {
    expect(lifecyclePhaseClass(phase)).toBeNull();
  });
});

describe('decideAutoMemoryExport: the one allowed case', () => {
  it.each(LIFECYCLE_PHASES)('an exactly resolved standard profile allows %s', (phase) => {
    const decision = decideAutoMemoryExport({
      sessionId: SESSION_ID,
      phase,
      profile: { status: 'resolved', profile: 'standard' },
    });
    expect(decision).toStrictEqual({ allowed: true });
  });
});

describe('decideAutoMemoryExport: each refusal reason', () => {
  it.each([
    ['browser_restricted', { status: 'resolved', profile: 'browser_restricted' }, 'restricted'],
    ['an absent profile', { status: 'absent' }, 'absent'],
    ['a failed read', { status: 'read_failed' }, 'read_failed'],
    ['an unrecognised profile', { status: 'resolved', profile: 'unrestricted' }, 'unknown'],
  ] as const)('%s refuses as %s', (_label, profile, reason) => {
    const decision = decideAutoMemoryExport({
      sessionId: SESSION_ID,
      phase: 'waiting:lumen-review',
      profile,
    });
    expect(decision).toStrictEqual({
      allowed: false,
      refusal: { reason, sessionId: SESSION_ID, phaseClass: 'waiting' },
    });
  });
});

describe('decideAutoMemoryExport: unknown and invalid negative controls', () => {
  // Near-misses of `standard` must not be normalised into it.
  it.each([
    'Standard',
    'STANDARD',
    ' standard',
    'standard ',
    'standard\n',
    '',
    'unrestricted',
    'default',
    'Browser_Restricted',
    'browser-restricted',
  ])('resolved profile %j refuses as unknown', (profile) => {
    const decision = decideAutoMemoryExport({
      sessionId: SESSION_ID,
      phase: 'complete',
      profile: { status: 'resolved', profile },
    });
    expect(decision).toStrictEqual({
      allowed: false,
      refusal: { reason: 'unknown', sessionId: SESSION_ID, phaseClass: 'complete' },
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['a bare string', 'standard'],
    ['an unrecognised status', { status: 'bogus', profile: 'standard' }],
    ['a miscased status', { status: 'Resolved', profile: 'standard' }],
    ['resolved without a profile', { status: 'resolved' }],
    ['resolved with a null profile', { status: 'resolved', profile: null }],
    ['resolved with a numeric profile', { status: 'resolved', profile: 1 }],
    ['resolved with a boxed string', { status: 'resolved', profile: new String('standard') }],
    ['resolved with an array profile', { status: 'resolved', profile: ['standard'] }],
  ])('a malformed resolver result (%s) refuses as unknown without throwing', (_label, value) => {
    const decision = decideAutoMemoryExport({
      sessionId: SESSION_ID,
      phase: 'blocked:no-write-perms',
      profile: asResolution(value),
    });
    expect(decision).toStrictEqual({
      allowed: false,
      refusal: { reason: 'unknown', sessionId: SESSION_ID, phaseClass: 'blocked' },
    });
  });

  // The status decides. A stray `profile: 'standard'` beside a status that
  // says the profile was never read must not turn into an allow.
  it.each([
    [{ status: 'absent', profile: 'standard' }, 'absent'],
    [{ status: 'read_failed', profile: 'standard' }, 'read_failed'],
  ] as const)('%j refuses as %s', (value, reason) => {
    const decision = decideAutoMemoryExport({
      sessionId: SESSION_ID,
      phase: 'complete',
      profile: asResolution(value),
    });
    expect(decision).toStrictEqual({
      allowed: false,
      refusal: { reason, sessionId: SESSION_ID, phaseClass: 'complete' },
    });
  });
});

describe('decideAutoMemoryExport: the refusal carries the phase class', () => {
  it.each(LIFECYCLE_PHASES)('%s refuses with class %s', (phase, phaseClass) => {
    const decision = decideAutoMemoryExport({
      sessionId: SESSION_ID,
      phase,
      profile: { status: 'resolved', profile: 'browser_restricted' },
    });
    expect(decision).toStrictEqual({
      allowed: false,
      refusal: { reason: 'restricted', sessionId: SESSION_ID, phaseClass },
    });
  });

  it('a phase outside the auto-memory path still refuses, with a null class', () => {
    const decision = decideAutoMemoryExport({
      sessionId: SESSION_ID,
      phase: 'implementing',
      profile: { status: 'absent' },
    });
    expect(decision).toStrictEqual({
      allowed: false,
      refusal: { reason: 'absent', sessionId: SESSION_ID, phaseClass: null },
    });
  });
});

describe('decideAutoMemoryExport: a refusal is value-free', () => {
  const SENTINEL = 'SENTINEL-7f3a';

  /**
   * JSON.stringify, except that an Error is written out with its message and
   * stack. Plain JSON.stringify prints an Error as `{}` (both fields are
   * non-enumerable), so a leaked exception would pass unseen, while a logger
   * writing the same refusal prints the message.
   */
  function serialize(decision: unknown): string {
    return JSON.stringify(decision, (_key, value: unknown) =>
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value
    );
  }

  const REFUSING_PROFILES: Array<[string, ExecutionProfileResolution]> = [
    ['restricted', { status: 'resolved', profile: 'browser_restricted' }],
    ['absent', { status: 'absent' }],
    ['read_failed', { status: 'read_failed' }],
    ['unknown', { status: 'resolved', profile: 'unrestricted' }],
  ];

  describe.each(REFUSING_PROFILES)('when refused as %s', (_reason, profile) => {
    it.each([`waiting:${SENTINEL}`, `blocked:${SENTINEL}`, `blocked:before ${SENTINEL} after`])(
      'the phase suffix of %j appears nowhere in the decision',
      (phase) => {
        const decision = decideAutoMemoryExport({ sessionId: SESSION_ID, phase, profile });
        expect(decision.allowed).toBe(false);
        expect(serialize(decision)).not.toContain(SENTINEL);
      }
    );
  });

  // The resolver's raw result is not refusal material either: an unknown
  // profile string is unvalidated, and anything a resolver bolted on (an
  // exception, a note, the session context) must not ride along.
  it.each([
    ['an unrecognised profile string', { status: 'resolved', profile: SENTINEL }],
    [
      'an exception attached to a read failure',
      { status: 'read_failed', error: new Error(SENTINEL) },
    ],
    ['a stringified exception', { status: 'read_failed', error: `boom: ${SENTINEL}` }],
    ['stray note and context fields', { status: 'absent', note: SENTINEL, context: SENTINEL }],
    ['a malformed result', { status: SENTINEL, profile: SENTINEL }],
  ])('%s appears nowhere in the decision', (_label, value) => {
    const decision = decideAutoMemoryExport({
      sessionId: SESSION_ID,
      phase: 'waiting:lumen-review',
      profile: asResolution(value),
    });
    expect(decision.allowed).toBe(false);
    expect(serialize(decision)).not.toContain(SENTINEL);
  });

  it('a refusal has exactly three fields', () => {
    const decision = decideAutoMemoryExport({
      sessionId: SESSION_ID,
      phase: `waiting:${SENTINEL}`,
      profile: { status: 'read_failed' },
    });
    if (decision.allowed) throw new Error('expected a refusal');
    expect(Object.keys(decision).sort()).toStrictEqual(['allowed', 'refusal']);
    expect(Object.keys(decision.refusal).sort()).toStrictEqual([
      'phaseClass',
      'reason',
      'sessionId',
    ]);
  });
});
