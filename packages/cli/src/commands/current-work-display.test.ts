/**
 * Display-level regressions for the three surfaces that show a session's
 * current work without anyone calling a tool.
 *
 * The feature's acceptance criterion is "visible without explicit tool calls",
 * and these are the places that satisfy it: the session-start hook block, the
 * startup context `ink` injects, and `ink session list`. Each one previously
 * received the fields and dropped them, which is invisible from the server side
 * — bootstrap's JSON was correct in every case.
 *
 * Every test here feeds the real mapped shape into the real formatter. A test
 * that asserted only "the formatter works" would have stayed green through the
 * entire bug.
 */
import { describe, it, expect } from 'vitest';
import { buildSessionsBlock } from './hooks.js';
import { buildInjectedStartupContext } from './claude.js';
import { renderSessionsByAgent, type Session } from './session.js';
import { UNKNOWN_AGE } from '../lib/current-work.js';

/** The shape bootstrap actually puts on each active session. */
const mappedSession = (over: Record<string, unknown> = {}) => ({
  id: '3f2a1b09-1111-2222-3333-444455556666',
  sbSlug: 'wren',
  lifecycle: 'running',
  currentPhase: 'reviewing',
  threadKey: 'inkwell:pr:652',
  currentWork: 'Reviewing PR #652 — the audience gate',
  currentWorkSource: 'headline',
  currentWorkAt: '2026-09-17T21:00:00.000Z',
  currentWorkAgeLabel: '3h ago',
  startedAt: '2026-09-17T18:00:00.000Z',
  ...over,
});

const cliSession = (over: Partial<Session> = {}): Session => ({
  id: '3f2a1b09-1111-2222-3333-444455556666',
  sbSlug: 'wren',
  status: 'active',
  currentPhase: 'reviewing',
  threadKey: 'inkwell:pr:652',
  startedAt: '2026-09-17T18:00:00.000Z',
  currentWork: 'Reviewing PR #652 — the audience gate',
  currentWorkAgeLabel: '3h ago',
  ...over,
});

describe('buildSessionsBlock (session-start hook)', () => {
  it('shows what each session is working on, with its age', () => {
    const block = buildSessionsBlock([mappedSession()]);

    expect(block).toContain('Reviewing PR #652 — the audience gate');
    expect(block).toContain('3h ago');
  });

  it('states an unknown age instead of printing the work bare', () => {
    const block = buildSessionsBlock([mappedSession({ currentWorkAgeLabel: null })]);

    expect(block).toContain('Reviewing PR #652 — the audience gate');
    expect(block).toContain(UNKNOWN_AGE);
    expect(block).not.toMatch(/just now|\d+[mhd] ago/);
  });

  it('still renders a session that has said nothing', () => {
    // Control: the block must not vanish or gain an empty "Now:" line when
    // there is no current work.
    const block = buildSessionsBlock([
      mappedSession({ currentWork: null, currentWorkAgeLabel: null }),
    ]);

    expect(block).toContain('3f2a1b09');
    expect(block).not.toContain('Now:');
  });
});

describe('buildInjectedStartupContext (ink startup injection)', () => {
  it('carries current work and its age into the injected block', () => {
    const block = buildInjectedStartupContext({ activeSessions: [mappedSession()] });

    expect(block).toContain('Reviewing PR #652 — the audience gate');
    expect(block).toContain('3h ago');
  });

  it('states an unknown age rather than a timeless line', () => {
    const block = buildInjectedStartupContext({
      activeSessions: [mappedSession({ currentWorkAgeLabel: null })],
    });

    expect(block).toContain(UNKNOWN_AGE);
    expect(block).not.toMatch(/just now|\d+[mhd] ago/);
  });

  it('keeps the id/phase/thread line when there is no current work', () => {
    const block = buildInjectedStartupContext({
      activeSessions: [mappedSession({ currentWork: null, currentWorkAgeLabel: null })],
    });

    expect(block).toContain('3f2a1b09 phase=reviewing thread=inkwell:pr:652');
    expect(block).not.toContain('now:');
  });
});

describe('renderSessionsByAgent (ink session list)', () => {
  const plain = (lines: string[]) =>
    // eslint-disable-next-line no-control-regex
    lines.join('\n').replace(/\[[0-9;]*m/g, '');

  it('shows current work with its age', () => {
    const out = plain(renderSessionsByAgent([cliSession()], true));

    expect(out).toContain('Reviewing PR #652 — the audience gate');
    expect(out).toContain('3h ago');
  });

  it('states an unknown age instead of a bare line', () => {
    const out = plain(renderSessionsByAgent([cliSession({ currentWorkAgeLabel: null })], true));

    expect(out).toContain(UNKNOWN_AGE);
    expect(out).not.toMatch(/just now|\d+[mhd] ago/);
  });

  it('leads with current work rather than the summary of a finished session', () => {
    const out = plain(
      renderSessionsByAgent([cliSession({ summary: 'Wrapped up the teardown fix' })], true)
    );

    expect(out.indexOf('Now:')).toBeGreaterThan(-1);
    expect(out.indexOf('Now:')).toBeLessThan(out.indexOf('Summary:'));
  });

  it('renders a session with no current work unchanged', () => {
    const out = plain(
      renderSessionsByAgent([cliSession({ currentWork: null, currentWorkAgeLabel: null })], true)
    );

    expect(out).toContain('3f2a1b09');
    expect(out).not.toContain('Now:');
  });
});
