interface LegacyToolBlock {
  start: number;
  end: number;
  payloadStart: number;
  payloadEnd: number;
}

/**
 * The deprecated tool_call spelling: first opener through the first closer,
 * case-insensitively. Each search advances past the previous pair. An opener
 * without a closer ends the scan, rather than retrying the suffix for every
 * later opener (the old lazy regex was quadratic on model-controlled text).
 */
export function findLegacyToolBlocks(text: string): LegacyToolBlock[] {
  const blocks: LegacyToolBlock[] = [];
  const opening = /<tool_call>/gi;
  const closing = /<\/tool_call>/gi;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(text)) !== null) {
    closing.lastIndex = opening.lastIndex;
    const close = closing.exec(text);
    if (!close) break;
    blocks.push({
      start: match.index,
      end: closing.lastIndex,
      payloadStart: opening.lastIndex,
      payloadEnd: close.index,
    });
    opening.lastIndex = closing.lastIndex;
  }
  return blocks;
}

export function stripLegacyToolBlocks(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const block of findLegacyToolBlocks(text)) {
    parts.push(text.slice(cursor, block.start));
    cursor = block.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}
