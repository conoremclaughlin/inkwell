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
