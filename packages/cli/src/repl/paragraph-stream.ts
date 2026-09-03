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
 */
export class StreamedTurnRenderer {
  private buffer = new ParagraphStreamBuffer();
  private headerShown = false;
  private sawDeltaThisMessage = false;
  private streamedVisible = false;
  private lastMessageText = '';

  constructor(private readonly transform: (text: string) => string = (t) => t) {}

  /** Start of a new turn — drop all state. */
  reset(): void {
    this.buffer.reset();
    this.headerShown = false;
    this.sawDeltaThisMessage = false;
    this.streamedVisible = false;
    this.lastMessageText = '';
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
    this.lastMessageText = opts?.continuesMessage ? this.lastMessageText + fullText : fullText;
    this.sawDeltaThisMessage = false;
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

  private emitAll(paragraphs: string[]): StreamedLine[] {
    const lines: StreamedLine[] = [];
    for (const para of paragraphs) {
      const display = this.transform(para).trim();
      if (!display) continue;
      lines.push({ text: display, continuation: this.headerShown });
      this.headerShown = true;
      this.streamedVisible = true;
    }
    return lines;
  }
}
