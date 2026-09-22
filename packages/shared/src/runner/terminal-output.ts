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
 * because the capture took the HEAD of the output. A process that failed
 * says why at the END, so these helpers strip the terminal control bytes
 * and then keep the tail.
 *
 * Order matters and is the point: strip first, truncate second. Escape
 * sequences were 20.4% of the first 500 bytes of that payload and far more
 * inside the banner, where one visible cell costs ~45 bytes — so truncating
 * raw output spends the budget on bytes that render as nothing. Cutting
 * mid-sequence also strands a dangling `ESC[` in whatever displays it.
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
 * This list is an optimisation, not a safety boundary: `failureExcerpt`
 * falls back to the unfiltered tail if filtering would leave nothing, so a
 * missing entry costs noise and an over-broad one cannot cost the cause.
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

export interface FailureExcerptOptions {
  /** Keep at most this many lines from the end. Default 12. */
  maxLines?: number;
  /** Hard cap on the returned length, applied last. Default 800. */
  maxChars?: number;
}

/**
 * Turn raw captured process output into the most informative excerpt that
 * fits, for quoting to a human.
 *
 * Strips terminal control bytes, drops startup-banner lines, and keeps the
 * TAIL — the end of a failed process's output is where it said why.
 * Returns an empty string only when the input had no readable text at all,
 * which callers should render as an explicit "no output" rather than as a
 * blank.
 */
export function failureExcerpt(raw: string, options: FailureExcerptOptions = {}): string {
  const { maxLines = 12, maxChars = 800 } = options;

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
  const kept = (meaningful.length > 0 ? meaningful : lines).slice(-maxLines);
  const text = kept.join('\n');

  // Trim from the front: the last line is the one most likely to name the cause.
  return text.length > maxChars ? `…${text.slice(-(maxChars - 1))}` : text;
}

/**
 * Compose the failure text for a backend that exited non-zero.
 *
 * `stderr` is preferred when it carries anything readable, falling back to
 * `stdout` — many CLIs report fatal errors on stdout, which is exactly the
 * case that produced the banner-only alert.
 */
export function describeExit(params: {
  command: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  options?: FailureExcerptOptions;
}): string {
  const { command, exitCode, stdout = '', stderr = '', options } = params;

  const fromStderr = failureExcerpt(stderr, options);
  const excerpt = fromStderr || failureExcerpt(stdout, options);

  return excerpt
    ? `${command} exited with code ${exitCode}: ${excerpt}`
    : `${command} exited with code ${exitCode} (no diagnostic output)`;
}
