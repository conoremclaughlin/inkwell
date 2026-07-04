/**
 * LIVE e2e: backend actually sees attached images
 *
 * The only tier where an LLM generates output (see CLAUDE.md "Testing").
 * Verifies the full attachment chain — attachment block in the prompt +
 * --add-dir grant — by asking the claude backend to name the color of a
 * solid-red fixture image. If the backend can't read the file (missing
 * --add-dir, bad path), it cannot answer "red".
 *
 * Gated: runs only with INK_LIVE_TESTS=1 and a `claude` binary on PATH.
 *
 *   INK_LIVE_TESTS=1 npx vitest run packages/cli/src/repl/attachments.live.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { runBackendTurn } from './backend-runner.js';
import { resolveAttachments, buildAttachmentBlock, collectAttachmentDirs } from './attachments.js';

const execFileAsync = promisify(execFile);

const LIVE = process.env.INK_LIVE_TESTS === '1';

async function claudeAvailable(): Promise<boolean> {
  try {
    await execFileAsync('claude', ['--version'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

// 32x32 solid red PNG
const RED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==';

describe.skipIf(!LIVE)('live: attachment visibility through the backend', () => {
  let dir: string;
  let imagePath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ink-live-attach-'));
    imagePath = join(dir, 'fixture-square.png');
    await writeFile(imagePath, Buffer.from(RED_PNG_BASE64, 'base64'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('claude backend reads an attached image and names its color', async () => {
    if (!(await claudeAvailable())) {
      console.warn('[live] claude binary unavailable — skipping');
      return;
    }

    const attachments = await resolveAttachments([imagePath]);
    expect(attachments[0].missing).toBeUndefined();

    const prompt = [
      'What is the dominant color of the attached image?',
      'Reply with a single lowercase word (the color name) and nothing else.',
      '',
      buildAttachmentBlock(attachments),
    ].join('\n');

    const result = await runBackendTurn({
      backend: 'claude',
      agentId: 'live-test',
      prompt,
      attachmentDirs: collectAttachmentDirs(attachments),
      timeoutMs: 120_000,
    });

    expect(result.success).toBe(true);
    expect(result.stdout.toLowerCase()).toContain('red');
  }, 180_000);
});
