/**
 * Tests for terminal output sanitising.
 *
 * The bug these pin: on 2026-09-22 a heartbeat outage alert reached Conor's
 * phone carrying the ink startup banner as raw escape sequences, a
 * `session_meta` blob, and no cause — because the capture took the HEAD of
 * the process output. Myra reported it on `debug:myra-heartbeat-failures`.
 *
 * Fixtures below are invented. The shape is copied from the real payload (the
 * line order, the SGR-per-cell banner); the transcript path, ids and the
 * failure itself are synthetic.
 */

import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  readableOutput,
  failureExcerpt,
  describeExit,
  describeExitResult,
  DISPLAY_EXCERPT,
  DIAGNOSTIC_EXCERPT,
} from './terminal-output.js';
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
  // The middle is what gets dropped. Both ends are load-bearing and which one
  // holds the cause depends on the runtime: Node announces it first, most CLIs
  // print it last, and this module cannot tell them apart.
  it('keeps both ends and elides the middle', () => {
    const output = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const excerpt = failureExcerpt(output, { maxLines: 3, headLines: 1 });

    expect(excerpt).toBe('line 0\n…\nline 37\nline 38\nline 39');
  });

  // The tail and the noise filter are redundant for ink, whose banner we
  // recognise. They stop being redundant for every backend whose preamble we
  // do NOT have a pattern for — Claude and Gemini reject with their whole raw
  // stderr — and for the day ink's banner changes. This is that case: chatty
  // startup output that matches no filter, with the cause last.
  //
  // The head budget costs three lines of that preamble, and that cost is the
  // deliberate side of the trade: unrecognised noise at the front is
  // recoverable by reading past it, an error header dropped off the front is
  // not (Lumen, review of PR #662). The bulk of it still goes.
  it('surfaces the cause under preamble it does not recognise', () => {
    const unknownPreamble = Array.from(
      { length: 30 },
      (_, i) => `[startup] initialising subsystem ${i}`
    ).join('\n');
    const excerpt = failureExcerpt(`${unknownPreamble}\n${REAL_CAUSE}`);

    expect(excerpt).toContain(REAL_CAUSE);
    expect(excerpt).not.toContain('subsystem 5');
    expect(excerpt).not.toContain('subsystem 12');
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

  it('trims from the middle, keeping the last line intact', () => {
    const raw = 'noise '.repeat(400) + '\n' + REAL_CAUSE;
    const excerpt = failureExcerpt(raw, { maxChars: 200 });

    expect(excerpt.length).toBeLessThanOrEqual(200);
    expect(excerpt.endsWith(REAL_CAUSE)).toBe(true);
    // The cut moved to the middle when the head stopped being expendable; the
    // marker moved with it. A leading `…` was the old contract.
    expect(excerpt).toContain('\n…\n');
    expect(excerpt.startsWith('…')).toBe(false);
  });
});

/**
 * The second defect, found in review (Lumen, PR #662): an unconditional tail
 * is the same bug as an unconditional head, pointed the other way. A runtime
 * announces the fault BEFORE its stack, so the one sentence worth reading is
 * the one a long enough stack pushes out of the budget.
 *
 * Fixture is Lumen's, kept verbatim across all three files that pin this.
 */
describe('regression: a long stack used to push its own error message out', () => {
  const FRAMES = Array.from(
    { length: 10 },
    (_, i) =>
      `    at step${i} (/tmp/example.test/node_modules/example-backend/dist/runtime/transport/request-handler.js:100:20)`
  );
  const STACK = `Error: fetch failed\n${FRAMES.join('\n')}`;

  /** The control: the fixture has to actually overrun the display budget. */
  it('is a fixture that does not fit, or it proves nothing', () => {
    expect(STACK.length).toBeGreaterThan(DISPLAY_EXCERPT.maxChars);
  });

  it('keeps the error line and the last frame, and says what it dropped', () => {
    const excerpt = failureExcerpt(STACK);

    expect(excerpt).toContain('Error: fetch failed');
    expect(excerpt).toContain('at step9');
    expect(excerpt).toContain('\n…\n');
    expect(excerpt.length).toBeLessThanOrEqual(DISPLAY_EXCERPT.maxChars);
  });

  // The consequence that made this a bug rather than a presentation choice:
  // `classifyError` matches prose, and the only matchable prose was the line
  // being dropped.
  it('used to classify unknown once trimmed, and now reads network', () => {
    const TAIL_ONLY = FRAMES.join('\n').slice(-DISPLAY_EXCERPT.maxChars);

    expect(classifyError({ errorText: TAIL_ONLY }).category).toBe('unknown');
    expect(classifyError({ errorText: failureExcerpt(STACK) }).category).toBe('network');
  });

  // Producers take the diagnostic budget, which this fixture fits whole — so
  // the string a classifier reads is not even an excerpt.
  it('reaches a classifier untrimmed through describeExit', () => {
    const text = describeExit({ command: 'ink chat', exitCode: 1, stderr: STACK });

    expect(text).toContain('Error: fetch failed');
    expect(text).toContain('at step9');
    expect(text).not.toContain('…');
    expect(classifyError({ errorText: text }).category).toBe('network');
  });

  // Both ends survive even when the budget cannot hold the whole thing.
  it('keeps both ends when even the diagnostic budget overruns', () => {
    const huge = `Error: fetch failed\n${Array.from(
      { length: 400 },
      (_, i) =>
        `    at step${i} (/tmp/example.test/dist/runtime/transport/request-handler.js:100:20)`
    ).join('\n')}`;
    const text = describeExit({ command: 'ink chat', exitCode: 1, stderr: huge });

    expect(huge.length).toBeGreaterThan(DIAGNOSTIC_EXCERPT.maxChars);
    expect(text).toContain('Error: fetch failed');
    expect(text).toContain('at step399');
    expect(classifyError({ errorText: text }).category).toBe('network');
  });
});

/**
 * The budgets are separate numbers because they answer to different readers.
 * A display budget deciding an error category is the defect above; this pins
 * the ordering that prevents it.
 */
describe('display and diagnostic budgets', () => {
  it('gives a classifier more room than a phone screen', () => {
    expect(DIAGNOSTIC_EXCERPT.maxChars).toBeGreaterThan(DISPLAY_EXCERPT.maxChars);
    expect(DIAGNOSTIC_EXCERPT.maxLines).toBeGreaterThan(DISPLAY_EXCERPT.maxLines);
  });

  it('never returns more than the budget it was given', () => {
    const raw = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(80)}`).join('\n');

    for (const maxChars of [40, 120, 200, 800, 2000]) {
      expect(failureExcerpt(raw, { maxChars }).length).toBeLessThanOrEqual(maxChars);
    }
  });

  // The head must never crowd out the end, however tight the budget is or how
  // long the first line runs.
  it('keeps the tail reachable under a tight budget and a very long first line', () => {
    const raw = `${'x'.repeat(5000)}\nECONNREFUSED`;
    const excerpt = failureExcerpt(raw, { maxChars: 60 });

    expect(excerpt.length).toBeLessThanOrEqual(60);
    expect(excerpt).toContain('ECONNREFUSED');
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

/**
 * The second half of the same bug: a wider budget does not stop a text policy
 * deciding an error category, it only raises the length at which it does.
 *
 * Lumen measured it on the second review of PR #662. The fixture below is his:
 * an ordinary Node startup — two experimental-feature warnings and a
 * `[startup]` line — then the cause, then a stack long enough that the whole
 * thing overruns the DIAGNOSTIC budget. The head keeps the warnings, the tail
 * keeps frames, and `Error: fetch failed` is what the elision ate. Nothing in
 * the excerpt names a network fault, so a consumer reading the excerpt calls
 * it `unknown`/non-retryable, and the run is not retried.
 *
 * So the verdict is no longer taken from the excerpt at all. It is taken from
 * `readableOutput`, which has no budget.
 */
describe('regression: a verdict taken from the excerpt inherits the excerpt budget', () => {
  const NOISY_STARTUP = [
    '(node:123) Warning: Example optional feature is experimental',
    '(Use node --trace-warnings to show where the warning was created)',
    '[startup] initialising backend',
  ].join('\n');
  const FRAMES = Array.from(
    { length: 30 },
    (_, i) =>
      `    at step${i} (/tmp/example.test/node_modules/example-backend/dist/runtime/transport/request-handler.js:100:20)`
  );
  const NOISY_STACK = `${NOISY_STARTUP}\nError: fetch failed\n${FRAMES.join('\n')}`;

  /**
   * The control, and it is doing real work: if this fixture fit the diagnostic
   * budget, everything below would pass against the bug.
   */
  it('is a fixture that overruns the diagnostic budget, or it proves nothing', () => {
    expect(NOISY_STACK.length).toBeGreaterThan(DIAGNOSTIC_EXCERPT.maxChars);
  });

  /**
   * The failure being fixed, stated as a property of the text rather than as
   * an assertion about the old code: the excerpt is not merely shorter, it has
   * lost the only line a classifier could match. This going red would mean the
   * fixture had stopped exercising the case.
   */
  it('drops the cause into the elided middle, where nothing can match it', () => {
    const { text } = describeExitResult({ command: 'ink chat', exitCode: 1, stderr: NOISY_STACK });

    expect(text).toContain('…');
    expect(text).not.toContain('fetch failed');
    expect(classifyError({ errorText: text }).category).toBe('unknown');
  });

  it('classifies what the process said, not what fit in the excerpt', () => {
    const { classification } = describeExitResult({
      command: 'ink chat',
      exitCode: 1,
      stderr: NOISY_STACK,
    });

    expect(classification.category).toBe('network');
    expect(classification.retryable).toBe(true);
  });

  /**
   * The summary is why the classifier reads `readableOutput` rather than the
   * raw output. Both are unbounded; only one has the banner removed, and a
   * verdict whose summary line is `Applied "Safe" profile` is useless in the
   * activity stream however right its category is.
   */
  it('summarises from the sanitised text, not the first byte of the raw output', () => {
    const { classification } = describeExitResult({
      command: 'ink chat',
      exitCode: 1,
      stdout: `${STARTUP_NOISE}Error: fetch failed`,
    });

    expect(classification.category).toBe('network');
    expect(classification.summary).toBe('Error: fetch failed');
  });

  /**
   * The exit code is in the text and deliberately not in the verdict: the
   * `crash` rule matches any non-zero exit, so feeding it here would make
   * every failed turn `crash` and change what session-service flushes message
   * queues on. That is a behaviour change with nothing to do with truncation.
   */
  it('does not let a non-zero exit code alone decide a category', () => {
    const { classification } = describeExitResult({
      command: 'ink chat',
      exitCode: 1,
      stdout: 'the turn ended and said nothing a rule matches',
    });

    expect(classification.category).toBe('unknown');
    expect(classifyError({ errorText: 'the turn ended', exitCode: 1 }).category).toBe('crash');
  });

  /** `readableOutput` is the excerpt's own sanitising step, minus the budget. */
  it('shares its sanitising with the excerpt and differs only in length', () => {
    const full = readableOutput(NOISY_STACK);

    expect(stripAnsi(full)).toBe(full);
    expect(full).toContain('Error: fetch failed');
    expect(full).toContain('at step29');
    expect(full.length).toBeGreaterThan(DIAGNOSTIC_EXCERPT.maxChars);
    expect(readableOutput(`${STARTUP_NOISE}Error: fetch failed`)).toBe('Error: fetch failed');
  });

  /** `describeExit` stays the text half, byte for byte. */
  it('leaves the text half unchanged for callers that only display it', () => {
    const params = { command: 'ink chat', exitCode: 1, stderr: NOISY_STACK } as const;

    expect(describeExit(params)).toBe(describeExitResult(params).text);
  });
});
