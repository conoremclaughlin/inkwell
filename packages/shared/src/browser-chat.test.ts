import { describe, expect, it } from 'vitest';
import { formatBrowserChatMessage, parseBrowserChatPage } from './browser-chat';
const page = {
  id: '11111111-1111-4111-8111-111111111111',
  capturedAt: 1,
  url: 'https://fixture.example/setup',
  title: 'Business setup',
  text: 'Choose a category.',
  truncated: false,
};
describe('browser chat snapshots', () => {
  it('validates and copies the bounded read-only payload', () => {
    expect(parseBrowserChatPage(page)).toEqual(page);
    expect(parseBrowserChatPage(page)).not.toBe(page);
  });
  it('bounds encoded bytes as well as character count', () => {
    expect(() => parseBrowserChatPage({ ...page, text: '\u0000'.repeat(12_000) })).toThrow(
      'too large'
    );
  });
  it.each([
    { ...page, password: 'invented' },
    { ...page, text: 'x'.repeat(12_001) },
    { ...page, url: page.url + '?private=synthetic' },
    { ...page, url: 'https://user:synthetic@fixture.example/' },
    { ...page, url: 'javascript:alert(1)' },
    { ...page, capturedAt: -1 },
  ])('refuses malformed or over-broad data', (input) => {
    expect(() => parseBrowserChatPage(input)).toThrow();
  });
  it('keeps plain chat unchanged and formats snapshots deterministically for retry', () => {
    expect(formatBrowserChatMessage('Hello', undefined, page.id)).toBe('Hello');
    const content = formatBrowserChatMessage(
      'Explain this.',
      { ...page, text: 'A\u200BB' },
      page.id
    );
    expect(content).toBe(
      formatBrowserChatMessage('Explain this.', { ...page, text: 'A\u200BB' }, page.id)
    );
    expect(content).toContain('UNTRUSTED');
    expect(content).toContain('not live page access');
    expect(content).toContain('AB');
    expect(content).not.toContain('\u200B');
  });
});
