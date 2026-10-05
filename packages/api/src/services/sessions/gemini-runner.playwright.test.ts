/**
 * A triggered Gemini session gets Playwright headless and isolated (task
 * cd2fe361). The runner writes its own settings file from the studio's
 * `.mcp.json` rather than passing that file through, so the pin has to
 * happen here too. The spawn is stubbed: the test reads the settings file
 * the runner hands Gemini, at the moment it would start.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GeminiRunner } from './gemini-runner.js';

let root: string;
let prevStudiosRoot: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gemini-runner-playwright-'));
  prevStudiosRoot = process.env.INK_STUDIOS_ROOT;
  process.env.INK_STUDIOS_ROOT = join(root, 'studios');
});
afterEach(() => {
  if (prevStudiosRoot === undefined) delete process.env.INK_STUDIOS_ROOT;
  else process.env.INK_STUDIOS_ROOT = prevStudiosRoot;
  rmSync(root, { recursive: true, force: true });
});

async function settingsAtSpawn(playwright: object): Promise<Record<string, any>> {
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { playwright } }));
  const runner = new GeminiRunner();
  let captured: Record<string, any> | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runner as any).spawnProcess = async (
    _args: string[],
    _config: unknown,
    env?: Record<string, string>
  ) => {
    captured = JSON.parse(readFileSync(env!.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf-8'));
    return { responses: [] };
  };
  await runner.run('hello', {
    config: {
      workingDirectory: root,
      mcpConfigPath: '',
      inkAccessToken: 'token',
      inkSessionId: 'session-1',
      sbSlug: 'aster',
    } as never,
  });
  if (!captured) throw new Error('the runner never reached spawn');
  return captured;
}

describe('GeminiRunner settings', () => {
  it("launches the studio's Playwright server headless and isolated", async () => {
    const settings = await settingsAtSpawn({
      type: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp', '--headless'],
    });
    expect(settings.mcpServers.playwright.args).toEqual([
      '@playwright/mcp',
      '--headless',
      '--isolated',
    ]);
    expect(settings.mcpServers.inkwell.headers.Authorization).toBe('Bearer ${INK_ACCESS_TOKEN}');
  });

  it('keeps an explicit browser opt-in as written', async () => {
    const attached = { command: 'npx', args: ['@playwright/mcp', '--extension'] };
    const settings = await settingsAtSpawn(attached);
    expect(settings.mcpServers.playwright.args).toEqual(attached.args);
  });
});
