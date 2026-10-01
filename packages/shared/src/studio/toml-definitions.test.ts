import { describe, expect, it } from 'vitest';
import { formatTomlPath, readTomlDefinitions } from './toml-definitions.js';

const read = (...lines: string[]) => readTomlDefinitions(lines.join('\n'));
const redefined = (...lines: string[]) =>
  read(...lines).redefinitions.map(({ path }) => formatTomlPath(path));

describe('readTomlDefinitions: a key is what it resolves to', () => {
  it('resolves quoting, spacing and escapes in a header to one path', () => {
    for (const header of [
      '[mcp_servers.figma]',
      '[ mcp_servers . "figma" ]',
      '["mcp_servers".figma]',
      "['mcp_servers' . 'figma']  # a comment",
      '[mcp_servers."fig\\u006Da"]',
    ]) {
      expect(read(header).statements, header).toEqual([
        { kind: 'table', path: ['mcp_servers', 'figma'], line: 1 },
      ]);
    }
  });

  it('resolves a key-value to its full path under the table it sits in', () => {
    expect(read('[mcp_servers]', 'figma . "url" = "x"').statements[1]).toEqual({
      kind: 'key',
      path: ['mcp_servers', 'figma', 'url'],
      line: 2,
    });
  });
});

describe('readTomlDefinitions: what Codex refuses as a redefinition', () => {
  it('the same table in two spellings', () => {
    expect(redefined('[mcp_servers.figma]', '[ mcp_servers . "figma" ]')).toEqual([
      'mcp_servers.figma',
    ]);
  });

  it('a table made by root dotted keys, then defined by a header', () => {
    expect(redefined('mcp_servers.figma.url = "x"', '[mcp_servers.figma]')).toEqual([
      'mcp_servers.figma',
    ]);
  });

  it('a header-defined table, then extended by dotted keys from the table above it', () => {
    expect(redefined('[fruit.apple]', '[fruit]', 'apple.color = "red"')).toEqual(['fruit.apple']);
  });

  it('a key defined twice, and a key over a table a deeper header implied', () => {
    expect(redefined('a = 1', 'a = 2')).toEqual(['a']);
    expect(redefined('[a.b.c]', '[a]', 'b = 1')).toEqual(['a.b']);
  });

  it('a value extended, an inline table included', () => {
    expect(redefined('a = { b = 1 }', '[a.c]')).toEqual(['a']);
    expect(redefined('a = 1', 'a.b = 2')).toEqual(['a']);
    expect(redefined('mcp_servers = { figma = { url = "x" } }', '[mcp_servers.inkwell]')).toEqual([
      'mcp_servers',
    ]);
  });

  it('a key defined twice inside an inline table', () => {
    expect(redefined('a = { b = 1, b = 2 }')).toEqual(['a.b']);
  });

  it('an array of tables over a table, and a table over an array of tables', () => {
    expect(redefined('[a.b]', '[[a]]')).toEqual(['a']);
    expect(redefined('[[a]]', '[a]')).toEqual(['a']);
  });
});

describe('readTomlDefinitions: what TOML allows (controls)', () => {
  it('a super-table defined after the sub-table that implied it', () => {
    expect(redefined('[a.b.c]', 'x = 1', '[a]', 'y = 2')).toEqual([]);
  });

  it('a sub-table under a table made by dotted keys', () => {
    expect(
      redefined('[fruit]', 'apple.color = "red"', '[fruit.apple.texture]', 'smooth = true')
    ).toEqual([]);
    expect(redefined('mcp_servers.figma.url = "x"', '[mcp_servers.inkwell]')).toEqual([]);
  });

  it('dotted keys extending a table they made', () => {
    expect(redefined('a.b = 1', 'a.c = 2')).toEqual([]);
  });

  it('sub-tables in each element of an array of tables', () => {
    expect(redefined('[[a]]', '[a.b]', '[[a]]', '[a.b]')).toEqual([]);
  });

  it('a sub-table outside the block beside a server table inside it', () => {
    expect(
      redefined('[mcp_servers.figma]', 'url = "x"', '[mcp_servers.figma.http_headers]', 'X-A = "v"')
    ).toEqual([]);
  });
});

describe('readTomlDefinitions: text that is not a statement is not read as one', () => {
  it('a header-shaped line inside a multi-line string, basic or literal', () => {
    const text = [
      'a = """',
      '[mcp_servers.figma]',
      'b\\"""still in the string',
      '"""',
      "c = '''",
      '[mcp_servers.figma]',
      "'''",
      '[mcp_servers.figma]',
    ];
    expect(read(...text).statements.map((s) => s.line)).toEqual([1, 5, 8]);
    expect(redefined(...text)).toEqual([]);
  });

  it('an array spanning lines, with nested arrays, strings and comments', () => {
    const text = [
      'args = [',
      '  ["x", "]"],  # a comment',
      '  "[mcp_servers.figma]",',
      ']',
      '[mcp_servers.figma]',
    ];
    expect(read(...text).statements.map((s) => s.kind)).toEqual(['key', 'table']);
    expect(read(...text).unreadableLine).toBeUndefined();
  });

  it('a # inside a string, CRLF line breaks and a byte-order mark', () => {
    const doc = readTomlDefinitions('﻿a = "#not a comment" # a comment\r\n[b]\r\nc = 1\r\n');
    expect(doc.unreadableLine).toBeUndefined();
    expect(doc.statements.map((s) => s.path.join('.'))).toEqual(['a', 'b', 'b.c']);
  });

  it('bare scalars: numbers, booleans, and a date-time with a space in it', () => {
    const doc = read('a = 1_000', 'b = true', 'c = 1979-05-27 07:32:00Z', 'd = -inf # x');
    expect(doc.unreadableLine).toBeUndefined();
    expect(doc.statements).toHaveLength(4);
  });
});

describe('readTomlDefinitions: what it cannot read, it says so', () => {
  it('stops at an unterminated string and names the statement line', () => {
    const doc = read('[a]', 'b = "open', '[a]');
    expect(doc.unreadableLine).toBe(2);
    // Nothing after it was read, so the duplicate [a] below is not claimed either way.
    expect(doc.statements).toHaveLength(1);
  });

  it('an unknown escape in a key, a key with no value, trailing text', () => {
    expect(read('[a."\\q"]').unreadableLine).toBe(1);
    expect(read('ok = 1', 'a =').unreadableLine).toBe(2);
    expect(read('a = "x" b').unreadableLine).toBe(1);
    expect(read('[a] b').unreadableLine).toBe(1);
  });

  it('an unterminated multi-line string names the line it starts on', () => {
    expect(read('a = 1', 'b = """', 'never closed').unreadableLine).toBe(2);
  });
});

describe('readTomlDefinitions: definedBy', () => {
  it('names the statement that defines a table, whichever form defines it', () => {
    expect(read('[mcp_servers.inkwell]').definedBy(['mcp_servers', 'inkwell'])?.line).toBe(1);
    expect(
      read('x = 1', 'mcp_servers.inkwell.url = "u"').definedBy(['mcp_servers', 'inkwell'])?.line
    ).toBe(2);
    expect(
      read('[mcp_servers]', 'inkwell = { url = "u" }').definedBy(['mcp_servers', 'inkwell'])?.line
    ).toBe(2);
    expect(
      read('mcp_servers = { inkwell = { url = "u" } }').definedBy(['mcp_servers', 'inkwell'])?.line
    ).toBe(1);
  });

  it('a table only implied by a deeper header is not defined', () => {
    expect(read('[mcp_servers.inkwell.env]').definedBy(['mcp_servers', 'inkwell'])).toBeUndefined();
    expect(read('[mcp_servers.figma]').definedBy(['mcp_servers', 'inkwell'])).toBeUndefined();
  });
});
