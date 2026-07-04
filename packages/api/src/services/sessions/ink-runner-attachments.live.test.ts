/**
 * LIVE e2e: the FULL InkRunner media chain
 *
 * Complements the CLI-side live test (attachments.live.test.ts), which
 * exercises only the inner chain (attachment block + --add-dir → claude).
 * This one spans the whole server-spawn path exactly as Myra's sessions
 * run it:
 *
 *   InkRunner.run(mediaAttachments)
 *     → ink chat --non-interactive --attach-file <path>
 *       → [Attached files] block on the turn
 *       → claude backend with --add-dir
 *         → Read renders the image → answer
 *
 * If any link drops the file (flag not parsed, block not injected, dir
 * not granted), the backend cannot name the fixture's color.
 *
 * Requirements: INK_LIVE_TESTS=1, `ink` + `claude` binaries on PATH,
 * valid ink auth, and a reachable PCP server for session bootstrap.
 *
 *   INK_LIVE_TESTS=1 yarn test:live packages/api/src/services/sessions/ink-runner-attachments.live.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { InkRunner } from './ink-runner.js';

const execFileAsync = promisify(execFile);

const LIVE = process.env.INK_LIVE_TESTS === '1';

async function binaryAvailable(binary: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(binary, args, { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

// 32x32 solid red PNG (same fixture as the CLI-side live test)
const RED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==';

describe.skipIf(!LIVE)('live: full InkRunner media chain', () => {
  let dir: string;
  let imagePath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ink-runner-live-attach-'));
    imagePath = join(dir, 'fixture-square.png');
    await writeFile(imagePath, Buffer.from(RED_PNG_BASE64, 'base64'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('InkRunner forwards an image through ink chat to the backend, which names its color', async () => {
    if (!(await binaryAvailable('ink', ['--version']))) {
      console.warn('[live] ink binary unavailable — skipping');
      return;
    }
    if (!(await binaryAvailable('claude', ['--version']))) {
      console.warn('[live] claude binary unavailable — skipping');
      return;
    }

    const runner = new InkRunner();
    const result = await runner.run(
      'What is the dominant color of the attached image? Reply with a single lowercase word (the color name) and nothing else. Do not call send_response — just answer.',
      {
        config: {
          agentId: 'wren',
          // Vitest runs from the repo root — ink chat expects a workspace-like cwd
          workingDirectory: process.cwd(),
          mcpConfigPath: join(process.cwd(), '.mcp.json'),
        },
        mediaAttachments: [{ type: 'image', path: imagePath, contentType: 'image/png' }],
      }
    );

    expect(result.success).toBe(true);
    // The answer may arrive as the final text or a routed response —
    // accept either surface, but it must name the color.
    const answer = [result.finalTextResponse, ...result.responses.map((r) => r.content)]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    expect(answer).toContain('red');
  }, 600_000);
});
