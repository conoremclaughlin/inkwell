import { describe, expect, it } from 'vitest';
import { threadMessagesPath } from './paths.js';

describe('threadMessagesPath', () => {
  it('asks for the newest page by key', () => {
    expect(threadMessagesPath('pr:670')).toBe('/api/admin/threads/messages?key=pr%3A670');
  });

  it('asks for the page before a message', () => {
    expect(threadMessagesPath('pr:670', 'b2c1')).toBe(
      '/api/admin/threads/messages?key=pr%3A670&before=b2c1'
    );
  });

  it('keeps a key with its own separators in one parameter', () => {
    // A cross-project key carries colons and a slash-bearing branch name.
    expect(threadMessagesPath('inktrade:branch:wren/feat/x&y')).toBe(
      '/api/admin/threads/messages?key=inktrade%3Abranch%3Awren%2Ffeat%2Fx%26y'
    );
  });
});
