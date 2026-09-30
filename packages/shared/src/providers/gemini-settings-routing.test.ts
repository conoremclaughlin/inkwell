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
