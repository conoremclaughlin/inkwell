import { fenceAfterLine, type OpenFence } from './imitation-grammar.js';

export interface InvokeToolBlock {
  start: number;
  end: number;
  tool?: string;
  closed: boolean;
}

/**
 * Native-looking XML emitted as text is not an ink tool call. Recognize it
 * only to report the protocol error and keep controls out of replies; never
 * interpret its parameters or execute it. Fenced examples remain prose.
 */
export function findInvokeToolBlocks(text: string): InvokeToolBlock[] {
  const blocks: InvokeToolBlock[] = [];
  let fence: OpenFence | null = null;
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset);
    const lineEnd = newline < 0 ? text.length : newline + 1;
    const line = text.slice(offset, lineEnd);
    const opener =
      !fence && /^[ \t]{0,3}<((?:antml:)?(?:invoke|function_calls))\b[^>]*>/i.exec(line);
    if (opener) {
      const tag = opener[1];
      const closing = new RegExp(`</${tag}\\s*>`, 'ig');
      closing.lastIndex = offset + opener[0].length;
      const match = closing.exec(text);
      const end = match ? closing.lastIndex : text.length;
      const body = text.slice(offset, end);
      const name = /<(?:antml:)?invoke\b[^>]*\bname=["']([A-Za-z_][\w.-]*)["']/i.exec(body)?.[1];
      blocks.push({
        start: offset,
        end,
        closed: Boolean(match),
        ...(name ? { tool: name.replace(/^mcp__inkwell__/, '') } : {}),
      });
      offset = end;
    } else {
      fence = fenceAfterLine(fence, line.replace(/\r?\n$/, ''));
      offset = lineEnd;
    }
  }
  return blocks;
}

export function stripInvokeToolBlocks(text: string): string {
  let out = '';
  let start = 0;
  for (const block of findInvokeToolBlocks(text)) {
    out += text.slice(start, block.start);
    start = block.end;
  }
  return out + text.slice(start);
}
