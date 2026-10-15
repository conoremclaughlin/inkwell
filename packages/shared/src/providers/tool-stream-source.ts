import type { BackendRunResult } from './backend-runner.js';
import type { BackendMessageSource, BackendTextSource, BackendTurnEvent } from './stream.js';

interface TextBlock {
  text: string;
  complete: boolean;
}

/**
 * Correlates ONE parent message inside a fresh host-owned attempt. Provider
 * IDs never replace the journal's owner/turn/attempt/invocation identities.
 * Keep the second-parent-message refusal until attempt-wide multi-message
 * admission (including imitation and exclusivity) is implemented separately.
 */
export class ToolStreamSource {
  text = '';
  private messageId: string | undefined;
  private ended = false;
  private blocks = new Map<string, TextBlock>();
  private lastBlock: TextBlock | undefined;

  /** Returns only fresh, positioned parent text. Throws before an ambiguous append. */
  consume(event: BackendTurnEvent): string {
    if (event.kind !== 'text' && event.kind !== 'text-delta' && event.kind !== 'text-boundary')
      return '';
    // Child output still reaches display; it cannot contribute bytes, boundaries
    // or finality to the parent's local-tool source, even if IDs collide.
    if (event.source?.origin === 'child') return '';
    this.parent(event.source);
    if (event.kind === 'text-boundary') {
      if (event.boundary === 'message-end') {
        if (event.complete !== true)
          throw new Error('Parent message ended without normal completion.');
        this.ended = true;
      } else if (event.boundary === 'block-start' && event.text !== undefined) {
        return this.position({ ...event.source, offset: 0 }, event.text, false);
      } else if (event.boundary === 'block-end') {
        const block = this.blocks.get(this.blockId(event.source.blockId));
        // Non-text blocks also have boundaries, but no bytes in this source.
        if (block) block.complete = true;
      }
      return '';
    }
    return this.position(event.source!, event.text, event.kind === 'text');
  }

  /**
   * A successful final confirms exactly one observed message. It is not a
   * positioned block and cannot append unseen text or authorize raw stdout.
   * The adapter's block snapshots repair missing deltas before this boundary.
   */
  confirm(result: BackendRunResult): void {
    if (this.messageId === undefined)
      throw new Error('Provider final has no observed parent message.');
    this.parent(result.responseSource);
    if (typeof result.responseText !== 'string' || result.responseText !== this.text)
      throw new Error('Provider final does not confirm the observed parent text.');
  }

  private parent(source: BackendMessageSource | undefined): void {
    if (
      source?.origin !== 'parent' ||
      source.parentToolUseId !== undefined ||
      typeof source.messageId !== 'string' ||
      !source.messageId
    )
      throw new Error('Provider text lacks unambiguous parent message provenance.');
    if (this.messageId !== undefined && this.messageId !== source.messageId)
      throw new Error('Multiple assistant messages in one local-tool attempt are not supported.');
    this.messageId = source.messageId;
  }

  private blockId(id: string | undefined): string {
    if (typeof id !== 'string' || !id) throw new Error('Provider text lacks a block identity.');
    return id;
  }

  private position(
    source: BackendMessageSource & Partial<Pick<BackendTextSource, 'blockId' | 'offset'>>,
    text: string,
    snapshot: boolean
  ): string {
    const id = this.blockId(source.blockId);
    const offset = source.offset;
    if (
      offset === undefined ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (snapshot && offset !== 0)
    )
      throw new Error('Provider text has an invalid block position.');
    let block = this.blocks.get(id);
    if (!block) {
      if (this.ended || (this.lastBlock && !this.lastBlock.complete))
        throw new Error(
          'Provider text opened a block after message end or before the previous block completed.'
        );
      block = { text: '', complete: false };
      this.blocks.set(id, block);
      this.lastBlock = block;
    }
    if (offset > block.text.length)
      throw new Error('Provider text has a gap in its positioned prefix.');
    const overlap = Math.min(text.length, block.text.length - offset);
    if (
      block.text.slice(offset, offset + overlap) !== text.slice(0, overlap) ||
      (snapshot && text.length < block.text.length)
    )
      throw new Error('Provider text changed an already streamed prefix.');
    const suffix = text.slice(overlap);
    if (suffix && (this.ended || block.complete || block !== this.lastBlock))
      throw new Error('Provider text extended a completed or earlier block.');
    block.text += suffix;
    if (snapshot) block.complete = true;
    this.text += suffix;
    return suffix;
  }
}
