import { describe, expect, it } from 'vitest';
import { LiveStatusLane, renderResumeHistoryLines } from './tui-components.js';

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('tui-components', () => {
  it('formats resume history preview lines by role', () => {
    const lines = renderResumeHistoryLines(
      [
        { role: 'user', content: 'hello there', ts: '2026-02-26T01:00:00.000Z' },
        { role: 'assistant', content: 'hey!', ts: '2026-02-26T01:00:02.000Z' },
        { role: 'inbox', content: 'task ping', ts: '2026-02-26T01:00:03.000Z' },
      ],
      'America/Los_Angeles'
    ).map(stripAnsi);

    expect(lines[0]).toContain('user:');
    expect(lines[0]).toContain('hello there');
    expect(lines[1]).toContain('assistant:');
    expect(lines[1]).toContain('hey!');
    expect(lines[2]).toContain('inbox:');
    expect(lines[2]).toContain('task ping');
  });

  it('tracks prompt-dirty status while live prompt is active', () => {
    const lane = new LiveStatusLane(true, 'America/Los_Angeles');
    lane.setPromptActive(true);
    lane.renderSummary('context:42/100');
    expect(lane.shouldRefreshAfterPrompt()).toBe(true);
    lane.markPromptRefreshed();
    expect(lane.shouldRefreshAfterPrompt()).toBe(false);
  });

  it('builds a three-line prompt label with status and hint lanes', () => {
    const lane = new LiveStatusLane(true, 'America/Los_Angeles');
    lane.setPromptActive(true);
    lane.renderSummary('context:99/100 queue:idle');
    lane.setHint('Press Ctrl+C again to quit');

    const prompt = stripAnsi(lane.buildPromptLabel('wren> '));
    expect(prompt).toContain('status> context:99/100 queue:idle');
    expect(prompt).toContain('hint> Press Ctrl+C again to quit');
    expect(prompt).toContain('wren> ');
  });
});
