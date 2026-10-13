/**
 * Paragraph-level flush buffer for streamed assistant text.
 *
 * The Ink TUI writes completed messages to terminal scrollback (write-once
 * <Static>), so live streaming appends at PARAGRAPH granularity: deltas
 * accumulate until a blank-line boundary completes a paragraph, which is then
 * emitted as its own scrollback line.
 *
 * Fence-aware: a fenced code block (backtick or tilde, any length — the same
 * rule the imitation detector uses; markdown or ```ink-tool blocks in local
 * tool routing) is never split across paragraphs — content is held until the
 * fence closes, so a tool-call block always lands as ONE unit that the caller
 * can strip or render whole. An unclosed fence is resolved by flush().
 *
 * Every paragraph is reported as a SPAN of the raw text fed since reset —
 * exact offsets, text taken verbatim from the raw. Nothing is normalized:
 * an earlier version collapsed blank-line runs inside a held fence, and a
 * consumer mapping the normalized paragraph back onto raw offsets by length
 * ended up with the wrong end — past which a fabricated results frame slipped
 * onto the screen (Lumen, PR #575 round 3). One coordinate system, no
 * heuristics.
 */
import { fenceOpenAtEnd } from './imitation-grammar.js';

export interface ParagraphSpan {
  /** The paragraph, trimmed — exactly `raw.slice(start, end)`. */
  text: string;
  /** Offsets into the raw text fed since the last reset. */
  start: number;
  end: number;
}

function trimmedSpan(raw: string, start: number, end: number): ParagraphSpan | null {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(raw[s]!)) s += 1;
  while (e > s && /\s/.test(raw[e - 1]!)) e -= 1;
  if (s >= e) return null;
  return { text: raw.slice(s, e), start: s, end: e };
}

export class ParagraphStreamBuffer {
  private raw = '';
  /** Where the paragraph under construction begins. */
  private paraStart = 0;
  /** Where the next blank-line scan resumes (past boundaries already judged). */
  private scanFrom = 0;

  /** Feed a delta; returns the paragraphs completed by this chunk (text only). */
  push(delta: string): string[] {
    return this.pushSpans(delta).map((span) => span.text);
  }

  /**
   * Feed a delta; returns the paragraphs completed by this chunk as spans of
   * the raw text. Content inside an open fence stays buffered.
   */
  pushSpans(delta: string): ParagraphSpan[] {
    this.raw += delta;
    const out: ParagraphSpan[] = [];
    const boundary = /\n{2,}/g;
    boundary.lastIndex = this.scanFrom;
    let m: RegExpExecArray | null;
    while ((m = boundary.exec(this.raw))) {
      const boundaryEnd = m.index + m[0].length;
      if (fenceOpenAtEnd(this.raw.slice(this.paraStart, m.index))) {
        // Inside a fence: this blank run is content, not a boundary.
        this.scanFrom = boundaryEnd;
        continue;
      }
      const span = trimmedSpan(this.raw, this.paraStart, m.index);
      if (span) out.push(span);
      this.paraStart = boundaryEnd;
      this.scanFrom = boundaryEnd;
    }
    return out;
  }

  /** Flush the buffered tail (end of the spawn); null when empty. */
  flush(): string | null {
    return this.flushSpan()?.text ?? null;
  }

  flushSpan(): ParagraphSpan | null {
    const span = trimmedSpan(this.raw, this.paraStart, this.raw.length);
    // Offsets stay valid for the caller: the raw is retained until reset().
    this.paraStart = this.raw.length;
    this.scanFrom = this.raw.length;
    return span;
  }

  /** Drop any buffered content (start of a new spawn/turn). Offsets restart at 0. */
  reset(): void {
    this.raw = '';
    this.paraStart = 0;
    this.scanFrom = 0;
  }
}

/** One line of streamed output for the TUI to append. */
export interface StreamedLine {
  text: string;
  /** True when the line follows another streamed line with nothing between —
   * rendered without a label row. False = render a fresh agent header. */
  continuation: boolean;
}

/**
 * Turn-scoped state machine for live paragraph rendering.
 *
 * Owns the correctness properties the TUI needs (Lumen review, PR #457):
 * - **Attribution**: the first streamed line of a turn gets the agent header;
 *   later lines are continuations ONLY while nothing else has touched the
 *   scrollback — `noteInterleave()` (called when a queued user/system echo or
 *   any other writer lands between paragraphs) forces a fresh header on the
 *   next line, so an unlabeled paragraph can never sit under someone else's
 *   message.
 * - **Dedupe**: `completeMessage()` records the message text (a later text
 *   block of the SAME message arrives flagged `continuesMessage` and is
 *   appended), cut like the loop cuts it, so `shouldSkipFinal()` is an exact
 *   comparison against what final-response extraction uses — a multi-block
 *   message never reprints.
 * - **Display transform**: every emitted line passes through the transform
 *   (e.g. stripLocalToolBlocks in local routing) — held tool fences are
 *   stripped, and a line that strips to nothing is not emitted.
 * - **Guard**: under local tool routing the loop discards everything from an
 *   imitated results frame on (agent-loop `findImitatedToolResults`), but the
 *   loop only sees the text after the spawn ends — the live stream had already
 *   put the fabricated results on screen (Lumen, PR #575 round 1). The same
 *   detector runs here, over the WHOLE spawn's text so far — never one
 *   paragraph in isolation, whose fence context and line boundaries are not
 *   the message's (round 2). Text before the cut renders; from the cut on is
 *   muted until the host announces the next spawn (`beginSpawn()`). An
 *   incomplete paragraph is held across text-block boundaries and released by
 *   `endSpawn()`, so a header split across blocks is judged whole.
 */
export class StreamedTurnRenderer {
  private buffer = new ParagraphStreamBuffer();
  private headerShown = false;
  private sawDeltaThisBlock = false;
  private streamedVisible = false;
  /**
   * Everything streamed in the current spawn, uncut — the guard's subject.
   * Fed exactly what the paragraph buffer is fed, and reset with it, so the
   * buffer's spans are offsets into this string.
   */
  private spawnText = '';
  /** Text of the current block (deltas, or the completed block when none). */
  private blockText = '';
  /** The current assistant message, uncut, across its continued blocks. */
  private messageText = '';
  private muted = false;
  private lastMessageText = '';

  constructor(
    private readonly transform: (text: string) => string = (t) => t,
    private readonly options: StreamedTurnRendererOptions = {}
  ) {}

  /** Start of a new turn — drop all state. */
  reset(): void {
    this.beginSpawn();
    this.headerShown = false;
    this.streamedVisible = false;
    this.lastMessageText = '';
  }

  /**
   * A new backend spawn began (initial, reseed, or tool-loop continuation).
   * Whatever the previous spawn wrote past an imitated frame no longer applies:
   * the loop has discarded it and answered with the real results. Anything
   * still buffered from the previous spawn is dropped — call `endSpawn()`
   * first to render it.
   */
  beginSpawn(): void {
    this.buffer.reset();
    this.sawDeltaThisBlock = false;
    this.spawnText = '';
    this.blockText = '';
    this.messageText = '';
    this.muted = false;
  }

  /**
   * The spawn's stream has ended: release the held tail. Called by the host
   * once the backend turn resolves, so the last paragraph of a spawn — the
   * only one that can still be a half-written frame — is judged with the
   * whole spawn's text in view.
   */
  endSpawn(): StreamedLine[] {
    const tail = this.buffer.flushSpan();
    return tail !== null ? this.emitAll([tail]) : [];
  }

  /** Another writer appended to the scrollback — next line re-renders the header. */
  noteInterleave(): void {
    this.headerShown = false;
  }

  /** Feed a text delta; returns lines to append now. */
  pushDelta(text: string): StreamedLine[] {
    this.sawDeltaThisBlock = true;
    this.blockText += text;
    this.spawnText += text;
    return this.emitAll(this.buffer.pushSpans(text));
  }

  /**
   * A text block completed with this full text. When no deltas arrived for it
   * (backend without partial-message support), the block is fed as one delta
   * so streaming still lands at paragraph granularity. The buffered tail is
   * NOT flushed here — a block boundary is not a message boundary — it waits
   * for `endSpawn()`.
   */
  completeMessage(fullText: string, opts?: { continuesMessage?: boolean }): StreamedLine[] {
    let lines: StreamedLine[] = [];
    if (!this.sawDeltaThisBlock) {
      this.blockText = fullText;
      this.spawnText += fullText;
      lines = this.emitAll(this.buffer.pushSpans(fullText));
    }
    // Recorded CUT, like the loop's final text, so shouldSkipFinal compares
    // like with like. The cut is found on the UNCUT message as a whole — a
    // frame split across blocks is found once its halves meet, and a
    // legitimate prefix of the block that introduced it survives.
    this.messageText = opts?.continuesMessage ? this.messageText + this.blockText : this.blockText;
    this.lastMessageText = this.cutAtFrame(this.messageText);
    this.blockText = '';
    this.sawDeltaThisBlock = false;
    return lines;
  }

  /**
   * True when the final response body is already on screen — the turn should
   * close with a compact meta line instead of reprinting it. `finalDisplayText`
   * is the display form (already transformed by the caller); the recorded raw
   * message text goes through the same transform for a like-for-like match.
   */
  shouldSkipFinal(finalDisplayText: string): boolean {
    if (!this.streamedVisible) return false;
    return finalDisplayText.trim() === this.transform(this.lastMessageText).trim();
  }

  private cutAtFrame(text: string): string {
    const frame = this.options.guard?.(text);
    return frame ? text.slice(0, frame.index).trimEnd() : text;
  }

  private emitAll(spans: ParagraphSpan[]): StreamedLine[] {
    const lines: StreamedLine[] = [];
    for (const span of spans) {
      if (this.muted) break;
      // Judged against the whole spawn so far, in the buffer's own offsets:
      // fence context and line boundaries are the message's, and the cut
      // lands where the detector says, not where a length heuristic guessed.
      const frame = this.options.guard?.(this.spawnText) ?? null;
      let text = span.text;
      if (frame && frame.index <= span.start) {
        this.muted = true;
        break;
      }
      if (frame && frame.index < span.end) {
        // The prefix is the model's own words (a fence, a sentence); from the
        // frame on it is the runtime's voice, faked. Nothing after it renders.
        text = this.spawnText.slice(span.start, frame.index).trimEnd();
        this.muted = true;
      }
      const display = this.transform(text).trim();
      if (display) {
        lines.push({ text: display, continuation: this.headerShown });
        this.headerShown = true;
        this.streamedVisible = true;
      }
      if (this.muted) break;
    }
    return lines;
  }
}

export interface StreamedTurnRendererOptions {
  /**
   * Where the model starts writing the runtime's part of the conversation —
   * agent-loop `findImitatedToolResults`, under local tool routing. Called
   * with the whole spawn's text so far; returns the offset to cut at, or
   * null. Omit for backend routing, where native tool use makes the shape
   * impossible.
   */
  guard?: (text: string) => { index: number } | null;
}
