/**
 * Turning a fetched body into text an agent can read.
 *
 * Ported from OpenClaw (MIT License, Copyright (c) 2025 Peter Steinberger),
 * src/agents/tools/web-fetch-utils.ts, web-fetch-visibility.ts and the charset
 * handling in web-shared.ts at f88e1f4c1c: which elements count as hidden
 * (the hidden attribute, aria-hidden, hidden classes and styles), the markdown
 * shapes for headings, links and list items, the invisible-Unicode strip, and
 * charset detection from the header, a byte-order mark or a meta tag.
 *
 * The structure differs. OpenClaw strips hidden elements with a tag scanner
 * and then converts with regular expressions; two of those expressions
 * (`<a…>[\s\S]*?</a>` and `[ \t]+\n`) take quadratic time on a page built to
 * defeat them, and this server is one thread. Here a single scan does both
 * jobs and every step is linear in the page. OpenClaw's Readability pass and
 * its provider fallbacks are not ported; a page is read by the scan alone.
 */

export type ExtractMode = 'markdown' | 'text';

export interface ExtractedContent {
  text: string;
  title?: string;
  /** How the body was read: html, markdown, json, or text (as it came). */
  extractor: 'html' | 'markdown' | 'json' | 'text';
}

// ============== Charset ==============

const CHARSET_SCAN_BYTES = 4096;
const latin1 = new TextDecoder('latin1');

function normalizeCharset(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^["']|["']$/g, '') ?? '';
  return normalized && normalized.length <= 64 && /^[A-Za-z0-9._:-]+$/.test(normalized)
    ? normalized
    : undefined;
}

function charsetParam(contentType: string | undefined): string | undefined {
  const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(
    contentType ?? ''
  );
  return normalizeCharset(match?.[1] ?? match?.[2] ?? match?.[3]);
}

function metaAttribute(tag: string, name: string): string | undefined {
  for (const match of tag.matchAll(
    /([A-Za-z0-9:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  )) {
    if (match[1]?.toLowerCase() === name) return match[2] ?? match[3] ?? match[4] ?? '';
  }
  return undefined;
}

function sniffCharset(mediaType: string, bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  const markup =
    mediaType === '' ||
    mediaType === 'text/html' ||
    mediaType === 'application/xhtml+xml' ||
    mediaType.endsWith('/xml') ||
    mediaType.endsWith('+xml');
  if (!markup) return undefined;
  // A bounded head, so these expressions never see more than 4KB.
  const head = latin1.decode(bytes.subarray(0, Math.min(bytes.byteLength, CHARSET_SCAN_BYTES)));
  const xml = /<\?xml\s+[^>]*\bencoding\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(head);
  if (xml) return normalizeCharset(xml[1] ?? xml[2]);
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const charset = normalizeCharset(metaAttribute(match[0], 'charset'));
    if (charset) return charset;
    if (/^content-type$/i.test(metaAttribute(match[0], 'http-equiv') ?? '')) {
      const fromContent = charsetParam(metaAttribute(match[0], 'content'));
      if (fromContent) return fromContent;
    }
  }
  return undefined;
}

/** The media type alone, lowercased: "text/html; charset=…" → "text/html". */
export function mediaTypeOf(contentType: string | undefined): string {
  return (contentType ?? '').split(';', 1)[0].trim().toLowerCase();
}

/** Decode a body by its declared or sniffed charset, UTF-8 when neither works. */
export function decodeBody(bytes: Uint8Array, contentType: string | undefined): string {
  const charset = charsetParam(contentType) ?? sniffCharset(mediaTypeOf(contentType), bytes);
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// ============== Text cleanup ==============

/** Zero-width and invisible characters, a known prompt-injection carrier. */
const INVISIBLE_UNICODE =
  /[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{206A}-\u{206F}\u{FEFF}\u{E0000}-\u{E007F}]/gu;

export function stripInvisibleUnicode(text: string): string {
  return text.replace(INVISIBLE_UNICODE, '');
}

/**
 * Collapse runs of spaces and tabs, trim line ends, keep at most one blank
 * line. Line by line, because `[ \t]+\n` over the whole text backtracks
 * quadratically through a long run of spaces with no newline after it.
 */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
};

function fromCodePoint(codePoint: number): string {
  const valid =
    Number.isInteger(codePoint) &&
    codePoint > 0 &&
    codePoint <= 0x10ffff &&
    !(codePoint >= 0xd800 && codePoint <= 0xdfff);
  return valid ? String.fromCodePoint(codePoint) : '\u{FFFD}';
}

/** One pass, so "&amp;lt;" decodes to "&lt;" and not on to "<". */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,10}|[a-zA-Z]{2,8});/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      return fromCodePoint(parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// ============== Hidden elements (OpenClaw's visibility rules) ==============

const HIDDEN_STYLE_PATTERNS: Array<[string, RegExp]> = [
  ['display', /^\s*none\s*$/i],
  ['visibility', /^\s*hidden\s*$/i],
  ['opacity', /^\s*0\s*$/],
  ['font-size', /^\s*0(px|em|rem|pt|%)?\s*$/i],
  ['text-indent', /^\s*-\d{4,}px\s*$/],
  ['color', /^\s*transparent\s*$/i],
  ['color', /^\s*rgba\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)\s*$/i],
  ['color', /^\s*hsla\s*\(\s*[\d.]+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*0(?:\.0+)?\s*\)\s*$/i],
];

const HIDDEN_CLASS_NAMES = new Set([
  'sr-only',
  'visually-hidden',
  'd-none',
  'hidden',
  'invisible',
  'screen-reader-only',
  'offscreen',
]);

/** Elements dropped with everything inside them. */
const DROPPED_ELEMENTS = new Set([
  'meta',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
]);

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** One compiled pattern per name: a tag is checked against several, and a page has many tags. */
function cachedPattern(cache: Map<string, RegExp>, key: string, build: () => RegExp): RegExp {
  let pattern = cache.get(key);
  if (!pattern) {
    pattern = build();
    cache.set(key, pattern);
  }
  return pattern;
}

const stylePatterns = new Map<string, RegExp>();

function styleProperty(style: string, property: string): string | undefined {
  const pattern = cachedPattern(
    stylePatterns,
    property,
    () => new RegExp(`(?:^|;)\\s*${property.replace(/-/g, '\\-')}\\s*:\\s*([^;]+)`, 'i')
  );
  return style.match(pattern)?.[1];
}

function isStyleHidden(style: string): boolean {
  for (const [property, pattern] of HIDDEN_STYLE_PATTERNS) {
    const value = styleProperty(style, property);
    if (value !== undefined && pattern.test(value)) return true;
  }
  const clipPath = styleProperty(style, 'clip-path');
  if (
    clipPath &&
    !/^\s*none\s*$/i.test(clipPath) &&
    /inset\s*\(\s*(?:0*\.\d+|[1-9]\d*(?:\.\d+)?)%/i.test(clipPath)
  ) {
    return true;
  }
  const transform = styleProperty(style, 'transform');
  if (
    transform &&
    (/scale\s*\(\s*0\s*\)/i.test(transform) ||
      /translate[XY]\s*\(\s*-\d{4,}px\s*\)/i.test(transform))
  ) {
    return true;
  }
  const width = styleProperty(style, 'width');
  const height = styleProperty(style, 'height');
  const overflow = styleProperty(style, 'overflow');
  if (
    width !== undefined &&
    /^\s*0(px)?\s*$/i.test(width) &&
    height !== undefined &&
    /^\s*0(px)?\s*$/i.test(height) &&
    overflow !== undefined &&
    /^\s*hidden\s*$/i.test(overflow)
  ) {
    return true;
  }
  const left = styleProperty(style, 'left');
  const top = styleProperty(style, 'top');
  return (
    (left !== undefined && /^\s*-\d{4,}px\s*$/i.test(left)) ||
    (top !== undefined && /^\s*-\d{4,}px\s*$/i.test(top))
  );
}

/** `name`'s value in a tag's attribute text; "" for a bare attribute, undefined if absent. */
const attributePatterns = new Map<string, RegExp>();

function readAttribute(attrs: string, name: string): string | undefined {
  const pattern = cachedPattern(
    attributePatterns,
    name,
    () =>
      new RegExp(
        `(?:^|\\s)${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))|(?=\\s|/|$))`,
        'i'
      )
  );
  const match = attrs.match(pattern);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3] ?? '';
}

function isHiddenElement(tagName: string, attrs: string): boolean {
  if (DROPPED_ELEMENTS.has(tagName)) return true;
  if (tagName === 'input' && readAttribute(attrs, 'type')?.trim().toLowerCase() === 'hidden') {
    return true;
  }
  if (readAttribute(attrs, 'aria-hidden')?.trim().toLowerCase() === 'true') return true;
  if (readAttribute(attrs, 'hidden') !== undefined) return true;
  const classes = (readAttribute(attrs, 'class') ?? '').toLowerCase().split(/\s+/);
  if (classes.some((name) => HIDDEN_CLASS_NAMES.has(name))) return true;
  const style = readAttribute(attrs, 'style');
  return !!style && isStyleHidden(style);
}

// ============== The scan ==============

/**
 * Elements whose content is text, not markup, up to their own end tag. Their
 * content is skipped (or, for title, kept as the title) without being read as
 * tags, so a "</div>" inside a script can't end anything.
 */
const RAW_TEXT_ELEMENTS = new Set([
  'script',
  'style',
  'title',
  'textarea',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
]);

const BLOCK_ELEMENTS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'aside',
  'main',
  'table',
  'tr',
  'ul',
  'ol',
  'blockquote',
  'figure',
  'figcaption',
  'dl',
  'dt',
  'dd',
  'form',
  'fieldset',
  'details',
  'summary',
  'address',
]);

const rawTextEnds = new Map<string, RegExp>();

/** Global, so exec searches from lastIndex, which every caller sets first. */
function rawTextEnd(tagName: string): RegExp {
  return cachedPattern(rawTextEnds, tagName, () => new RegExp(`</${tagName}(?=[\\s/>])`, 'gi'));
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** The index of the ">" that ends the tag starting at `start`, quote-aware; -1 if none. */
function findTagEnd(html: string, start: number): number {
  let quote: string | undefined;
  for (let index = start + 1; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return -1;
}

interface Tag {
  name: string;
  attrs: string;
  closing: boolean;
  selfClosing: boolean;
}

function parseTag(inner: string): Tag | null {
  const closing = inner.startsWith('/');
  const body = closing ? inner.slice(1) : inner;
  const match = /^[A-Za-z][A-Za-z0-9:_-]*/.exec(body);
  if (!match) return null;
  const attrs = closing ? '' : body.slice(match[0].length);
  return {
    name: match[0].toLowerCase(),
    attrs,
    closing,
    selfClosing: !closing && attrs.trimEnd().endsWith('/'),
  };
}

const FENCE = '```';

/**
 * The scan's output, tidied: spaces collapsed and lines trimmed, except
 * inside a fence the scan opened for a <pre>, where lines keep their
 * indentation. At most one blank line anywhere.
 */
function tidyScanned(text: string): string {
  let inFence = false;
  const lines = text.split('\n').map((line) => {
    if (line.trim() === FENCE) {
      inFence = !inFence;
      return FENCE;
    }
    return inFence ? line.trimEnd() : line.replace(/[ \t]+/g, ' ').trim();
  });
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * HTML to markdown (or plain text), in one linear pass: hidden elements and
 * scripts dropped, headings, links, list items and preformatted blocks marked
 * in markdown mode, entities decoded. Outside <pre>, a run of whitespace in
 * the source is one space, as a browser renders it; line breaks come from the
 * elements alone.
 */
export function htmlToReadable(html: string, mode: ExtractMode): { text: string; title?: string } {
  const markdown = mode === 'markdown';
  const parts: string[] = [];
  // Open elements inside a hidden one, and how many of each name are open.
  // The count lets a close tag for a name that isn't open skip the search:
  // without it, 50k hidden opens and 50k unmatched closes are 2.5 billion
  // steps. With it, a search only covers elements it then removes.
  const dropStack: string[] = [];
  const dropCounts = new Map<string, number>();
  const pushDropped = (name: string) => {
    dropStack.push(name);
    dropCounts.set(name, (dropCounts.get(name) ?? 0) + 1);
  };
  const closeDropped = (name: string) => {
    if (!dropCounts.get(name)) return;
    for (const removed of dropStack.splice(dropStack.lastIndexOf(name))) {
      dropCounts.set(removed, (dropCounts.get(removed) ?? 1) - 1);
    }
  };
  let title: string | undefined;
  let link: { href: string; start: number } | null = null;
  let preDepth = 0;

  const emit = (text: string) => {
    if (dropStack.length === 0 && text) parts.push(text);
  };
  const emitText = (raw: string) => {
    emit(decodeEntities(preDepth > 0 ? raw.replace(/\r/g, '') : raw.replace(/[ \t\n\r\f]+/g, ' ')));
  };
  const closeLink = () => {
    if (!link) return;
    const label = parts.splice(link.start).join('').replace(/\s+/g, ' ').trim();
    const { href } = link;
    link = null;
    if (!markdown) emit(label);
    else emit(label ? `[${label}](${href})` : href);
  };

  let cursor = 0;
  const length = html.length;
  while (cursor < length) {
    const open = html.indexOf('<', cursor);
    if (open < 0) {
      emitText(html.slice(cursor));
      break;
    }
    if (open > cursor) emitText(html.slice(cursor, open));

    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      cursor = end < 0 ? length : end + 3;
      continue;
    }
    const next = html.charCodeAt(open + 1);
    if (next === 33 /* ! */ || next === 63 /* ? */) {
      const end = html.indexOf('>', open + 2);
      cursor = end < 0 ? length : end + 1;
      continue;
    }
    const startsTag =
      isAsciiLetter(next) || (next === 47 /* / */ && isAsciiLetter(html.charCodeAt(open + 2)));
    if (!startsTag) {
      emit('<');
      cursor = open + 1;
      continue;
    }
    const end = findTagEnd(html, open);
    if (end < 0) break; // An unterminated tag at the end is dropped, as a browser does.
    cursor = end + 1;
    const tag = parseTag(html.slice(open + 1, end));
    if (!tag) continue;

    if (!tag.closing && RAW_TEXT_ELEMENTS.has(tag.name)) {
      const ending = rawTextEnd(tag.name);
      ending.lastIndex = cursor;
      const found = ending.exec(html);
      const contentEnd = found ? found.index : length;
      if (tag.name === 'title' && title === undefined && dropStack.length === 0) {
        title = normalizeWhitespace(decodeEntities(html.slice(cursor, contentEnd))) || undefined;
      } else if (tag.name === 'textarea' && !isHiddenElement(tag.name, tag.attrs)) {
        emitText(html.slice(cursor, contentEnd));
      }
      const close = found ? html.indexOf('>', found.index) : -1;
      cursor = close < 0 ? length : close + 1;
      continue;
    }

    if (dropStack.length > 0) {
      if (tag.closing) closeDropped(tag.name);
      else if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.name)) pushDropped(tag.name);
      continue;
    }

    if (!tag.closing && isHiddenElement(tag.name, tag.attrs)) {
      if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.name)) pushDropped(tag.name);
      continue;
    }

    const heading = /^h([1-6])$/.exec(tag.name);
    if (tag.name === 'a') {
      closeLink();
      if (!tag.closing) {
        const href = readAttribute(tag.attrs, 'href');
        if (href) link = { href: decodeEntities(href).trim(), start: parts.length };
      }
    } else if (heading) {
      if (tag.closing || !markdown) emit('\n\n');
      else emit(`\n\n${'#'.repeat(Number(heading[1]))} `);
    } else if (tag.name === 'li') {
      // The next item, or the list's own end, breaks the line.
      if (!tag.closing) emit(markdown ? '\n- ' : '\n');
    } else if (tag.name === 'br' || tag.name === 'hr') {
      emit('\n');
    } else if (tag.name === 'td' || tag.name === 'th') {
      emit(' ');
    } else if (tag.name === 'pre') {
      if (tag.closing && preDepth === 0) continue;
      preDepth += tag.closing ? -1 : 1;
      // Only the outermost <pre> is fenced.
      const outermost = tag.closing ? preDepth === 0 : preDepth === 1;
      emit(markdown && outermost ? `\n${FENCE}\n` : '\n');
    } else if (BLOCK_ELEMENTS.has(tag.name)) {
      emit('\n');
    }
  }
  closeLink();
  if (markdown && preDepth > 0) emit(`\n${FENCE}\n`);

  return { text: tidyScanned(stripInvisibleUnicode(parts.join(''))), title };
}

// ============== By content type ==============

function prettyJson(body: string): string | null {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return null;
  }
}

/** Read a decoded body by its media type. */
export function extractContent(
  body: string,
  contentType: string | undefined,
  mode: ExtractMode
): ExtractedContent {
  const mediaType = mediaTypeOf(contentType);
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
    const { text, title } = htmlToReadable(body, mode);
    return { text, title, extractor: 'html' };
  }
  if (mediaType === 'text/markdown') {
    return { text: stripInvisibleUnicode(body), extractor: 'markdown' };
  }
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
    const pretty = prettyJson(body);
    return { text: stripInvisibleUnicode(pretty ?? body), extractor: pretty ? 'json' : 'text' };
  }
  return { text: stripInvisibleUnicode(body), extractor: 'text' };
}

/** Media types read as text. Anything else (images, PDFs, archives) is refused. */
export function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType === '' ||
    mediaType.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType.endsWith('+json') ||
    mediaType === 'application/xml' ||
    mediaType.endsWith('+xml') ||
    mediaType === 'application/javascript' ||
    mediaType === 'application/x-javascript' ||
    mediaType === 'application/ecmascript'
  );
}
