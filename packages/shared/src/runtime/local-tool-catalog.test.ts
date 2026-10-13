import { describe, expect, it, vi } from 'vitest';
import { describeToolWithLocalSurface } from './local-tool-catalog.js';
import { buildLocalToolInstruction } from './local-tool-instruction.js';

describe('context-tool cache guidance', () => {
  it.each(['evict_context', 'compact_context'])(
    'keeps %s guidance in the prompt and exact discovery answer',
    async (name) => {
      const callServer = vi.fn(async () => ({}));
      const loadCodingTools = vi.fn(async () => new Map());
      const result = await describeToolWithLocalSurface(
        { name },
        { audience: 'parent', cwd: '/synthetic-work', callServer, loadCodingTools }
      );
      expect(result.success).toBe(true);
      const tool = result.tool as { description: string };
      const prompt = buildLocalToolInstruction({ audience: 'parent' });
      expect(prompt).toContain(`- ${name}: ${tool.description}`);
      expect(tool.description).toContain('in a resumed Claude session');
      expect(tool.description).toContain('an actual removal reseeds the retained prompt');
      expect(tool.description).toContain('unchanged text is not guaranteed to hit cache');
      expect(tool.description).toContain('At Opus 5.5 API rates, reads cost 5% of fresh input');
      expect(tool.description).toContain('25× a read (5 minutes) or 40× (1 hour)');
      expect(tool.description).toContain('Rates vary by model');
      expect(tool.description).toContain('Batch small cleanups');
      expect(tool.description).toContain('rewrite/summarization cost');
      expect(tool.description).toContain('tool continuations count');
      expect(tool.description).toContain('Required removals and context headroom take priority');
      expect(callServer).not.toHaveBeenCalled();
      expect(loadCodingTools).not.toHaveBeenCalled();
    }
  );

  it('makes both tools discoverable by cache cost without loading coding tools', async () => {
    const loadCodingTools = vi.fn(async () => new Map());
    const result = await describeToolWithLocalSurface(
      { search: 'cache cost' },
      {
        audience: 'parent',
        cwd: '/synthetic-work',
        callServer: async () => ({ success: true, tools: [] }),
        loadCodingTools,
      }
    );
    expect(result.tools).toEqual([
      expect.objectContaining({ name: 'evict_context', summary: expect.stringContaining('5%') }),
      expect.objectContaining({ name: 'compact_context', summary: expect.stringContaining('5%') }),
    ]);
    expect(loadCodingTools).not.toHaveBeenCalled();
  });

  it('does not advertise compaction to clones while retaining their eviction guidance', () => {
    const prompt = buildLocalToolInstruction({ audience: 'clone' });
    expect(prompt).toContain('- evict_context:');
    expect(prompt).toContain('Cache cost: in a resumed Claude session');
    expect(prompt).not.toContain('- compact_context:');
  });
});
