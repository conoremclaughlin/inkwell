/**
 * A message body's markdown, parsed into a small tree any renderer can draw:
 * React Native views on the phone, a terminal's styled text, anything that is
 * not a browser. (The web page hands markdown to react-markdown, which does
 * its own parsing for the DOM.)
 *
 * GitHub-flavoured, with a single newline kept as a line break, because SBs
 * and people write messages the way they write chat, not documents. Raw HTML
 * is shown as the text it is, never interpreted. A link keeps its target
 * only when it is http(s) or mailto; anything else reads as plain text.
 */

import { getDefaults, Lexer, type MarkedOptions, type Token, type Tokens } from 'marked';

export type MarkdownInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong' | 'em' | 'del'; children: MarkdownInline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: MarkdownInline[] }
  | { kind: 'break' };

export interface MarkdownListItem {
  /** A task list's checkbox: true or false. Null for an ordinary item. */
  checked: boolean | null;
  blocks: MarkdownBlock[];
}

export type MarkdownAlign = 'left' | 'center' | 'right' | null;

export type MarkdownBlock =
  | { kind: 'paragraph'; inline: MarkdownInline[] }
  | { kind: 'heading'; depth: number; inline: MarkdownInline[] }
  | { kind: 'code'; lang: string | null; text: string }
  | { kind: 'quote'; blocks: MarkdownBlock[] }
  | { kind: 'list'; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { kind: 'rule' }
  | {
      kind: 'table';
      align: MarkdownAlign[];
      header: MarkdownInline[][];
      rows: MarkdownInline[][][];
    };

const SAFE_LINK = /^(https?:|mailto:)/i;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** `&amp;` → `&`, `&#39;` → `'`: what a browser would show for the source text. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
  });
}

/** Adjacent text runs joined, so a renderer draws one span rather than several. */
function mergeText(nodes: MarkdownInline[]): MarkdownInline[] {
  const merged: MarkdownInline[] = [];
  for (const node of nodes) {
    const last = merged[merged.length - 1];
    if (node.kind === 'text' && last?.kind === 'text') {
      merged[merged.length - 1] = { kind: 'text', text: last.text + node.text };
    } else {
      merged.push(node);
    }
  }
  return merged;
}

function inlineOf(tokens: Token[] | undefined): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'text': {
        const text = token as Tokens.Text;
        // A text token inside a list item can carry its own inline tokens.
        if (text.tokens?.length) nodes.push(...inlineOf(text.tokens));
        else nodes.push({ kind: 'text', text: decodeEntities(text.text) });
        break;
      }
      case 'escape':
        nodes.push({ kind: 'text', text: (token as Tokens.Escape).text });
        break;
      case 'strong':
      case 'em':
      case 'del':
        nodes.push({
          kind: token.type,
          children: inlineOf((token as Tokens.Strong | Tokens.Em | Tokens.Del).tokens),
        });
        break;
      case 'codespan':
        // Code is literal: `&amp;` in backticks is those five characters, as
        // the web page shows it. The lexer hands it over untouched.
        nodes.push({ kind: 'code', text: (token as Tokens.Codespan).text });
        break;
      case 'br':
        nodes.push({ kind: 'break' });
        break;
      case 'link':
      case 'image': {
        const link = token as Tokens.Link | Tokens.Image;
        // The destination as a browser would read it: `?a=1&amp;b=2` is
        // `?a=1&b=2`. Decoded BEFORE the scheme check, so an encoded
        // `javascript&#58;` is judged as what it spells.
        const href = decodeEntities(link.href).trim();
        const children = inlineOf(link.tokens);
        const label = children.length ? children : [{ kind: 'text' as const, text: href }];
        if (SAFE_LINK.test(href)) nodes.push({ kind: 'link', href, children: label });
        else nodes.push(...label);
        break;
      }
      case 'html':
        nodes.push({ kind: 'text', text: (token as Tokens.HTML).text });
        break;
      default:
        if ('text' in token && typeof token.text === 'string') {
          nodes.push({ kind: 'text', text: decodeEntities(token.text) });
        }
    }
  }
  return mergeText(nodes);
}

function blocksOf(tokens: Token[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'paragraph':
        blocks.push({ kind: 'paragraph', inline: inlineOf((token as Tokens.Paragraph).tokens) });
        break;
      case 'text': {
        // A tight list item's content: a paragraph by another name.
        const text = token as Tokens.Text;
        blocks.push({
          kind: 'paragraph',
          inline: text.tokens?.length
            ? inlineOf(text.tokens)
            : [{ kind: 'text', text: decodeEntities(text.text) }],
        });
        break;
      }
      case 'heading': {
        const heading = token as Tokens.Heading;
        blocks.push({ kind: 'heading', depth: heading.depth, inline: inlineOf(heading.tokens) });
        break;
      }
      case 'code': {
        const code = token as Tokens.Code;
        blocks.push({ kind: 'code', lang: code.lang?.trim() || null, text: code.text });
        break;
      }
      case 'blockquote':
        blocks.push({ kind: 'quote', blocks: blocksOf((token as Tokens.Blockquote).tokens) });
        break;
      case 'list': {
        const list = token as Tokens.List;
        const start = typeof list.start === 'number' ? list.start : 1;
        blocks.push({
          kind: 'list',
          ordered: list.ordered,
          start,
          items: list.items.map((item) => ({
            checked: item.task ? Boolean(item.checked) : null,
            blocks: blocksOf(item.tokens),
          })),
        });
        break;
      }
      case 'hr':
        blocks.push({ kind: 'rule' });
        break;
      case 'table': {
        const table = token as Tokens.Table;
        blocks.push({
          kind: 'table',
          align: table.align,
          header: table.header.map((cell) => inlineOf(cell.tokens)),
          rows: table.rows.map((row) => row.map((cell) => inlineOf(cell.tokens))),
        });
        break;
      }
      case 'html': {
        const text = (token as Tokens.HTML).text.trim();
        if (text) blocks.push({ kind: 'paragraph', inline: [{ kind: 'text', text }] });
        break;
      }
      // 'space' separates blocks, which the renderer already spaces; 'def'
      // is a link reference definition, already resolved into its links.
      default:
        break;
    }
  }
  return blocks;
}

/** marked's defaults, with GitHub's extensions and chat-style line breaks. */
const LEXER_OPTIONS: MarkedOptions = { ...getDefaults(), gfm: true, breaks: true };

export function parseMarkdown(body: string): MarkdownBlock[] {
  return blocksOf(Lexer.lex(body, LEXER_OPTIONS));
}

/** The text a tree reads as, formatting dropped: for accessibility labels and search. */
export function plainTextOf(nodes: MarkdownInline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
        case 'code':
          return node.text;
        case 'break':
          return '\n';
        default:
          return plainTextOf(node.children);
      }
    })
    .join('');
}

/**
 * Each column's widest cell, in characters, header included. A table lines
 * up only when every row gives a column the same width, so a renderer sizes
 * each column from this rather than letting each row size its own cells:
 * characters for a terminal, points on a phone (Lumen, #679).
 */
export function tableColumnChars(table: Extract<MarkdownBlock, { kind: 'table' }>): number[] {
  const widths = table.header.map((cell) => plainTextOf(cell).length);
  for (const row of table.rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, plainTextOf(cell).length);
    });
  }
  return widths;
}
