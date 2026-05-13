import { describe, expect, it } from 'vitest';
import { answerTokenCoverage, hasAnswer, hasOptionalAnswer } from './benchmark-answer-coverage';

describe('benchmark answer coverage', () => {
  it('matches exact normalized answer phrases', () => {
    expect(hasAnswer('The user now has 38 pre-1920 coins.', '38')).toBe(true);
    expect(
      answerTokenCoverage('The latest plan is sibling review before merge.', 'sibling review')
    ).toBe(1);
  });

  it('does not match short numeric answers inside opaque identifiers', () => {
    expect(hasAnswer('memoryId=mem38 sessionId=s38 durableFactCount=1', '38')).toBe(false);
  });

  it('returns null for absent optional answers', () => {
    expect(hasOptionalAnswer('anything', undefined)).toBeNull();
    expect(hasOptionalAnswer('anything', '')).toBeNull();
  });
});
