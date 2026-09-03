/**
 * Paragraph-level flush buffer for streamed assistant text.
 *
 * The Ink TUI writes completed messages to terminal scrollback (write-once
 * <Static>), so live streaming appends at PARAGRAPH granularity: deltas
 * accumulate until a blank-line boundary completes a paragraph, which is then
 * emitted as its own scrollback line.
 *
 * Fence-aware: a ``` code fence (markdown or ```ink-tool blocks in local tool
 * routing) is never split across paragraphs — content is held until the fence
 * closes, so a tool-call block always lands as ONE unit that the caller can
 * strip or render whole. An unclosed fence is resolved by flush() at block end.
 */
export class ParagraphStreamBuffer {
  private buffer = '';

  /**
   * Feed a delta; returns paragraphs completed by this chunk (trimmed,
   * non-empty). Content inside an open ``` fence stays buffered.
   */
  push(delta: string): string[] {
    this.buffer += delta;
    const parts = this.buffer.split(/\n{2,}/);
    const tail = parts.pop() ?? ''; // incomplete paragraph — stays buffered
    const out: string[] = [];
    let held = '';
    for (const part of parts) {
      held = held ? `${held}\n\n${part}` : part;
      const fences = (held.match(/```/g) || []).length;
      if (fences % 2 === 0) {
        const para = held.trim();
        if (para) out.push(para);
        held = '';
      }
    }
    this.buffer = held ? `${held}\n\n${tail}` : tail;
    return out;
  }

  /** Flush the buffered tail (end of a text block or turn); null when empty. */
  flush(): string | null {
    const tail = this.buffer.trim();
    this.buffer = '';
    return tail || null;
  }

  /** Drop any buffered content (start of a new turn). */
  reset(): void {
    this.buffer = '';
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
 * Owns the three correctness properties the TUI needs (Lumen review, PR #457):
 * - **Attribution**: the first streamed line of a turn gets the agent header;
 *   later lines are continuations ONLY while nothing else has touched the
 *   scrollback — `noteInterleave()` (called when a queued user/system echo or
 *   any other writer lands between paragraphs) forces a fresh header on the
 *   next line, so an unlabeled paragraph can never sit under someone else's
 *   message.
 * - **Dedupe**: `completeMessage()` records the full message text (the parser
 *   emits one text event per assistant stream event; a later text block of the
 *   SAME message arrives flagged `continuesMessage` and is appended), so
 *   `shouldSkipFinal()` is an exact comparison against what final-response
 *   extraction uses — a multi-text-block message never reprints.
 * - **Display transform**: every emitted line passes through the transform
 *   (e.g. stripLocalToolBlocks in local routing) — held tool fences are
 *   stripped, and a line that strips to nothing is not emitted.
 * - **Guard**: under local tool routing the loop discards everything from an
 *   imitated results frame on (agent-loop `findImitatedToolResults`), but the
 *   loop only sees the text after the spawn ends — the live stream had already
 *   put the fabricated results on screen (Lumen, PR #575 round 1). The same
 *   detector runs here on every paragraph before it is emitted: the prefix
 *   before the frame renders, the rest is muted until the host announces the
 *   next backend spawn (`beginSpawn()`), and the recorded message text is the
 *   cut text so the final dedupe still matches.
 */
export class StreamedTurnRenderer {
  private buffer = new ParagraphStreamBuffer();
  private headerShown = false;
  private sawDeltaThisMessage = false;
  private streamedVisible = false;
  private lastMessageText = '';
  private muted = false;

  constructor(
    private readonly transform: (text: string) => string = (t) => t,
    private readonly options: StreamedTurnRendererOptions = {}
  ) {}

  /** Start of a new turn — drop all state. */
  reset(): void {
    this.buffer.reset();
    this.headerShown = false;
    this.sawDeltaThisMessage = false;
    this.streamedVisible = false;
    this.lastMessageText = '';
    this.muted = false;
  }

  /**
   * A new backend spawn began (initial, reseed, or tool-loop continuation).
   * Whatever the previous spawn wrote past an imitated frame no longer applies:
   * the loop has discarded it and answered with the real results.
   */
  beginSpawn(): void {
    this.muted = false;
  }

  /** Another writer appended to the scrollback — next line re-renders the header. */
  noteInterleave(): void {
    this.headerShown = false;
  }

  /** Feed a text delta; returns lines to append now. */
  pushDelta(text: string): StreamedLine[] {
    this.sawDeltaThisMessage = true;
    return this.emitAll(this.buffer.push(text));
  }

  /**
   * The assistant message completed with this full text. Flushes the buffered
   * tail; when no deltas arrived at all (backend without partial-message
   * support), emits the whole message so streaming still lands at message
   * granularity.
   */
  completeMessage(fullText: string, opts?: { continuesMessage?: boolean }): StreamedLine[] {
    const tail = this.buffer.flush();
    const lines =
      tail !== null
        ? this.emitAll([tail])
        : this.sawDeltaThisMessage
          ? []
          : this.emitAll([fullText.trim()]);
    // Recorded CUT, like the loop's final text, so shouldSkipFinal compares
    // like with like — the frame is not part of the message anyone sees. Once
    // a frame has cut this message, a later block of it (after thinking) is
    // past the cut as well: the loop's assembled text drops it whole.
    // (`muted` was set by emitAll, which has seen every paragraph of it.)
    this.lastMessageText = this.cutAtFrame(
      opts?.continuesMessage
        ? this.muted
          ? this.lastMessageText
          : this.lastMessageText + fullText
        : fullText
    );
    this.sawDeltaThisMessage = false;
    return lines;
  }

  private cutAtFrame(text: string): string {
    const frame = this.options.guard?.(text);
    return frame ? text.slice(0, frame.index).trimEnd() : text;
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

  private emitAll(paragraphs: string[]): StreamedLine[] {
    const lines: StreamedLine[] = [];
    for (const para of paragraphs) {
      if (this.muted) break;
      let text = para;
      const frame = this.options.guard?.(para);
      if (frame) {
        // The prefix is the model's own words (a fence, a sentence); from the
        // frame on it is the runtime's voice, faked. Nothing after it renders.
        text = para.slice(0, frame.index).trimEnd();
        this.muted = true;
      }
      const display = this.transform(text).trim();
      if (!display) continue;
      lines.push({ text: display, continuation: this.headerShown });
      this.headerShown = true;
      this.streamedVisible = true;
    }
    return lines;
  }
}

export interface StreamedTurnRendererOptions {
  /**
   * Where the model starts writing the runtime's part of the conversation —
   * agent-loop `findImitatedToolResults`, under local tool routing. Returns the
   * offset to cut at, or null. Omit for backend routing, where native tool use
   * makes the shape impossible.
   */
  guard?: (text: string) => { index: number } | null;
}
