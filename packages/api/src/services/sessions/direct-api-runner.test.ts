import { describe, it, expect, vi } from 'vitest';
import { DirectApiRunner } from './direct-api-runner';
import type { InkToolDefinition } from '../../agent/tools/pi-coding-tools';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('DirectApiRunner', () => {
  describe('agentId propagation', () => {
    it('creates guarded bash tools when agentId is provided', async () => {
      const runner = new DirectApiRunner({ apiKey: 'test-key' });

      // Access private getTools to verify agentId propagation
      const tools: InkToolDefinition[] = await (runner as any).getTools('/tmp', 'wren');
      const bash = tools.find((t) => t.schema.name === 'bash')!;

      // If agentId propagated, the guard blocks dangerous commands
      const result = await bash.execute({ command: ':(){ :|:& };:' });
      expect(result).toContain('fork bomb');
    });

    it('creates unguarded bash tools when agentId is absent', async () => {
      const runner = new DirectApiRunner({ apiKey: 'test-key' });

      const tools: InkToolDefinition[] = await (runner as any).getTools('/tmp');
      const bash = tools.find((t) => t.schema.name === 'bash')!;

      // Without agentId, guard is bypassed — command would execute
      // (we test with a safe command to avoid actual execution of dangerous ones)
      const result = await bash.execute({ command: 'echo hello' });
      expect(result).toContain('hello');
    });

    it('caches tools by cwd+agentId combination', async () => {
      const runner = new DirectApiRunner({ apiKey: 'test-key' });

      const tools1 = await (runner as any).getTools('/tmp', 'wren');
      const tools2 = await (runner as any).getTools('/tmp', 'wren');
      const tools3 = await (runner as any).getTools('/tmp', 'lumen');

      // Same cwd+agentId returns cached instance
      expect(tools1).toBe(tools2);
      // Different agentId returns different instance
      expect(tools1).not.toBe(tools3);
    });
  });
});
