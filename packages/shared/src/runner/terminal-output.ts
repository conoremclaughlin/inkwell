/**
 * Terminal Output Sanitising
 *
 * Backend CLIs are written to be read by a human at a terminal, so their
 * output carries colour, cursor control and a startup banner. When a run
 * fails we quote that output into places no terminal ever renders: a log
 * field, an inbox row, and — the one that matters — a Telegram message to
 * the person whose monitor just stopped working.
 *
 * Measured on 2026-09-22, from the two escalations in `~/.ink/logs`: the
 * alert Conor received opened with `Applied "Safe" profile`, then the
 * identity-context and keychain lines, then a `session_meta` JSON blob,
 * then several hundred bytes of the ink startup banner as raw escape
 * sequences. The only diagnostic in it was `exited with code 1`, and both
 * escalations classified `unknown`.
 *
 * None of that was the error. It was the first thing the process printed,
 * because the capture took the HEAD of the output. So these helpers strip
 * the terminal control bytes and then keep BOTH ends: the first lines, where
 * a runtime announces what went wrong, and the last, where it says where it
 * stopped. An unconditional tail is the mirror of the bug it replaced —
 * `Error: fetch failed` followed by a long enough stack pushes the only
 * sentence naming the cause off the front (Lumen, review of PR #662).
 *
 * Order matters and is the point: strip first, truncate second. Escape
 * sequences were 20.4% of the first 500 bytes of that payload and far more
 * inside the banner, where one visible cell costs ~45 bytes — so truncating
 * raw output spends the budget on bytes that render as nothing. Cutting
 * mid-sequence also strands a dangling `ESC[` in whatever displays it.
 *
 * The second rule this module exists to hold: a budget chosen for a phone
 * screen must never be the budget a classifier reads. `classifyError` matches
 * prose in the same string a runner hands back, so trimming that string for
 * display decides a category — on 2026-09-22 an excerpt cut to alert size
 * turned `network`/retryable into `unknown`/non-retryable before anything
 * downstream had looked at it.
 *
 * A wider budget does not hold that rule, it only moves where it breaks: give
 * the diagnostic excerpt 2000 characters and a 3527-character failure puts the
 * error line in the elided middle, and the category is decided by a text
 * policy again (Lumen, second review of PR #662 — measured, not argued). So
 * the classification is not derived from the excerpt at all. `describeExitResult`
 * classifies `readableOutput`, which is everything the process said with the
 * terminal noise gone and NOTHING truncated, and returns that verdict
 * alongside the bounded text for a human. Producers carry the verdict;
 * consumers prefer it and fall back to classifying the text they were given.
 * The two budgets below bound only what is read, never what is decided.
 */

import { classifyError, type ErrorClassification } from '../errors/classify-error.js';

/**
 * CSI (`ESC[` … final byte), OSC (`ESC]` … BEL or ST), and the two-character
 * escapes. Deliberately wider than the SGR-only regex in the CLI's
 * `tui-components.ts`: the banner is SGR, but cursor moves (`ESC[2K`,
 * `ESC[1A`) and title sets (OSC) reach these buffers too, and a partial
 * strip is what leaves `[0m` litter behind in the text.
 */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;:<=>?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** C0 control bytes with no meaning in a plain-text excerpt. Tab and newline are kept. */
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Lines a backend prints before it has done any work. Each is anchored to
 * the start of the line so a line that merely *mentions* one of these — an
 * agent quoting an incident, a diff — is not mistaken for the banner.
 *
 * A missing entry costs noise. An over-broad one costs the cause, and the
 * fallback in `failureExcerpt` does NOT save you from that: it only fires
 * when filtering leaves nothing at all, so a pattern that eats the error
 * line while any other line survives loses it silently (Lumen, review of
 * PR #662 — the earlier wording here claimed a guarantee the fallback does
 * not give). Anchor every pattern, and keep them to lines a backend prints
 * before it has done any work.
 */
const STARTUP_NOISE: RegExp[] = [
  /^Applied "[^"]*" profile\b/,
  /^Identity context loaded:/,
  /^Keychain: \d+ credential/,
  /^\{"type":"session_meta"/,
];

/** True for a line that is only box-drawing/blank once the colour is gone — the banner. */
const BANNER_ONLY = /^[\s▀-▟─-╿■-◿]*$/;

/**
 * Remove ANSI escape sequences and stray control bytes, normalising the
 * carriage returns that progress spinners leave behind.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(CONTROL_PATTERN, '');
}

/**
 * Everything readable the process said, in order: control bytes stripped,
 * banner and startup-noise lines dropped, blank lines removed — and nothing
 * truncated.
 *
 * This is the sanitising half of `failureExcerpt`, split out because two
 * callers need the same text at different lengths. A human gets a budgeted
 * excerpt of it; `classifyError` gets all of it. Sharing the step is what
 * makes the pair honest: the classifier reads exactly the text the excerpt
 * was cut from, so a category and the sentence supporting it can never come
 * from differently-filtered inputs.
 *
 * Falls back to the unfiltered lines when filtering leaves nothing, on the
 * same reasoning as the excerpt: if every line looked like startup chatter,
 * the chatter IS the whole output.
 */
export function readableOutput(raw: string): string {
  const lines = stripAnsi(raw)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const meaningful = lines.filter(
    (line) => !STARTUP_NOISE.some((p) => p.test(line)) && !BANNER_ONLY.test(line)
  );

  return (meaningful.length > 0 ? meaningful : lines).join('\n');
}

/** Marks where text was removed, on its own line between the two ends. */
const ELISION = '…';

/**
 * What a person reads in an alert: small enough to arrive on a phone as a
 * message rather than a wall.
 */
export const DISPLAY_EXCERPT = { maxLines: 12, maxChars: 800 } as const;

/**
 * What a machine reads. Wider, because the string a runner returns is the
 * one `classifyError` matches against, and a category decided by a display
 * budget is a category decided by nothing. Still bounded — this text reaches
 * a log field and a DB column — but bounded for the classifier, and at both
 * ends, so a signature at either edge survives. Compare what it replaced in
 * `InkRunner`: 1000 characters of the HEAD, raw escape sequences included.
 */
export const DIAGNOSTIC_EXCERPT = { maxLines: 40, maxChars: 2000 } as const;

export interface FailureExcerptOptions {
  /** Keep at most this many lines from the end. Default 12. */
  maxLines?: number;
  /** Protect at most this many whole lines at the start. Default 3. */
  headLines?: number;
  /** Hard cap on the returned length, applied last. Default 800. */
  maxChars?: number;
  /** Share of `maxChars` reserved for the head. Default a quarter, floor 200. */
  headChars?: number;
}

/**
 * Turn raw captured process output into the most informative excerpt that
 * fits.
 *
 * Strips terminal control bytes, drops startup-banner lines, and keeps both
 * ends with an elision between them: the HEAD because a runtime names the
 * fault before its stack, the TAIL because the last thing a failing process
 * printed is where it stopped. Returns an empty string only when the input
 * had no readable text at all, which callers should render as an explicit
 * "no output" rather than as a blank.
 */
export function failureExcerpt(raw: string, options: FailureExcerptOptions = {}): string {
  const { maxLines = DISPLAY_EXCERPT.maxLines, maxChars = DISPLAY_EXCERPT.maxChars } = options;
  const { headLines = 3 } = options;
  // A quarter of the budget, with room for a sentence like `Error: connect
  // ECONNREFUSED 127.0.0.1:3001` at the default 800 — but never more than
  // half, so the end of the output keeps the larger share no matter how small
  // the budget gets. Without that ceiling a single very long first line under
  // a tight budget consumes all of it and the tail disappears.
  const headChars = Math.min(
    options.headChars ?? Math.max(200, Math.floor(maxChars / 4)),
    Math.max(1, Math.floor(maxChars / 2))
  );

  // Sanitised once, shared with the classifier. The noise-filter fallback —
  // if every line looked like startup chatter, the chatter IS the whole
  // output — lives in `readableOutput`.
  const whole = readableOutput(raw);
  if (!whole) return '';

  const kept = whole.split('\n');
  if (kept.length <= maxLines && whole.length <= maxChars) return whole;

  // The head: whole lines while they fit the head budget. A first line longer
  // than that budget on its own is cut rather than dropped — `Error: <type>:
  // <message>` leads, and the detail that follows it is what we can spare.
  let headEnd = 0;
  for (const line of kept.slice(0, headLines)) {
    const next = headEnd === 0 ? line.length : headEnd + 1 + line.length;
    if (next > headChars) break;
    headEnd = next;
  }
  const headText = headEnd > 0 ? whole.slice(0, headEnd) : whole.slice(0, headChars);

  // The tail, still trimmed from the front: the last line is the one most
  // likely to name where it stopped.
  const remainder = whole
    .slice(headText.length)
    .split('\n')
    .filter((line) => line.trim().length > 0);
  const tailBudget = Math.max(0, maxChars - headText.length - ELISION.length - 2);
  const tailWanted = remainder.slice(-maxLines).join('\n');
  const tailText = tailWanted.length > tailBudget ? tailWanted.slice(-tailBudget) : tailWanted;

  if (!tailText) return headText;

  // The marker is a claim about this specific excerpt, so it is measured
  // rather than assumed: the two ends recombined are shorter than the input
  // exactly when something between them was dropped.
  const elided = headText.length + 1 + tailText.length < whole.length;
  return elided ? `${headText}\n${ELISION}\n${tailText}` : `${headText}\n${tailText}`;
}

export interface ExitDescription {
  /**
   * What a human (and a log field, and a DB column) gets: bounded, sanitised,
   * both ends kept. Lossy by design.
   */
  text: string;
  /**
   * What a machine should act on: computed from the FULL readable output
   * before any budget was applied, so no text policy can change it.
   */
  classification: ErrorClassification;
}

interface ExitParams {
  command: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  options?: FailureExcerptOptions;
  /** Passed through to `classifyError`. No rule reads it today. */
  backend?: string;
}

/**
 * Describe a backend that exited non-zero: the text to show, and the verdict
 * to act on.
 *
 * `stderr` is preferred when it carries anything readable, falling back to
 * `stdout` — many CLIs report fatal errors on stdout, which is exactly the
 * case that produced the banner-only alert. The same stream feeds both halves,
 * so the category and the sentence a human reads describe one thing.
 *
 * The excerpt takes the DIAGNOSTIC budget and the classification takes no
 * budget at all. That difference is the fix: a producer that classified its
 * own excerpt would decide the category with a text policy, which is the
 * defect this module already had twice — once at 1000 characters of head, once
 * at 2000 characters of head-and-tail.
 *
 * Two bounded claims, so this is not read as more than it is:
 *
 *  - `exitCode` is deliberately NOT passed to the classifier, though it is in
 *    the text. The `crash` rule matches any non-zero exit, so passing it would
 *    make every failed turn `crash` instead of `unknown` — and non-retryable
 *    non-unknown is the condition session-service flushes a message queue on.
 *    That is a behaviour change with nothing to do with truncation. Consumers
 *    that want it classify with the exit code themselves, as they do today.
 *  - The classifier now reads the whole readable output rather than its first
 *    kilobyte, so prose the run itself printed — an agent quoting `fetch
 *    failed`, a diff mentioning a 429 — can match a rule it would previously
 *    have been truncated past. That widening is inherent to matching prose and
 *    is the price of not deciding the category by budget; it is the reason the
 *    rules are written as signatures rather than keywords.
 */
export function describeExitResult(params: ExitParams): ExitDescription {
  const { command, exitCode, stdout = '', stderr = '', options = DIAGNOSTIC_EXCERPT } = params;

  const fromStderr = failureExcerpt(stderr, options);
  const usingStderr = fromStderr.length > 0;
  const excerpt = usingStderr ? fromStderr : failureExcerpt(stdout, options);
  const full = readableOutput(usingStderr ? stderr : stdout);

  return {
    text: excerpt
      ? `${command} exited with code ${exitCode}: ${excerpt}`
      : `${command} exited with code ${exitCode} (no diagnostic output)`,
    classification: classifyError({ errorText: full, backend: params.backend }),
  };
}

/**
 * The text half of `describeExitResult`, for callers with no classification
 * seam downstream.
 *
 * A caller whose result IS classified later should use `describeExitResult`
 * and carry the verdict: this returns a bounded string, and a bounded string
 * is exactly what cannot be trusted to classify.
 */
export function describeExit(params: ExitParams): string {
  return describeExitResult(params).text;
}
