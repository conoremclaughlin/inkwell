import { describe, expect, it } from 'vitest';
import { readCodexStaticHeaderNames } from './codex-http-headers.js';

const read = (lines: string[]) => readCodexStaticHeaderNames(lines.join('\n'));

describe('readCodexStaticHeaderNames, the three forms', () => {
  it('reads an inline table, with quoted, literal and bare keys', () => {
    expect(
      read([
        '[mcp_servers.inkwell]',
        'url = "http://localhost:3001/mcp"',
        `http_headers = { "X-Ink-Session-Id" = "synthetic", 'X-Literal' = 'v', bare-key = "a, b" }`,
      ])
    ).toEqual({ names: ['X-Ink-Session-Id', 'X-Literal', 'bare-key'], unreadable: false });
  });

  it('reads a sub-table, with comments between and after', () => {
    expect(
      read([
        '# synthetic user config',
        '[mcp_servers.inkwell.http_headers] # the headers',
        '# a comment line',
        '"X-Ink-Context" = "synthetic" # trailing',
        'X-Custom = "v"',
        '[other]',
        'X-Not-A-Header = "v"',
      ])
    ).toEqual({ names: ['X-Ink-Context', 'X-Custom'], unreadable: false });
  });

  it('reads dotted keys, from the server table and from tables above it', () => {
    expect(
      read([
        '[mcp_servers.inkwell]',
        'http_headers."X-Ink-Studio-Id" = "synthetic"',
        'http_headers . plain = "v"',
        '[mcp_servers]',
        'other.http_headers."X-B" = "v"',
        '[root]',
      ])
    ).toEqual({ names: ['X-Ink-Studio-Id', 'plain', 'X-B'], unreadable: false });
    expect(read(['mcp_servers.inkwell.http_headers."X-Top" = "v"'])).toEqual({
      names: ['X-Top'],
      unreadable: false,
    });
  });
});

describe('readCodexStaticHeaderNames, near-misses', () => {
  it('does not count a routing name in a value, a comment, env_http_headers or the helper', () => {
    expect(
      read([
        '[mcp_servers.inkwell]',
        'http_headers = { "X-Custom" = "x-ink-session-id # not a comment" } # x-ink-context',
        'env_http_headers = { "x-ink-studio-id" = "INK_STUDIO_ID" }',
        'http_headers_helper = "/synthetic/helper"',
        'description = "http_headers = { x-ink-context = 1 }"',
        '# http_headers = { "x-ink-session-id" = "commented out" }',
      ])
    ).toEqual({ names: ['X-Custom'], unreadable: false });
  });

  it('ignores http_headers outside an [mcp_servers.*] scope', () => {
    expect(read(['[profiles.synthetic]', 'http_headers = [ "odd", "shape" ]'])).toEqual({
      names: [],
      unreadable: false,
    });
  });
});

describe('readCodexStaticHeaderNames never reports clean what it could not read', () => {
  it.each<[string, string[]]>([
    ['a multi-line inline table', ['[mcp_servers.x]', 'http_headers = {', '  "X-A" = "v"', '}']],
    [
      'a server written inline with its headers',
      ['[mcp_servers]', 'x = { url = "u", http_headers = { "X-A" = "v" } }'],
    ],
    ['a header nested one level deeper', ['[mcp_servers.x.http_headers.deeper]', 'X-A = "v"']],
    ['an array of tables in scope', ['[[mcp_servers.x.http_headers]]', 'X-A = "v"']],
    [
      'an http_headers value that is not an inline table',
      ['[mcp_servers.x]', 'http_headers = "X-A: v"'],
    ],
    ['an unterminated string in scope', ['[mcp_servers.x]', 'http_headers = { "X-A = "v" }']],
    ['a key line the reader cannot parse', ['[mcp_servers.x]', '"unclosed.http_headers = 1']],
  ])('%s', (_label, lines) => {
    expect(read(lines).unreadable).toBe(true);
  });
});
