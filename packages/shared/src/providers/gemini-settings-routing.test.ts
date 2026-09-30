import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BakedRoutingHeaderError,
  findGeminiSettingsRouting,
  refuseGeminiSettingsRouting,
} from './gemini-settings-routing.js';

const SECRET = 'synthetic-secret-8d2e41';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gemini-settings-routing-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function settingsFile(name: string, settings: unknown): string {
  const path = join(root, name);
  writeFileSync(path, typeof settings === 'string' ? settings : JSON.stringify(settings));
  return path;
}

const server = (headers: Record<string, string>) => ({
  httpUrl: 'http://localhost:3001/mcp',
  headers,
});

describe('findGeminiSettingsRouting', () => {
  it('finds nothing in settings with only other headers', async () => {
    const path = settingsFile('clean.json', {
      mcpServers: { inkwell: server({ Authorization: 'Bearer ${INK_ACCESS_TOKEN}' }) },
    });
    expect(await findGeminiSettingsRouting([path])).toEqual([]);
  });

  it('finds routing header names in any casing, on any server, as written', async () => {
    const path = settingsFile('baked.json', {
      mcpServers: {
        inkwell: server({ 'X-Ink-Session-Id': SECRET, Authorization: 'Bearer x' }),
        other: server({ 'x-ink-context': SECRET }),
      },
    });
    expect(await findGeminiSettingsRouting([path])).toEqual([
      { path, kind: 'routing', headers: ['X-Ink-Session-Id', 'x-ink-context'] },
    ]);
  });

  it('reads header names only: a routing name elsewhere in the file is not a header', async () => {
    // The whole-file regex this replaces refused every one of these.
    const path = settingsFile('elsewhere.json', {
      mcpServers: {
        inkwell: {
          httpUrl: 'http://localhost:3001/mcp',
          description: 'sends x-ink-session-id from the spawn',
          env: { 'x-ink-context': 'INK_CONTEXT' },
          headers: { 'X-Custom': 'x-ink-studio-id' },
        },
      },
      notes: 'x-ink-context',
    });
    expect(await findGeminiSettingsRouting([path])).toEqual([]);
  });

  it('treats an absent file as carrying nothing', async () => {
    expect(await findGeminiSettingsRouting([join(root, 'absent.json')])).toEqual([]);
  });

  it('reports a file that exists but cannot be parsed or read', async () => {
    const invalid = settingsFile('invalid.json', '{ "mcpServers": ');
    const directory = join(root, 'a-directory.json');
    mkdirSync(directory);
    expect(await findGeminiSettingsRouting([invalid, directory])).toEqual([
      { path: invalid, kind: 'unreadable' },
      { path: directory, kind: 'unreadable' },
    ]);
  });

  it('checks every path it is given, in order', async () => {
    const workspace = settingsFile('workspace.json', {
      mcpServers: { inkwell: server({ 'x-ink-studio-id': SECRET }) },
    });
    const user = settingsFile('user.json', {
      mcpServers: { inkwell: server({ 'X-INK-CONTEXT': SECRET }) },
    });
    const found = await findGeminiSettingsRouting([workspace, join(root, 'absent.json'), user]);
    expect(found.map((finding) => finding.path)).toEqual([workspace, user]);
  });
});

describe('findGeminiSettingsRouting reads settings as Gemini 0.54.0 does (Myra, 4705eab0)', () => {
  it('reads a commented file, leaving the `//` in a URL value alone', async () => {
    const path = settingsFile(
      'commented.json',
      [
        '{',
        '  // synthetic user settings',
        '  "mcpServers": {',
        '    /* the local server */',
        '    "inkwell": {',
        '      "httpUrl": "http://localhost:3001/mcp", // a trailing line comment',
        '      "headers": { "X-Ink-Context": "synthetic" }',
        '    }',
        '  }',
        '}',
      ].join('\n')
    );
    expect(await findGeminiSettingsRouting([path])).toEqual([
      { path, kind: 'routing', headers: ['X-Ink-Context'] },
    ]);
  });

  it('does not count a routing name that is only in a comment', async () => {
    const path = settingsFile(
      'comment-only.json',
      '{ "mcpServers": { "inkwell": { "headers": { /* was x-ink-session-id */ "X-Custom": "v" } } } } // x-ink-context'
    );
    expect(await findGeminiSettingsRouting([path])).toEqual([]);
  });

  it('keeps comment markers and escaped quotes inside strings', async () => {
    // One unpaired escaped quote: a reader that ended the string there would
    // take the `//` after it for a comment and lose the rest of the line.
    const path = settingsFile(
      'strings.json',
      '{ "mcpServers": { "a": { "description": "one \\" quote // not a comment /* nor this", ' +
        '"headers": { "x-ink-studio-id": "synthetic" } } } }'
    );
    expect(await findGeminiSettingsRouting([path])).toEqual([
      { path, kind: 'routing', headers: ['x-ink-studio-id'] },
    ]);
  });

  // Myra's probes on 802fcd78 (aebf2020), kept as rows.
  it.each<[string, string, string]>([
    [
      'a string ending in an escaped backslash, then a line comment',
      '{ "mcpServers": { "a": { "cwd": "C:\\\\", // c\n "headers": { "x-ink-context": "s" } } } }',
      'x-ink-context',
    ],
    [
      'CRLF line comments',
      '{\r\n  // synthetic\r\n  "mcpServers": { "a": { "headers": { "X-Ink-Studio-Id": "s" } } }\r\n}\r\n',
      'X-Ink-Studio-Id',
    ],
  ])('reads %s', async (_label, text, header) => {
    const path = settingsFile('probe.json', text);
    expect(await findGeminiSettingsRouting([path])).toEqual([
      { path, kind: 'routing', headers: [header] },
    ]);
  });

  it.each([
    ['a trailing comma, which Gemini also rejects', '{ "mcpServers": {}, }'],
    ['a block comment that never closes', '{ "mcpServers": {} /* synthetic'],
    ['a UTF-8 byte-order mark, which Gemini 0.54.0 rejects', '\uFEFF{ "mcpServers": {} }'],
  ])('still reports %s as unreadable', async (_label, text) => {
    const path = settingsFile('bad.json', text);
    expect(await findGeminiSettingsRouting([path])).toEqual([{ path, kind: 'unreadable' }]);
  });
});

describe('findGeminiSettingsRouting, servers other than Inkwell drawing the session (Myra, aebf2020)', () => {
  const scope = {
    inkwellMcpUrl: 'http://localhost:3001/mcp',
    sessionEnvNames: ['INK_ACCESS_TOKEN', 'INK_DELEGATION_SECRET', 'INK_CONTEXT'],
  };

  it.each<[string, Record<string, unknown>]>([
    [
      'a header value with $NAME',
      {
        httpUrl: 'https://mcp.example.com/',
        headers: { 'X-Anything': 'Bearer $INK_ACCESS_TOKEN' },
      },
    ],
    [
      'a header value with ${NAME}',
      { url: 'https://mcp.example.com/sse', headers: { 'X-Anything': '${INK_CONTEXT}' } },
    ],
    [
      "a stdio server's env value",
      { command: '/synthetic/tool', env: { SECRET: '${INK_DELEGATION_SECRET}' } },
    ],
  ])('refuses %s', async (_label, server) => {
    const path = settingsFile('foreign.json', { mcpServers: { other: server } });
    expect(await findGeminiSettingsRouting([path], scope)).toEqual([
      { path, kind: 'foreign-session-env' },
    ]);
  });

  it('admits Inkwell drawing the session, a loopback alias included, and a foreign server drawing its own vars', async () => {
    const path = settingsFile('clean.json', {
      mcpServers: {
        inkwell: {
          httpUrl: 'http://127.0.0.1:3001/mcp',
          headers: { Authorization: 'Bearer ${INK_ACCESS_TOKEN}', 'X-Ctx': '$INK_CONTEXT' },
        },
        // Inkwell declared by `url` (SSE) rather than `httpUrl`.
        inkwellSse: { url: 'http://localhost:3001/sse', headers: { 'X-Ctx': '${INK_CONTEXT}' } },
        other: { httpUrl: 'https://mcp.example.com/', headers: { 'X-Key': '$SYNTHETIC_OTHER' } },
      },
    });
    expect(await findGeminiSettingsRouting([path], scope)).toEqual([]);
  });

  it('treats a server on another port as not Inkwell', async () => {
    const path = settingsFile('port.json', {
      mcpServers: {
        near: { httpUrl: 'http://localhost:3002/mcp', headers: { A: '$INK_ACCESS_TOKEN' } },
      },
    });
    expect(await findGeminiSettingsRouting([path], scope)).toEqual([
      { path, kind: 'foreign-session-env' },
    ]);
  });

  it('only applies the rule when given the session', async () => {
    const path = settingsFile('unscoped.json', {
      mcpServers: {
        other: { httpUrl: 'https://mcp.example.com/', headers: { A: '$INK_ACCESS_TOKEN' } },
      },
    });
    expect(await findGeminiSettingsRouting([path])).toEqual([]);
  });
});

describe('refuseGeminiSettingsRouting', () => {
  it('resolves when nothing is found', async () => {
    const path = settingsFile('clean.json', { mcpServers: { inkwell: server({}) } });
    await expect(refuseGeminiSettingsRouting([path])).resolves.toBeUndefined();
  });

  it('rejects naming each file, the header names and the repair, never a value', async () => {
    const path = settingsFile('baked.json', {
      mcpServers: { inkwell: server({ 'X-Ink-Session-Id': SECRET }) },
    });
    const invalid = settingsFile('invalid.json', `{"headers": "${SECRET}"`);
    const error = await refuseGeminiSettingsRouting([path, invalid]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BakedRoutingHeaderError);
    const message = (error as Error).message;
    expect(message).toContain(`${path} sets X-Ink-Session-Id`);
    expect(message).toContain(`${invalid} cannot be read`);
    expect(message).toContain('ink init');
    expect(message).not.toContain(SECRET);
  });
});
