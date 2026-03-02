import { describe, expect, it } from 'vitest';
import {
  isOlderThan5Days,
  LiveStatusLane,
  renderCollapsedInbox,
  renderMessageLine,
  renderResumeHistoryLines,
  renderTimedBlock,
  rightAlign,
  separator,
  stripAnsi,
} from './tui-components.js';

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

  it('builds a prompt label with status + info dock sections', () => {
    const lane = new LiveStatusLane(true, 'America/Los_Angeles');
    lane.setPromptActive(true);
    lane.renderSummary('context:99/100 queue:idle');
    lane.setInfoItems(['/help', 'ctrl+c twice to quit']);

    const prompt = stripAnsi(lane.buildPromptLabel('wren> '));
    expect(prompt).toContain('context:99/100 queue:idle');
    expect(prompt).toContain('wren> ');
    expect(prompt).toContain('/help');
    expect(prompt).toContain('ctrl+c twice to quit');
    // Should contain separator lines
    expect(prompt).toContain('─');
  });

  it('places prompt on the last line of the dock', () => {
    const lane = new LiveStatusLane(true, 'America/Los_Angeles');
    lane.renderSummary('status');
    const prompt = stripAnsi(lane.buildPromptLabel('wren> '));
    const lines = prompt.split('\n');
    expect(lines[lines.length - 1]).toContain('wren> ');
  });

  it('uses provided event timestamp for timed blocks', () => {
    const rendered = stripAnsi(
      renderTimedBlock('hello', 'America/Los_Angeles', '2026-02-26T04:09:14.000Z')
    );
    expect(rendered).toContain('hello');
    expect(rendered).toContain('8:09:14');
  });

  it('appends trailing metadata after timestamp when provided', () => {
    const rendered = stripAnsi(
      renderTimedBlock('hello', 'America/Los_Angeles', '2026-02-26T04:09:14.000Z', '5s')
    );
    expect(rendered).toContain('8:09:14');
    expect(rendered).toContain('• 5s');
  });
});

describe('layout primitives', () => {
  it('separator returns correct width', () => {
    const sep = stripAnsi(separator(40));
    expect(sep).toBe('─'.repeat(40));
  });

  it('rightAlign pads between left and right text', () => {
    const result = stripAnsi(rightAlign('left', 'right', 20));
    // 20 - 4 (left) - 5 (right) = 11 gap
    expect(result).toContain('left');
    expect(result).toContain('right');
    expect(result.length).toBe(20);
  });

  it('renderMessageLine formats user message with label', () => {
    const line = stripAnsi(renderMessageLine('user', 'hello world', { label: 'you' }));
    expect(line).toContain('you');
    expect(line).toContain('hello world');
  });

  it('renderMessageLine formats inbox message with label', () => {
    const line = stripAnsi(renderMessageLine('inbox', 'task ping', { label: '📥 lumen' }));
    expect(line).toContain('📥 lumen');
    expect(line).toContain('task ping');
  });

  it('renderCollapsedInbox shows count and label', () => {
    const result = stripAnsi(renderCollapsedInbox(3));
    expect(result).toContain('3 older inbox messages (>5d) collapsed');
    expect(result).toContain('┄');
  });

  it('renderCollapsedInbox singular form for count=1', () => {
    const result = stripAnsi(renderCollapsedInbox(1));
    expect(result).toContain('1 older inbox message (>5d) collapsed');
  });

  it('isOlderThan5Days returns true for old dates', () => {
    const old = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    expect(isOlderThan5Days(old)).toBe(true);
  });

  it('isOlderThan5Days returns false for recent dates', () => {
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    expect(isOlderThan5Days(recent)).toBe(false);
  });

  it('isOlderThan5Days returns false for undefined', () => {
    expect(isOlderThan5Days(undefined)).toBe(false);
  });
});
