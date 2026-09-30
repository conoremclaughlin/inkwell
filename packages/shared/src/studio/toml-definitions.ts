/**
 * The key paths a TOML document defines, and the ones it defines twice, read
 * without a TOML dependency.
 *
 * Codex refuses to start on a config that defines a table or a key twice
 * (lumen-alpha, 2026-09-29, #701), and it compares keys after resolving
 * them: `[ mcp_servers . "figma" ]`, `["mcp_servers".figma]` and a root
 * `mcp_servers.figma.url = ...` all define `mcp_servers.figma` (Myra, #701
 * d0f4698e). Header text misses every one of those, so this reads each
 * statement to its resolved path and applies the definition rules toml_edit
 * enforces:
 *
 * - a `[table]` header defines its table once. A table a deeper header only
 *   implied may be defined later; one made by dotted keys may not;
 * - dotted keys extend tables they or a deeper header created, never a table
 *   a `[table]` header defined;
 * - a key is defined once, and a value, an inline table included, is never
 *   extended;
 * - `[[array]]` appends to an array of tables and to nothing else, and a
 *   header below it lands in its last element.
 *
 * It stops at the first text it cannot read and says where, rather than
 * report a document it only partly read as clean.
 */

export interface TomlStatement {
  kind: 'table' | 'array-table' | 'key';
  /** The full path the statement defines, with quoting, spacing and escapes resolved. */
  path: string[];
  /** 1-based line the statement starts on. */
  line: number;
}

export interface TomlRedefinition {
  /** The path defined twice, or the value the second statement tried to extend. */
  path: string[];
  first: TomlStatement;
  second: TomlStatement;
}

export interface TomlDefinitions {
  statements: TomlStatement[];
  redefinitions: TomlRedefinition[];
  /** 1-based line of the statement that could not be read. Nothing after it was read. */
  unreadableLine?: number;
  /** The statement that defines `path` itself, rather than only a table below it. */
  definedBy(path: string[]): TomlStatement | undefined;
}

type Origin = 'header' | 'implicit' | 'dotted' | 'value' | 'array';

interface TomlNode {
  origin: Origin;
  by: TomlStatement;
  children: Map<string, TomlNode>;
  /** An array of tables' elements. A header below the array lands in the last one. */
  elements: TomlNode[];
}

function tomlNode(origin: Origin, by: TomlStatement): TomlNode {
  return { origin, by, children: new Map(), elements: [] };
}

const BARE_KEY_CHAR = /[A-Za-z0-9_-]/;
const SIMPLE_ESCAPES = new Map([
  ['b', '\b'],
  ['t', '\t'],
  ['n', '\n'],
  ['f', '\f'],
  ['r', '\r'],
  ['e', '\x1b'],
  ['"', '"'],
  ['\\', '\\'],
]);
const HEX_ESCAPE_WIDTH = new Map([
  ['x', 2],
  ['u', 4],
  ['U', 8],
]);

class Unreadable extends Error {}

/** `[a.b."c d"]`-style display of a path, for a finding a human reads. */
export function formatTomlPath(path: string[]): string {
  return path
    .map((segment) => (/^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment)))
    .join('.');
}

export function readTomlDefinitions(toml: string): TomlDefinitions {
  const text = toml.startsWith('﻿') ? toml.slice(1) : toml;
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (at: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid]! <= at) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  let pos = 0;
  const fail = (): never => {
    throw new Unreadable();
  };
  const at = (offset = 0): string | undefined => text[pos + offset];

  function skipSpaces(): void {
    while (at() === ' ' || at() === '\t') pos += 1;
  }
  function skipComment(): void {
    if (at() === '#') while (pos < text.length && at() !== '\n') pos += 1;
  }
  function skipNewline(): boolean {
    if (at() === '\n') pos += 1;
    else if (at() === '\r' && at(1) === '\n') pos += 2;
    else return false;
    return true;
  }
  /** Spaces, comments and line breaks, as between the items of an array. */
  function skipBlank(): void {
    do {
      skipSpaces();
      skipComment();
    } while (skipNewline());
  }
  /** The rest of a statement's line: spaces, an optional comment, the break. */
  function endStatement(): void {
    skipSpaces();
    skipComment();
    if (pos < text.length && !skipNewline()) fail();
  }

  function readBasicString(): string {
    pos += 1;
    let out = '';
    for (;;) {
      const ch = at();
      if (ch === undefined || ch === '\n' || ch === '\r') fail();
      pos += 1;
      if (ch === '"') return out;
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const escape = at() ?? fail();
      pos += 1;
      const simple = SIMPLE_ESCAPES.get(escape);
      if (simple !== undefined) {
        out += simple;
        continue;
      }
      const width = HEX_ESCAPE_WIDTH.get(escape) ?? fail();
      const hex = text.slice(pos, pos + width);
      if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== width) fail();
      const codePoint = parseInt(hex, 16);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) fail();
      out += String.fromCodePoint(codePoint);
      pos += width;
    }
  }
  function readLiteralString(): string {
    const end = text.indexOf("'", pos + 1);
    const newline = text.slice(pos + 1, end).search(/[\r\n]/);
    if (end === -1 || newline !== -1) fail();
    const out = text.slice(pos + 1, end);
    pos = end + 1;
    return out;
  }
  function skipMultilineString(delimiter: '"""' | "'''"): void {
    pos += 3;
    for (;;) {
      if (pos >= text.length) fail();
      if (delimiter === '"""' && at() === '\\') {
        pos += 2;
        continue;
      }
      if (text.startsWith(delimiter, pos)) {
        pos += 3;
        // Up to two more quotes belong to the content: `""""` ends on a quote.
        for (let extra = 0; extra < 2 && at() === delimiter[0]; extra += 1) pos += 1;
        return;
      }
      pos += 1;
    }
  }

  function readKeySegment(): string {
    const ch = at();
    if (ch === '"') return readBasicString();
    if (ch === "'") return readLiteralString();
    const start = pos;
    while (pos < text.length && BARE_KEY_CHAR.test(text[pos]!)) pos += 1;
    if (pos === start) fail();
    return text.slice(start, pos);
  }
  function readKey(): string[] {
    const path = [readKeySegment()];
    for (;;) {
      skipSpaces();
      if (at() !== '.') return path;
      pos += 1;
      skipSpaces();
      path.push(readKeySegment());
    }
  }

  const statements: TomlStatement[] = [];
  const redefinitions: TomlRedefinition[] = [];
  const root = tomlNode('header', { kind: 'table', path: [], line: 1 });

  /**
   * Walk `path` below `from`, creating what is missing. Dotted keys make
   * dotted tables and may not pass through a header-defined one; headers make
   * implicit tables. Either may pass into an array of tables' last element.
   * Undefined, with the redefinition recorded, when the walk hits a value.
   */
  function descend(
    from: TomlNode,
    fromPath: string[],
    path: string[],
    statement: TomlStatement,
    dotted: boolean
  ): TomlNode | undefined {
    let current = from;
    for (let i = 0; i < path.length; i += 1) {
      let child = current.children.get(path[i]!);
      if (!child) {
        child = tomlNode(dotted ? 'dotted' : 'implicit', statement);
        current.children.set(path[i]!, child);
      } else if (child.origin === 'array') {
        child = child.elements[child.elements.length - 1]!;
      } else if (child.origin === 'value' || (dotted && child.origin === 'header')) {
        redefinitions.push({
          path: [...fromPath, ...path.slice(0, i + 1)],
          first: child.by,
          second: statement,
        });
        return undefined;
      }
      current = child;
    }
    return current;
  }

  /** A value: a string, an array, an inline table (read into its keys) or a bare scalar. */
  function readValue(statement: TomlStatement, valuePath: string[]): TomlNode {
    const value = tomlNode('value', statement);
    if (text.startsWith('"""', pos)) skipMultilineString('"""');
    else if (text.startsWith("'''", pos)) skipMultilineString("'''");
    else if (at() === '"') readBasicString();
    else if (at() === "'") readLiteralString();
    else if (at() === '[') {
      pos += 1;
      for (;;) {
        skipBlank();
        if (at() === ']') break;
        readValue(statement, valuePath);
        skipBlank();
        if (at() === ',') pos += 1;
        else if (at() === ']') break;
        else fail();
      }
      pos += 1;
    } else if (at() === '{') {
      pos += 1;
      for (;;) {
        skipBlank();
        if (at() === '}') break;
        const key = readKey();
        skipSpaces();
        if (at() !== '=') fail();
        pos += 1;
        skipSpaces();
        const inner = readValue(statement, [...valuePath, ...key]);
        // Inside an inline table every table is its own, so dotted keys extend
        // what they made and a key is still defined once.
        const parent = descend(value, valuePath, key.slice(0, -1), statement, true);
        const last = key[key.length - 1]!;
        const existing = parent?.children.get(last);
        if (existing) {
          redefinitions.push({
            path: [...valuePath, ...key],
            first: existing.by,
            second: statement,
          });
        } else parent?.children.set(last, inner);
        skipBlank();
        if (at() === ',') pos += 1;
        else if (at() === '}') break;
        else fail();
      }
      pos += 1;
    } else {
      // A number, boolean, date or time: up to whatever ends a value.
      const start = pos;
      while (pos < text.length && !/[,\]}\r\n#]/.test(text[pos]!)) pos += 1;
      while (pos > start && (text[pos - 1] === ' ' || text[pos - 1] === '\t')) pos -= 1;
      if (pos === start) fail();
    }
    return value;
  }

  function defineTable(path: string[], statement: TomlStatement): TomlNode | undefined {
    const parent = descend(root, [], path.slice(0, -1), statement, false);
    if (!parent) return undefined;
    const last = path[path.length - 1]!;
    const existing = parent.children.get(last);
    if (!existing) {
      const table = tomlNode('header', statement);
      parent.children.set(last, table);
      return table;
    }
    if (existing.origin === 'implicit') {
      existing.origin = 'header';
      existing.by = statement;
      return existing;
    }
    redefinitions.push({ path, first: existing.by, second: statement });
    return undefined;
  }

  function appendArrayTable(path: string[], statement: TomlStatement): TomlNode | undefined {
    const parent = descend(root, [], path.slice(0, -1), statement, false);
    if (!parent) return undefined;
    const last = path[path.length - 1]!;
    const existing = parent.children.get(last);
    const element = tomlNode('header', statement);
    if (!existing) {
      const array = tomlNode('array', statement);
      array.elements.push(element);
      parent.children.set(last, array);
      return element;
    }
    if (existing.origin === 'array') {
      existing.elements.push(element);
      return element;
    }
    redefinitions.push({ path, first: existing.by, second: statement });
    return undefined;
  }

  let scope = root;
  let scopePath: string[] = [];
  let statementStart = 0;
  let unreadableLine: number | undefined;
  try {
    for (;;) {
      skipBlank();
      if (pos >= text.length) break;
      statementStart = pos;
      const line = lineOf(pos);
      if (at() === '[') {
        const isArray = at(1) === '[';
        pos += isArray ? 2 : 1;
        skipSpaces();
        const path = readKey();
        skipSpaces();
        const close = isArray ? ']]' : ']';
        if (!text.startsWith(close, pos)) fail();
        pos += close.length;
        endStatement();
        const statement: TomlStatement = { kind: isArray ? 'array-table' : 'table', path, line };
        statements.push(statement);
        // After a redefinition the header's keys go to a table of their own,
        // so they are read without being charged to the table it collided with.
        scope =
          (isArray ? appendArrayTable(path, statement) : defineTable(path, statement)) ??
          tomlNode('header', statement);
        scopePath = path;
      } else {
        const key = readKey();
        skipSpaces();
        if (at() !== '=') fail();
        pos += 1;
        skipSpaces();
        const statement: TomlStatement = { kind: 'key', path: [...scopePath, ...key], line };
        const value = readValue(statement, statement.path);
        endStatement();
        statements.push(statement);
        const parent = descend(scope, scopePath, key.slice(0, -1), statement, true);
        const last = key[key.length - 1]!;
        const existing = parent?.children.get(last);
        if (existing)
          redefinitions.push({ path: statement.path, first: existing.by, second: statement });
        else parent?.children.set(last, value);
      }
    }
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    unreadableLine = lineOf(statementStart);
  }

  return {
    statements,
    redefinitions,
    ...(unreadableLine !== undefined ? { unreadableLine } : {}),
    definedBy(path: string[]): TomlStatement | undefined {
      let current: TomlNode | undefined = root;
      for (let i = 0; i < path.length && current; i += 1) {
        current = current.children.get(path[i]!);
        if (current?.origin === 'array' && i < path.length - 1) {
          current = current.elements[current.elements.length - 1];
        }
      }
      return current && current !== root && current.origin !== 'implicit' ? current.by : undefined;
    },
  };
}
