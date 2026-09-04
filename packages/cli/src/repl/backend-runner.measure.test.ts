import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { measurePreparedPromptBytes, MEDIA_TOKEN_RESERVE_BYTES } from './backend-runner.js';
import type { TurnMedia } from '../backends/types.js';
import { CodexAdapter } from '../backends/codex.js';

describe('measurePreparedPromptBytes — exactly what a spawn would hand the backend (Lumen, PR #576 round 7)', () => {
  it.each(['codex', 'gemini'])(
    'REGRESSION (Lumen, round 8): a stateless backend passes the override as a FILE — its bytes count (%s)',
    (backend) => {
      const cjk = '漢'.repeat(30_000); // 90,000 bytes
      const base = measurePreparedPromptBytes({
        backend,
        agentId: 'wren',
        prompt: 'hello',
        toolRouting: 'local',
      });
      const withOverride = measurePreparedPromptBytes({
        backend,
        agentId: 'wren',
        prompt: 'hello',
        toolRouting: 'local',
        systemPromptOverride: cjk,
      });
      expect(withOverride - base).toBeGreaterThanOrEqual(90_000 - 4_000);
      expect(withOverride).toBeGreaterThanOrEqual(90_000);
    }
  );

  it('counts the system prompt override and the prompt, in UTF-8 bytes', () => {
    const cjk = '漢'.repeat(30_000); // 90,000 bytes, 30,000 UTF-16 units
    const base = measurePreparedPromptBytes({
      backend: 'claude',
      agentId: 'wren',
      prompt: 'hello',
      toolRouting: 'local',
    });
    const withOverride = measurePreparedPromptBytes({
      backend: 'claude',
      agentId: 'wren',
      prompt: 'hello',
      toolRouting: 'local',
      systemPromptOverride: cjk,
    });
    // The override REPLACES the generated identity prompt, so the delta is the
    // override minus that prompt; the absolute size carries all 90,000 bytes.
    expect(withOverride).toBeGreaterThanOrEqual(90_000 + Buffer.byteLength('hello'));
    expect(withOverride).toBeGreaterThan(base);
    expect(base).toBeGreaterThan(Buffer.byteLength('hello'));
  });
});

describe('what the prepared spawn cannot show (Lumen, PR #576 round 9)', () => {
  it('REGRESSION: a tiny compressed image counts at least the per-file token reserve, never its bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ink-media-'));
    try {
      const tiny = join(dir, 'blank.webp');
      writeFileSync(tiny, Buffer.alloc(220)); // 2048×2048 lossless WebP is this small
      const media = [{ path: tiny, mimeType: 'image/webp' } as unknown as TurnMedia];
      const base = measurePreparedPromptBytes(
        { backend: 'codex', agentId: 'wren', prompt: 'hi', toolRouting: 'local' },
        dir
      );
      const withMedia = measurePreparedPromptBytes(
        { backend: 'codex', agentId: 'wren', prompt: 'hi', toolRouting: 'local', media },
        dir
      );
      expect(withMedia - base).toBeGreaterThanOrEqual(MEDIA_TOKEN_RESERVE_BYTES);
      expect(MEDIA_TOKEN_RESERVE_BYTES).toBeGreaterThanOrEqual(3_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSION: Codex's discovered AGENTS.md counts up to its 32 KiB cap, plus a tool-schema reserve", () => {
    const root = mkdtempSync(join(tmpdir(), 'ink-agents-'));
    try {
      mkdirSync(join(root, '.git'));
      const nested = join(root, 'packages', 'cli');
      mkdirSync(nested, { recursive: true });
      const bare = measurePreparedPromptBytes(
        { backend: 'codex', agentId: 'wren', prompt: 'hi', toolRouting: 'local' },
        nested
      );
      writeFileSync(join(root, 'AGENTS.md'), 'a'.repeat(90_000)); // a 90KB AGENTS.md at the repo root
      const withDocs = measurePreparedPromptBytes(
        { backend: 'codex', agentId: 'wren', prompt: 'hi', toolRouting: 'local' },
        nested
      );
      expect(withDocs - bare).toBe(CodexAdapter.PROJECT_DOC_MAX_BYTES);
      expect(new CodexAdapter().hiddenContextBytes(nested).bytes).toBeGreaterThan(
        CodexAdapter.PROJECT_DOC_MAX_BYTES
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Gemini's GEMINI.md is uncapped", () => {
    const root = mkdtempSync(join(tmpdir(), 'ink-gemini-'));
    try {
      mkdirSync(join(root, '.git'));
      const bare = measurePreparedPromptBytes(
        { backend: 'gemini', agentId: 'wren', prompt: 'hi', toolRouting: 'local' },
        root
      );
      writeFileSync(join(root, 'GEMINI.md'), 'g'.repeat(90_000));
      const withDocs = measurePreparedPromptBytes(
        { backend: 'gemini', agentId: 'wren', prompt: 'hi', toolRouting: 'local' },
        root
      );
      expect(withDocs - bare).toBe(90_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
