/**
 * The observer-facing text preview, guarded the way the screen is.
 *
 * `backend_text` ledger entries carry a preview of each completed text block
 * and are mirrored live to observers. Under local tool routing the loop
 * discards everything from an imitated results frame on, so the preview must
 * too — and a frame can be split across text blocks, so a trailing line that
 * could still become one is HELD, not published and not dropped: it rides
 * into the next block's preview, or is released when the spawn ends and it
 * turned out to be ordinary text (Lumen, PR #575 round 3 — a one-way
 * deletion lost legitimate lines that merely ended in `Tool`).
 *
 * Pure and host-independent so the projection can be exercised at every
 * split point of every header the detector accepts.
 */
export interface PreviewGuardFrame {
  index: number;
}

export class ImitationPreviewGuard {
  private spawnText = '';
  /** A trailing line held back from the last block, in spawn coordinates. */
  private pendingStart: number | null = null;
  private cut = false;

  constructor(
    private readonly detect: (text: string) => PreviewGuardFrame | null,
    private readonly isPotentialPrefix: (line: string) => boolean
  ) {}

  /** A new backend spawn began: nothing from the previous one carries over. */
  beginSpawn(): void {
    this.spawnText = '';
    this.pendingStart = null;
    this.cut = false;
  }

  /**
   * A text block completed. Returns what may be published for it now — the
   * held tail of the previous block included — whether a frame was found
   * (from this block on, nothing more is published this spawn), and how many
   * characters of THIS block precede the cut (`blockKeep`: the block's own
   * length when there is no frame), for a host that also records the block.
   */
  onBlock(text: string): { publish: string; imitationDiscarded: boolean; blockKeep: number } {
    if (this.cut) return { publish: '', imitationDiscarded: true, blockKeep: 0 };
    const blockStart = this.spawnText.length;
    this.spawnText += text;
    const from = this.pendingStart ?? blockStart;
    const frame = this.detect(this.spawnText);
    if (frame) {
      this.cut = true;
      this.pendingStart = null;
      return {
        publish: frame.index > from ? this.spawnText.slice(from, frame.index) : '',
        imitationDiscarded: true,
        blockKeep: Math.max(0, frame.index - blockStart),
      };
    }
    const blockKeep = text.length;
    const lastLineStart = this.spawnText.lastIndexOf('\n', this.spawnText.length - 1) + 1;
    const tail = this.spawnText.slice(Math.max(lastLineStart, from));
    if (lastLineStart >= from && this.isPotentialPrefix(tail)) {
      this.pendingStart = lastLineStart;
      return {
        publish: this.spawnText.slice(from, lastLineStart),
        imitationDiscarded: false,
        blockKeep,
      };
    }
    if (lastLineStart < from && this.isPotentialPrefix(this.spawnText.slice(from))) {
      // The whole publishable range is one line that could still be a header.
      this.pendingStart = from;
      return { publish: '', imitationDiscarded: false, blockKeep };
    }
    this.pendingStart = null;
    return { publish: this.spawnText.slice(from), imitationDiscarded: false, blockKeep };
  }

  /** The spawn ended: a held line that never became a frame is ordinary text. */
  endSpawn(): string {
    const held = this.pendingStart !== null ? this.spawnText.slice(this.pendingStart) : '';
    this.pendingStart = null;
    return this.cut ? '' : held;
  }
}
