/**
 * GeminiRunner arg construction — the ephemeral-studio root grant
 * (spec:studio-materialization v8, PR #544 r1 P1).
 *
 * Gemini's workspace-grant equivalent of --add-dir is --include-directories;
 * without it a Gemini session can have the host MCP mint a studio it then
 * cannot touch. Pinned on both the fresh and resume arg shapes.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { GeminiRunner } from './gemini-runner.js';

describe('GeminiRunner ephemeral-studio root grant', () => {
  it('grants --include-directories for the studios root on fresh and resume shapes', () => {
    const prevRoot = process.env.INK_STUDIOS_ROOT;
    process.env.INK_STUDIOS_ROOT = join(tmpdir(), `ink-studios-gemini-${process.pid}`);
    try {
      const runner = new GeminiRunner();
      const config = { workingDirectory: '/tmp', mcpConfigPath: '' } as never;
      for (const sid of [undefined, 'gem-sess-1']) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const args: string[] = (runner as any).buildArgs('msg', config, undefined, sid);
        const granted = args
          .map((arg, i) => (arg === '--include-directories' ? args[i + 1] : null))
          .filter(Boolean);
        expect(granted).toContain(process.env.INK_STUDIOS_ROOT);
        if (sid) {
          expect(args).toContain('-r');
        }
      }
    } finally {
      if (prevRoot === undefined) delete process.env.INK_STUDIOS_ROOT;
      else process.env.INK_STUDIOS_ROOT = prevRoot;
    }
  });
});
