import { describe, it, expect } from 'vitest';
import { measurePreparedPromptBytes } from './backend-runner.js';

describe('measurePreparedPromptBytes — exactly what a spawn would hand the backend (Lumen, PR #576 round 7)', () => {
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
