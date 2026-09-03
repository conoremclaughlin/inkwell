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
  /** Everything streamed in the current spawn, uncut — the guard's subject. */
  private spawnText = '';
  /** Offset into `spawnText` up to which paragraphs have been emitted. */
  private emitCursor = 0;
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
    this.emitCursor = 0;
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
    const tail = this.buffer.flush();
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
    return this.emitAll(this.buffer.push(text));
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
      lines = this.emitAll(this.buffer.push(fullText));
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

  /** Where `para` sits in `spawnText`, searching forward from the emit cursor. */
  private locate(para: string): number {
    const exact = this.spawnText.indexOf(para, this.emitCursor);
    if (exact !== -1) return exact;
    // The buffer normalizes 3+ newlines inside a held fence to two; find the
    // paragraph by its head instead.
    const head = this.spawnText.indexOf(para.slice(0, 40), this.emitCursor);
    return head !== -1 ? head : this.emitCursor;
  }

  private emitAll(paragraphs: string[]): StreamedLine[] {
    const lines: StreamedLine[] = [];
    for (const para of paragraphs) {
      if (this.muted) break;
      const start = this.locate(para);
      const end = start + para.length;
      // Judged against the whole spawn so far: fence context and line
      // boundaries are the message's, not this paragraph's.
      const frame = this.options.guard?.(this.spawnText) ?? null;
      let text = para;
      if (frame && frame.index <= start) {
        this.muted = true;
        break;
      }
      if (frame && frame.index < end) {
        // The prefix is the model's own words (a fence, a sentence); from the
        // frame on it is the runtime's voice, faked. Nothing after it renders.
        text = this.spawnText.slice(start, frame.index).trimEnd();
        this.muted = true;
      }
      this.emitCursor = end;
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
