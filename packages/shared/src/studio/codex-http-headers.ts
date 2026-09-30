/**
 * The static header NAMES a Codex config sets under `mcp_servers.<name>.http_headers`,
 * read without a TOML dependency, for the studio checklist.
 *
 * This is a repair trigger, not enforcement. It decides whether a studio is
 * sent to `ink mcp sync`. What a spawn actually refuses is judged on Codex's
 * own parser, through `codex mcp list --json` (providers/codex-mcp-list.ts).
 * So it reads exactly three forms, and reports anything else that touches
 * `http_headers` inside an `[mcp_servers.*]` scope as unreadable, never as
 * clean (Myra, #701 4d55a16d):
 *
 * - an inline table: `http_headers = { "X-A" = "v", b = "v" }`;
 * - a sub-table: `[mcp_servers.x.http_headers]`, then `X-A = "v"` lines;
 * - dotted keys: `http_headers."X-A" = "v"`, from the server's table or any
 *   table above it.
 *
 * Keys may be bare, "basic" or 'literal', and comments may sit anywhere
 * outside a string. Only `http_headers` counts; `env_http_headers` draws a
 * value from the spawn's env and is not a baked one.
 */

export interface CodexStaticHeaderNames {
  /** Header names as written, in file order. */
  names: string[];
  /** Whether an `http_headers` form in an `[mcp_servers.*]` scope could not be read. */
  unreadable: boolean;
}

const BARE_KEY = /^[A-Za-z0-9_-]+/;

/** A key segment at the start of `text`: its name and the rest, or undefined. */
function readKeySegment(text: string): { name: string; rest: string } | undefined {
  const trimmed = text.trimStart();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    let name = '';
    for (let i = 1; i < trimmed.length; i += 1) {
      const ch = trimmed[i]!;
      if (ch === quote) return { name, rest: trimmed.slice(i + 1) };
      if (quote === '"' && ch === '\\') {
        // An escape in a basic key; the checklist only compares names, so an
        // escaped character is kept as written after the backslash.
        i += 1;
        name += trimmed[i] ?? '';
      } else {
        name += ch;
      }
    }
    return undefined;
  }
  const bare = BARE_KEY.exec(trimmed);
  return bare ? { name: bare[0], rest: trimmed.slice(bare[0].length) } : undefined;
}

/** A dotted key at the start of `text`, and what follows it. */
function readDottedKey(text: string): { path: string[]; rest: string } | undefined {
  const path: string[] = [];
  let rest = text;
  for (;;) {
    const segment = readKeySegment(rest);
    if (!segment) return undefined;
    path.push(segment.name);
    rest = segment.rest.trimStart();
    if (!rest.startsWith('.')) return { path, rest };
    rest = rest.slice(1);
  }
}

/** `line` without a `#` comment outside strings. Undefined when a string never closes. */
function withoutComment(line: string): string | undefined {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (quote === '"' && ch === '\\') i += 1;
      else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return quote ? undefined : line;
}

/** The keys of a one-line inline table, `{ k = v, ... }`, or undefined. */
function readInlineTableKeys(value: string): string[] | undefined {
  const body = value.trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return undefined;
  const keys: string[] = [];
  let rest = body.slice(1, -1).trim();
  while (rest.length > 0) {
    const key = readDottedKey(rest);
    if (!key || key.path.length !== 1 || !key.rest.startsWith('=')) return undefined;
    keys.push(key.path[0]!);
    // Skip the value: a string, or anything up to the next top-level comma.
    rest = key.rest.slice(1).trimStart();
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      let end = 1;
      while (end < rest.length && rest[end] !== quote)
        end += rest[end] === '\\' && quote === '"' ? 2 : 1;
      if (end >= rest.length) return undefined;
      rest = rest.slice(end + 1).trimStart();
    } else {
      const comma = rest.indexOf(',');
      if (/[{[]/.test(comma === -1 ? rest : rest.slice(0, comma))) return undefined;
      rest = comma === -1 ? '' : rest.slice(comma);
    }
    if (rest.startsWith(',')) rest = rest.slice(1).trimStart();
    else if (rest.length > 0) return undefined;
  }
  return keys;
}

/** Whether `text` names `http_headers` as a key (not `env_http_headers`, not `_helper`). */
function mentionsHttpHeaders(text: string): boolean {
  return /(^|[^A-Za-z0-9_])["']?http_headers["']?([^A-Za-z0-9_]|$)/.test(text);
}

export function readCodexStaticHeaderNames(toml: string): CodexStaticHeaderNames {
  const names: string[] = [];
  let unreadable = false;
  let table: string[] = [];

  for (const raw of toml.split('\n')) {
    const line = withoutComment(raw)?.trim();
    const inScope = table[0] === 'mcp_servers';
    if (line === undefined) {
      if (inScope || /mcp_servers/.test(raw)) unreadable = true;
      continue;
    }
    if (line === '') continue;

    if (line.startsWith('[')) {
      const isArray = line.startsWith('[[');
      const header = readDottedKey(line.slice(isArray ? 2 : 1));
      const close = isArray ? ']]' : ']';
      if (!header || header.rest.trim() !== close) {
        table = [];
        if (/mcp_servers/.test(line)) unreadable = true;
        continue;
      }
      table = header.path;
      if (table[0] === 'mcp_servers' && isArray) unreadable = true;
      continue;
    }

    const key = readDottedKey(line);
    if (!key || !key.rest.startsWith('=')) {
      if (inScope && mentionsHttpHeaders(line)) unreadable = true;
      continue;
    }
    const path = [...table, ...key.path];
    const value = key.rest.slice(1);
    if (path[0] !== 'mcp_servers') continue;

    if (path.length === 4 && path[2] === 'http_headers') {
      names.push(path[3]!);
    } else if (path.length === 3 && path[2] === 'http_headers') {
      const keys = readInlineTableKeys(value);
      if (keys) names.push(...keys);
      else unreadable = true;
    } else if (
      path.includes('http_headers') ||
      (value.trimStart().startsWith('{') && mentionsHttpHeaders(value))
    ) {
      // Deeper than a header, or a server written inline with its headers
      // inside it: a form this reader does not take apart. A string value
      // that merely mentions http_headers is neither.
      unreadable = true;
    }
  }
  return { names, unreadable };
}
