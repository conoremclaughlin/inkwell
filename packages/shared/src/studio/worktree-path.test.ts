import { describe, expect, it } from 'vitest';
import { isSafeStudioComponent, studioSiblingPath } from './worktree-path.js';

describe('studio path components', () => {
  it.each([
    '',
    '.',
    '..',
    '../outside',
    'a/../../outside',
    '/outside',
    'a\\outside',
    '-flag',
    'name\n',
    'name\r',
    'a\0b',
    'name with spaces',
    'a'.repeat(201),
    null,
    [],
    {},
  ])('rejects invalid names without doing filesystem work: %j', (value) => {
    expect(isSafeStudioComponent(value)).toBe(false);
  });

  it('preserves safe names and the selected repository location', () => {
    for (const name of ['synthetic-agent', 'Agent_2', 'review.1']) {
      expect(isSafeStudioComponent(name)).toBe(true);
      expect(studioSiblingPath('/workspace/repo with spaces', name)).toBe(
        `/workspace/repo with spaces--${name}`
      );
    }
  });

  it('rejects traversal instead of silently renaming the studio', () => {
    expect(() => studioSiblingPath('/workspace/repo', 'a/../../outside')).toThrow(
      'Invalid studio path component'
    );
  });
});
