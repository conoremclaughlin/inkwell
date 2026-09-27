/**
 * The env a server-spawned Claude process actually receives (task 2f892701).
 *
 * The runner always passes --print, and the project config it hands Claude
 * still loads the inkmail channel plugin. A print-mode host never shows a
 * channel notification, so the plugin must be told to stay inert, or it acks
 * messages that arrive mid-turn and nobody reads them.
 *
 * Only binary resolution is stubbed: a fake `claude` records its argv and env,
 * and everything from spawn-env assembly to the child process is production.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PRINT_MODE_CHANNEL_ENV } from '@inklabs/shared';

const fixtures = mkdtempSync(join(tmpdir(), 'claude-fake-env-'));
const recordPath = join(fixtures, 'spawned.json');

const hoisted = vi.hoisted(() => ({ binary: '' }));

vi.mock('./resolve-binary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resolve-binary.js')>();
  return { ...actual, resolveBinaryPath: () => Promise.resolve(hoisted.binary) };
});

import { ClaudeRunner } from './claude-runner.js';
import type { ClaudeRunnerConfig } from './types.js';

afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

describe('ClaudeRunner spawn env — channel host mode', () => {
  it('tells the inkmail plugin its --print host cannot render a channel push', async () => {
    const fake = join(fixtures, 'claude-fake.mjs');
    writeFileSync(
      fake,
      [
        '#!/usr/bin/env node',
        "import { writeFileSync } from 'fs';",
        `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
        '  argv: process.argv.slice(2),',
        '  channelHost: process.env.INK_CHANNEL_HOST ?? null,',
        '}));',
        `process.stdout.write(${JSON.stringify(
          JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 's' }) +
            '\n'
        )});`,
      ].join('\n'),
      { mode: 0o755 }
    );
    chmodSync(fake, 0o755);
    hoisted.binary = fake;

    // The runner layers its env over the API process's own, so an inherited
    // value would mask a missing one.
    const inherited = process.env.INK_CHANNEL_HOST;
    delete process.env.INK_CHANNEL_HOST;
    try {
      const config: ClaudeRunnerConfig = {
        workingDirectory: fixtures,
        mcpConfigPath: join(fixtures, '.mcp.json'),
      };
      await new ClaudeRunner().run('hello', { config });
    } finally {
      if (inherited !== undefined) process.env.INK_CHANNEL_HOST = inherited;
    }

    const spawned = JSON.parse(readFileSync(recordPath, 'utf-8')) as {
      argv: string[];
      channelHost: string | null;
    };
    expect(spawned.argv).toContain('--print');
    expect(spawned.channelHost).toBe(PRINT_MODE_CHANNEL_ENV.INK_CHANNEL_HOST);
  });
});
