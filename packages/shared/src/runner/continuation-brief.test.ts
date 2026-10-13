import { describe, expect, it } from 'vitest';
import {
  buildIdleCompactionPrompt,
  CONTINUATION_BRIEF_SECTIONS,
  renderContinuationBriefTemplate,
} from './continuation-brief.js';

describe('the continuation-brief template', () => {
  it('numbers every section in order', () => {
    const template = renderContinuationBriefTemplate();
    const positions = CONTINUATION_BRIEF_SECTIONS.map((section, i) =>
      template.indexOf(`${i + 1}. ${section.title}:`)
    );
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('keeps the reply route and unknown effects in the brief', () => {
    const template = renderContinuationBriefTemplate();
    expect(template).toContain('channel and conversation id');
    expect(template).toContain('never record an effect as done without its confirmation');
  });
});

describe('buildIdleCompactionPrompt', () => {
  const prompt = buildIdleCompactionPrompt({
    providerContextTokens: 292_481,
    cacheTtlSeconds: 300,
  });

  it('says why now, in the measured size and the cache it is about to lose', () => {
    expect(prompt.startsWith('[IDLE COMPACTION]')).toBe(true);
    expect(prompt).toContain('about 292k tokens');
    expect(prompt).toContain('5-minute prompt cache');
  });

  it('carries the template and the call that commits it', () => {
    expect(prompt).toContain(renderContinuationBriefTemplate());
    expect(prompt).toContain('Call compact_context with the brief as `summary`');
  });

  it('leaves the context as it is when the compaction is refused', () => {
    expect(prompt).toContain(
      'If compact_context refuses, do not retry and do not trim anything else'
    );
  });
});
