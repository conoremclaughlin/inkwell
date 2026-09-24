import { describe, expect, it } from 'vitest';
import { isPlausibleEmailAddress, stripTrailingSlashes } from './input-text';
import { slugifyWorkspaceName } from './workspace-slug';

describe('linear input normalization', () => {
  it.each(['reader@example.com', 'reader+tag@sub.example.test'])(
    'accepts a normal email shape: %s',
    (email) => {
      expect(isPlausibleEmailAddress(email)).toBe(true);
    }
  );
  it.each([
    '',
    '@example.com',
    'a@example.',
    'a@.test',
    'a@@example.com',
    'a b@example.com',
    'a@example.com\n',
    'a@' + 'b'.repeat(100_000),
  ])('rejects malformed email shapes', (email) => {
    expect(isPlausibleEmailAddress(email)).toBe(false);
  });
  it('trims only trailing slashes', () => {
    expect(stripTrailingSlashes('https://example.test/path///')).toBe('https://example.test/path');
    expect(stripTrailingSlashes('https://example.test/' + '/'.repeat(100_000))).toBe(
      'https://example.test'
    );
    expect(stripTrailingSlashes('')).toBe('');
    expect(stripTrailingSlashes('///')).toBe('');
  });
  it('keeps workspace slug behavior for long punctuation runs', () => {
    expect(slugifyWorkspaceName('-'.repeat(100_000))).toBe('workspace');
    expect(slugifyWorkspaceName(' A -- Test! ')).toBe('a-test');
    expect(slugifyWorkspaceName('A'.repeat(100))).toBe('a'.repeat(64));
  });
});
