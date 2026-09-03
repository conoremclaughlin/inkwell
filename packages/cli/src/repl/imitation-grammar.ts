/**
 * One grammar for the runtime's tool-result frame — and for what a line could
 * still become while it is being streamed.
 *
 * The detector (`findImitatedToolResults`) needs "is this whole line a frame
 * header / results line?"; the live guards need "could this partial line
 * still turn into one?". Two hand-written answers drifted (Lumen, PR #575
 * round 4): the detector accepted arbitrary spaces and tabs around the role
 * colon and the FINAL separator, the prefix predicate enumerated a handful of
 * spacings, so `user  :  [Tool results…` had prefixes the guard published.
 * Here both questions are asked of the same pieces.
 *
 * Fences live here too, for the same reason: the detector and the paragraph
 * buffer each decided what closes a fenced block, and both ended one on a
 * line CommonMark treats as content (a closer may only carry trailing
 * whitespace; an opener may carry an info string).
 */

type Piece =
  /** Literal text, matched case-insensitively. */
  | { literal: string }
  /** A run of spaces/tabs, possibly empty. */
  | { ws: true }
  /** Exactly one of the alternatives (an empty alternative makes the group optional). */
  | { choice: Piece[][] }
  /** A tool name: `[A-Za-z_][\w.-]*`. */
  | { name: true }
  /** One character from the set. */
  | { oneOf: string }
  /** Anything at all, to the end of the line. */
  | { rest: true };

const ROLES = ['user', 'human', 'assistant', 'system'];
const RESULT_STATUSES = [
  'executed',
  'approved',
  'error',
  'failed',
  'blocked',
  'denied',
  'rejected',
];

/**
 * `[ws][role[ws][:]][ws][Tool results from previous turn[ws]—[ws]FINAL][ws]`
 * — the frame header as buildContinuationBody / buildFinalRelayBody write it
 * and as a model reproduces it (Myra wrote `user[Tool results from previous
 * turn]`, the transcript shape).
 */
const HEADER: Piece[] = [
  { ws: true },
  {
    choice: [
      [],
      [
        { choice: ROLES.map((r) => [{ literal: r }]) },
        { ws: true },
        { choice: [[], [{ literal: ':' }]] },
        { ws: true },
      ],
    ],
  },
  { literal: '[tool results from previous turn' },
  {
    choice: [
      [],
      [
        { ws: true },
        { choice: [[{ literal: '—' }], [{ literal: '–' }], [{ literal: '-' }]] },
        { ws: true },
        { literal: 'final' },
      ],
    ],
  },
  { literal: ']' },
  { ws: true },
];

/** `[ws]Tool <name> (<status>):[ws]<json-start>…` — a results line without its header. */
const RESULT_LINE: Piece[] = [
  { ws: true },
  { literal: 'tool ' },
  { name: true },
  { literal: ' (' },
  { choice: RESULT_STATUSES.map((s) => [{ literal: s }]) },
  { literal: '):' },
  { ws: true },
  { oneOf: '[{"' },
  { rest: true },
];

const isWs = (ch: string | undefined): boolean => ch === ' ' || ch === '\t';
const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
const isNameChar = (ch: string): boolean => /[\w.-]/.test(ch);

/**
 * Walk `text` against `pieces`. In `prefix` mode the walk succeeds as soon as
 * the text is exhausted — whatever pieces remain could still arrive. In whole
 * mode the text and the pieces must run out together.
 */
/** Whether every remaining piece can match the empty string. */
function matchesEmpty(pieces: Piece[]): boolean {
  return pieces.every((piece) => {
    if ('literal' in piece) return piece.literal.length === 0;
    if ('ws' in piece || 'rest' in piece) return true;
    if ('choice' in piece) return piece.choice.some((alt) => matchesEmpty(alt));
    return false; // name, oneOf
  });
}

function walk(pieces: Piece[], text: string, i: number, prefix: boolean): boolean {
  // Text exhausted: a prefix is satisfied by definition; a whole line only if
  // everything still expected is optional (trailing whitespace, FINAL, …).
  if (i === text.length) return prefix || matchesEmpty(pieces);
  if (pieces.length === 0) return false;
  const [piece, ...rest] = pieces as [Piece, ...Piece[]];
  if ('literal' in piece) {
    const want = piece.literal;
    const have = text.slice(i, i + want.length).toLowerCase();
    if (have === want) return walk(rest, text, i + want.length, prefix);
    // The text ends inside the literal: a prefix, if what is there agrees.
    return prefix && i + want.length > text.length && want.startsWith(have);
  }
  if ('ws' in piece) {
    let j = i;
    while (j < text.length && isWs(text[j])) j += 1;
    // Longest run first, then shorter — the next piece may want the space.
    for (let k = j; k >= i; k -= 1) if (walk(rest, text, k, prefix)) return true;
    return false;
  }
  if ('choice' in piece) {
    return piece.choice.some((alt) => walk([...alt, ...rest], text, i, prefix));
  }
  if ('name' in piece) {
    if (!isNameStart(text[i]!)) return false;
    let j = i + 1;
    while (j < text.length && isNameChar(text[j]!)) j += 1;
    for (let k = j; k > i; k -= 1) if (walk(rest, text, k, prefix)) return true;
    return false;
  }
  if ('oneOf' in piece) {
    return piece.oneOf.includes(text[i]!) && walk(rest, text, i + 1, prefix);
  }
  // rest
  return true;
}

const stripCr = (line: string): string => line.replace(/\r$/, '');

/** The whole line is the runtime's frame header. */
export function isImitationHeaderLine(line: string): boolean {
  return walk(HEADER, stripCr(line), 0, false);
}

/** The whole line is a runtime results line (`Tool x (executed): {…`). */
export function isImitationResultLine(line: string): boolean {
  return walk(RESULT_LINE, stripCr(line), 0, false);
}

/** The line, as far as it goes, could still become either of the above. */
export function isPotentialImitationPrefix(line: string): boolean {
  const probe = stripCr(line);
  if (!probe.trim()) return false;
  return walk(HEADER, probe, 0, true) || walk(RESULT_LINE, probe, 0, true);
}

// ─── Fences ────────────────────────────────────────────────────

export interface OpenFence {
  char: string;
  length: number;
}

/**
 * The fence state after `line`, given the state before it. CommonMark: a
 * fence opens on three or more backticks or tildes (after up to three
 * spaces), optionally followed by an info string — which for a backtick fence
 * may not contain a backtick. It closes only on the same character, at least
 * as long, followed by nothing but spaces or tabs. Anything else inside an
 * open fence is content — including ```not-a-close (Lumen, PR #575 round 4).
 */
export function fenceAfterLine(open: OpenFence | null, line: string): OpenFence | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(stripCr(line));
  if (!m) return open;
  const char = m[1]![0]!;
  const length = m[1]!.length;
  const after = m[2]!;
  if (open === null) {
    if (char === '`' && after.includes('`')) return null;
    return { char, length };
  }
  if (open.char === char && length >= open.length && after.trim() === '') return null;
  return open;
}

/** Whether a fence is still open at the end of `text`. */
export function fenceOpenAtEnd(text: string): boolean {
  let open: OpenFence | null = null;
  for (const line of text.split('\n')) open = fenceAfterLine(open, line);
  return open !== null;
}
