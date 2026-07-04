import { describe, it, expect } from 'vitest';
import { formatContextLines, computeSectionJumps, SECTION_JUMP_KEYS } from './context-viewer.js';

const baseSections = {
  passiveRecallEntries: [{ content: '[passive-recall] remembered fact', source: 'passive-recall' }],
  passiveRecallStats: { totalInjected: 1, uniqueMemories: 1, currentTurn: 3 },
  ledgerStats: { totalEntries: 10, tokenEstimate: 1200, bootstrapTokens: 800 },
};

describe('computeSectionJumps', () => {
  it('maps keys to section header lines when sections are present', () => {
    const lines = formatContextLines({
      ...baseSections,
      bootstrapSummary: 'identity: wren',
      toolCalls: [{ tool: 'recall', status: 'executed', at: new Date().toISOString() }],
      evicted: [{ role: 'system', source: 'heartbeat', preview: 'old reminder', actor: 'sb' }],
    });
    const jumps = computeSectionJumps(lines);
    for (const { key, header } of SECTION_JUMP_KEYS) {
      expect(jumps.has(key)).toBe(true);
      expect(lines[jumps.get(key)!]).toBe(header);
    }
  });

  it('omits keys for absent sections', () => {
    const lines = formatContextLines({
      ...baseSections,
      passiveRecallEntries: [],
    });
    const jumps = computeSectionJumps(lines);
    expect(jumps.has('e')).toBe(false); // no evicted section
    expect(jumps.has('t')).toBe(false); // no tool calls section
    expect(jumps.has('m')).toBe(false); // no memories (empty recall)
    expect(jumps.has('b')).toBe(false); // no bootstrap summary
  });

  it('tool calls section renders args beneath each call', () => {
    const lines = formatContextLines({
      ...baseSections,
      toolCalls: [
        {
          tool: 'send_response',
          status: 'executed',
          at: new Date().toISOString(),
          args: '{"channel":"telegram","content":"heads-up!"}',
        },
        { tool: 'get_inbox', status: 'approved', at: new Date().toISOString() },
      ],
    });
    const joined = lines.join('\n');
    expect(joined).toContain('• send_response (executed)');
    expect(joined).toContain('    {"channel":"telegram","content":"heads-up!"}');
    expect(joined).toContain('• get_inbox (approved)');
  });

  it('evicted section shows attribution and out-of-window note', () => {
    const lines = formatContextLines({
      ...baseSections,
      evicted: [
        {
          role: 'system',
          source: 'heartbeat',
          preview: 'old reminder',
          actor: 'user',
          reason: '/evict source:heartbeat',
        },
      ],
    });
    const joined = lines.join('\n');
    expect(joined).toContain('out of the prompt window — still in the transcript');
    expect(joined).toContain('✕ [system/heartbeat] old reminder (user · /evict source:heartbeat)');
  });
});
