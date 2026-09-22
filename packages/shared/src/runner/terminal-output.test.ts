/**
 * Tests for terminal output sanitising.
 *
 * The bug these pin: on 2026-09-22 a heartbeat outage alert reached Conor's
 * phone carrying the ink startup banner as raw escape sequences, a
 * `session_meta` blob, and no cause — because the capture took the HEAD of
 * the process output. Myra reported it on `pcp:debug:myra-heartbeat-failures`.
 *
 * Fixtures below are invented. The shape is copied from the real payload (the
 * line order, the SGR-per-cell banner); the transcript path, ids and the
 * failure itself are synthetic.
 */

import { describe, it, expect } from 'vitest';
import { stripAnsi, failureExcerpt, describeExit } from './terminal-output.js';
import { classifyError } from '../errors/classify-error.js';

/** One cell of the ink startup banner: ~45 bytes to render a single block. */
const BANNER_CELL = '\u001b[38;2;10;10;26m\u001b[48;2;10;10;26m▄\u001b[49m\u001b[39m';

/** What ink prints before it has done any work, in the order it prints it. */
const STARTUP_NOISE =
  '\u001b[32mApplied "Safe" profile (All tools allowed except comms and file writes, which require approval.)\u001b[39m\n' +
  '\u001b[2mIdentity context loaded: ~21,793 tokens injected into prompt\u001b[22m\n' +
  '\u001b[2mKeychain: 2 credential(s) loaded\u001b[22m\n' +
  '{"type":"session_meta","transcriptPath":"/tmp/example.test/runtime/repl/session.jsonl"}\n' +
  BANNER_CELL.repeat(60) +
  '\n';

/** The thing that actually went wrong, where a failing process puts it: last. */
const REAL_CAUSE = "Error: ENOENT: no such file or directory, open '/tmp/example.test/config.json'";

describe('stripAnsi', () => {
  it('removes SGR colour, cursor control and OSC sequences', () => {
    expect(stripAnsi('\u001b[32mgreen\u001b[39m')).toBe('green');
    expect(stripAnsi('\u001b[2K\u001b[1Aoverwritten')).toBe('overwritten');
    expect(stripAnsi('\u001b]0;window title\u0007text')).toBe('text');
  });

  // The CLI's own helper matches SGR only. A partial strip is what leaves
  // `[2K` litter in the text, so the wider pattern is the point of this file.
  it('leaves no bracket litter behind from non-SGR sequences', () => {
    const cleaned = stripAnsi('\u001b[2K\u001b[1G\u001b[38;2;1;2;3mx\u001b[0m');
    expect(cleaned).toBe('x');
    expect(cleaned).not.toContain('[');
  });

  it('normalises the carriage returns a progress spinner leaves', () => {
    expect(stripAnsi('working 10%\rworking 99%\r\ndone')).toBe('working 10%\nworking 99%\ndone');
  });

  it('keeps newlines and tabs but drops other control bytes', () => {
    expect(stripAnsi('a\n\tb\u0000\u0007c')).toBe('a\n\tbc');
  });
});

describe('failureExcerpt', () => {
  it('keeps the tail, where a failed process says why', () => {
    const output = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const excerpt = failureExcerpt(output, { maxLines: 3 });

    expect(excerpt).toBe('line 37\nline 38\nline 39');
    expect(excerpt).not.toContain('line 0');
  });

  // The tail and the noise filter are redundant for ink, whose banner we
  // recognise. They stop being redundant for every backend whose preamble we
  // do NOT have a pattern for — Claude and Gemini reject with their whole raw
  // stderr — and for the day ink's banner changes. This is that case: chatty
  // startup output that matches no filter, with the cause last.
  it('surfaces the cause under preamble it does not recognise', () => {
    const unknownPreamble = Array.from(
      { length: 30 },
      (_, i) => `[startup] initialising subsystem ${i}`
    ).join('\n');
    const excerpt = failureExcerpt(`${unknownPreamble}\n${REAL_CAUSE}`);

    expect(excerpt).toContain(REAL_CAUSE);
    expect(excerpt).not.toContain('subsystem 0');
  });

  it('drops the startup banner and surfaces the cause underneath it', () => {
    const excerpt = failureExcerpt(STARTUP_NOISE + REAL_CAUSE);

    expect(excerpt).toBe(REAL_CAUSE);
    expect(excerpt).not.toContain('Applied "Safe" profile');
    expect(excerpt).not.toContain('session_meta');
  });

  it('emits no escape bytes even when the input is almost entirely escapes', () => {
    const excerpt = failureExcerpt(STARTUP_NOISE + REAL_CAUSE);
    expect(excerpt).not.toMatch(/\u001b/);
  });

  // The noise filter must never be the reason a human gets an empty alert.
  it('falls back to the unfiltered tail when every line looks like startup noise', () => {
    const excerpt = failureExcerpt(STARTUP_NOISE);

    expect(excerpt).not.toBe('');
    expect(excerpt).toContain('Keychain: 2 credential(s) loaded');
  });

  it('returns empty only when there was no readable text at all', () => {
    expect(failureExcerpt('')).toBe('');
    expect(failureExcerpt('\u001b[0m\u001b[2K   \n\n')).toBe('');
  });

  // Strip first, truncate second. Truncating raw output spends the character
  // budget on bytes that render as nothing.
  it('spends the character budget on text rather than escape bytes', () => {
    const raw = BANNER_CELL.repeat(20) + '\n' + REAL_CAUSE;
    const excerpt = failureExcerpt(raw, { maxChars: 120 });

    expect(excerpt).toContain('ENOENT');
    expect(excerpt.length).toBeLessThanOrEqual(120);
  });

  it('trims a too-long excerpt from the front, keeping the last line intact', () => {
    const raw = 'noise '.repeat(400) + '\n' + REAL_CAUSE;
    const excerpt = failureExcerpt(raw, { maxChars: 200 });

    expect(excerpt.length).toBeLessThanOrEqual(200);
    expect(excerpt.endsWith(REAL_CAUSE)).toBe(true);
    expect(excerpt.startsWith('…')).toBe(true);
  });
});

describe('describeExit', () => {
  it('prefers stderr when it carries anything readable', () => {
    const text = describeExit({
      command: 'ink chat',
      exitCode: 1,
      stdout: STARTUP_NOISE,
      stderr: 'fatal: backend refused the turn',
    });

    expect(text).toBe('ink chat exited with code 1: fatal: backend refused the turn');
  });

  // The case that produced the real alert: ink reported the failure on stdout
  // and stderr was empty, so the stdout fallback is the only thing there is.
  it('falls back to stdout when stderr is empty', () => {
    const text = describeExit({
      command: 'ink chat',
      exitCode: 1,
      stdout: STARTUP_NOISE + REAL_CAUSE,
      stderr: '',
    });

    expect(text).toContain(REAL_CAUSE);
    expect(text).not.toMatch(/\u001b/);
  });

  it('says so explicitly when the process produced no diagnostic at all', () => {
    const text = describeExit({ command: 'ink chat', exitCode: 1, stdout: '', stderr: '' });
    expect(text).toBe('ink chat exited with code 1 (no diagnostic output)');
  });
});

/**
 * The regression, stated as the difference it makes.
 *
 * `HEAD_SLICE` is the previous production expression from ink-runner.ts:587-588
 * verbatim. Each assertion pairs the old behaviour with the new one, so the
 * test carries its own control: if the fixture stopped exercising the bug, the
 * `HEAD_SLICE` half would go green and the pair would contradict itself.
 */
describe('regression: the alert used to carry the banner instead of the cause', () => {
  const stdout = STARTUP_NOISE + REAL_CAUSE;
  const stderr = '';

  /** ink-runner.ts:587-588 as it stood before this fix. */
  const HEAD_SLICE = (stderr.trim() || stdout.trim() || 'exit code 1').slice(0, 1000);
  const FIXED = describeExit({ command: 'ink chat', exitCode: 1, stdout, stderr });

  it('used to cut the cause off the end, and now leads with it', () => {
    expect(HEAD_SLICE).not.toContain(REAL_CAUSE);
    expect(FIXED).toContain(REAL_CAUSE);
  });

  it('used to ship raw escape sequences to a messaging channel', () => {
    expect(HEAD_SLICE).toMatch(/\u001b/);
    expect(FIXED).not.toMatch(/\u001b/);
  });

  it('used to open on the profile line that reads as the cause', () => {
    expect(HEAD_SLICE).toContain('Applied "Safe" profile');
    expect(FIXED).not.toContain('Applied "Safe" profile');
  });

  // Both real escalations in the log classified `unknown`. Not because the
  // classifier was wrong — because the head slice had already discarded the
  // only text it could have matched on.
  it('used to classify unknown for want of any diagnostic in the text', () => {
    expect(classifyError({ errorText: HEAD_SLICE }).category).toBe('unknown');
    expect(classifyError({ errorText: FIXED }).category).toBe('config');
  });

  it('is dramatically shorter, because the banner was most of it', () => {
    expect(HEAD_SLICE.length).toBeGreaterThan(900);
    expect(FIXED.length).toBeLessThan(200);
  });
});
