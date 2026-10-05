/**
 * Every runner asks its caller's admission (`config.admitSpawn`) at its
 * spawn seam, past its own preparation, so a hold or fence that lands while
 * the run is prepared still starts nothing (Lumen's reviews of #747, #751).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      throw new Error('spawn reached past a refusal');
    }),
  };
});
vi.mock('./resolve-binary.js', () => ({
  resolveBinaryPath: vi.fn().mockResolvedValue('/usr/bin/false'),
  buildSpawnPath: vi.fn().mockReturnValue('/usr/bin:/bin'),
}));
vi.mock('../studio-paths.js', () => ({
  ensureInkStudiosRoot: vi.fn().mockResolvedValue(undefined),
  inkStudiosRoot: vi.fn().mockReturnValue('/tmp/ink-studios-fixture'),
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { spawn } from 'child_process';
import { CodexRunner } from './codex-runner.js';
import { GeminiRunner } from './gemini-runner.js';
import { AntigravityRunner } from './antigravity-runner.js';

const runners = {
  codex: () => new CodexRunner(),
  gemini: () => new GeminiRunner(),
  antigravity: () => new AntigravityRunner(),
};

describe('admitSpawn at the spawn seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const [name, make] of Object.entries(runners)) {
    it(`${name}: a refusal asked past the preparation starts nothing, and says so`, async () => {
      const workingDirectory = mkdtempSync(join(tmpdir(), `admit-${name}-`));
      try {
        let asked = 0;
        const result = await make().run('hello', {
          config: {
            workingDirectory,
            inkMcpUrl: 'http://127.0.0.1:9/mcp',
            admitSpawn: () => {
              asked += 1;
              return 'held: a survivor may still be running this session';
            },
          } as never,
        });
        expect(asked).toBe(1);
        expect(spawn).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          success: false,
          refusedBeforeSpawn: true,
          error: 'held: a survivor may still be running this session',
        });
      } finally {
        rmSync(workingDirectory, { recursive: true, force: true });
      }
    });
  }

  it('every physical spawn in every runner is preceded, past its last await, by the admission', () => {
    const files = [
      'claude-runner.ts',
      'ink-runner.ts',
      'codex-runner.ts',
      'gemini-runner.ts',
      'antigravity-runner.ts',
    ];
    let seams = 0;
    for (const file of files) {
      // Line comments blanked, offsets kept: a comment's "await" or "spawn(" is not code.
      const source = readFileSync(join(__dirname, file), 'utf-8').replace(/\/\/.*$/gm, (comment) =>
        ' '.repeat(comment.length)
      );
      for (const match of source.matchAll(/\bspawn\(/g)) {
        const before = source.slice(0, match.index);
        const sinceAwait = before.slice(before.lastIndexOf('await '));
        expect(sinceAwait, `${file} at offset ${match.index}`).toContain('config.admitSpawn?.()');
        seams += 1;
      }
    }
    // One physical spawn per runner today; a new one must come with its own check.
    expect(seams).toBe(files.length);
  });
});
