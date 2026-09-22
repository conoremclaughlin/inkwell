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
 * downstream had looked at it. Hence the two budgets below: producers take
 * DIAGNOSTIC, and the trim to DISPLAY happens only where a human reads.
 */

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

  const lines = stripAnsi(raw)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const meaningful = lines.filter(
    (line) => !STARTUP_NOISE.some((p) => p.test(line)) && !BANNER_ONLY.test(line)
  );

  // Never let the noise filter be the reason a human gets nothing. If every
  // line looked like startup chatter, the chatter IS the whole output and is
  // better shown than swallowed.
  const kept = meaningful.length > 0 ? meaningful : lines;
  if (kept.length === 0) return '';

  const whole = kept.join('\n');
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

/**
 * Compose the failure text for a backend that exited non-zero.
 *
 * `stderr` is preferred when it carries anything readable, falling back to
 * `stdout` — many CLIs report fatal errors on stdout, which is exactly the
 * case that produced the banner-only alert.
 *
 * Defaults to the DIAGNOSTIC budget, not the display one, and that is the
 * whole point of the distinction: what this returns becomes a runner's
 * `error`, which `classifyError` reads at two seams before any human sees
 * it. Callers that display this text excerpt it again at their own seam.
 */
export function describeExit(params: {
  command: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  options?: FailureExcerptOptions;
}): string {
  const { command, exitCode, stdout = '', stderr = '', options = DIAGNOSTIC_EXCERPT } = params;

  const fromStderr = failureExcerpt(stderr, options);
  const excerpt = fromStderr || failureExcerpt(stdout, options);

  return excerpt
    ? `${command} exited with code ${exitCode}: ${excerpt}`
    : `${command} exited with code ${exitCode} (no diagnostic output)`;
}
