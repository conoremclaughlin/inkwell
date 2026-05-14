import { describe, it, expect, vi } from 'vitest';
import { InkRunner } from './ink-runner';
import type { InkToolDefinition } from '../../agent/tools/pi-coding-tools';
import type { ImageContent } from './types';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('InkRunner', () => {
  describe('buildUserContent', () => {
    it('returns plain string when no images', () => {
      const runner = new InkRunner({ apiKey: 'test-key' });
      const result = (runner as any).buildUserContent('Hello world');
      expect(result).toBe('Hello world');
    });

    it('returns plain string when images is empty array', () => {
      const runner = new InkRunner({ apiKey: 'test-key' });
      const result = (runner as any).buildUserContent('Hello world', []);
      expect(result).toBe('Hello world');
    });

    it('returns multimodal content blocks when images are present', () => {
      const runner = new InkRunner({ apiKey: 'test-key' });
      const images: ImageContent[] = [
        { type: 'image', source: 'base64', mediaType: 'image/jpeg', data: 'abc123' },
      ];
      const result = (runner as any).buildUserContent('Describe this', images);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' },
      });
      expect(result[1]).toEqual({ type: 'text', text: 'Describe this' });
    });

    it('handles multiple images in a gallery', () => {
      const runner = new InkRunner({ apiKey: 'test-key' });
      const images: ImageContent[] = [
        { type: 'image', source: 'base64', mediaType: 'image/jpeg', data: 'img1' },
        { type: 'image', source: 'base64', mediaType: 'image/png', data: 'img2' },
        { type: 'image', source: 'base64', mediaType: 'image/webp', data: 'img3' },
      ];
      const result = (runner as any).buildUserContent('Gallery caption', images);

      expect(result).toHaveLength(4);
      expect(result[0].type).toBe('image');
      expect(result[1].type).toBe('image');
      expect(result[2].type).toBe('image');
      expect(result[3]).toEqual({ type: 'text', text: 'Gallery caption' });
    });
  });

  describe('agentId propagation', () => {
    it('creates guarded bash tools when agentId is provided', async () => {
      const runner = new InkRunner({ apiKey: 'test-key' });

      // Access private getTools to verify agentId propagation
      const tools: InkToolDefinition[] = await (runner as any).getTools('/tmp', 'wren');
      const bash = tools.find((t) => t.schema.name === 'bash')!;

      // If agentId propagated, the guard blocks dangerous commands
      const result = await bash.execute({ command: ':(){ :|:& };:' });
      expect(result).toContain('fork bomb');
    });

    it('creates unguarded bash tools when agentId is absent', async () => {
      const runner = new InkRunner({ apiKey: 'test-key' });

      const tools: InkToolDefinition[] = await (runner as any).getTools('/tmp');
      const bash = tools.find((t) => t.schema.name === 'bash')!;

      // Without agentId, guard is bypassed — command would execute
      // (we test with a safe command to avoid actual execution of dangerous ones)
      const result = await bash.execute({ command: 'echo hello' });
      expect(result).toContain('hello');
    });

    it('caches tools by cwd+agentId combination', async () => {
      const runner = new InkRunner({ apiKey: 'test-key' });

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
