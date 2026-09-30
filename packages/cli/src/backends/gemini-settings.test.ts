import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildGeminiSettings } from './gemini.js';

describe('buildGeminiSettings', () => {
  let cwd: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
  });

  // The settings carry this session's own headers, and a parent and its shadow
  // clones spawn in one process. Two spawns in one millisecond must not share a
  // file: one would read the other's session headers, and the first cleanup
  // would delete the second's settings.
  it('gives each spawn its own settings file, even within one millisecond', () => {
    cwd = mkdtempSync(join(tmpdir(), 'gemini-settings-'));
    vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000);
    const first = buildGeminiSettings(cwd, 'context-a', 'session-a');
    const second = buildGeminiSettings(cwd, 'context-b', 'session-b');
    vi.restoreAllMocks();
    try {
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second!.path).not.toBe(first!.path);
      const headers = JSON.parse(readFileSync(first!.path, 'utf8')).mcpServers.inkwell.headers;
      expect(headers['x-ink-session-id']).toBe('session-a');
      first!.cleanup();
      expect(existsSync(second!.path)).toBe(true);
    } finally {
      first?.cleanup();
      second?.cleanup();
    }
  });
});
