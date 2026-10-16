import { describe, it, expect } from 'vitest';
import { isPlainToolsScope, isSpaceTurnScope } from './token-scope.js';

describe('token scope classifiers', () => {
  it.each([
    ['mcp:tools', true, false],
    ['mcp:tools offline_access', false, false],
    ['  mcp:tools  ', true, false],
    ['mcp:tools mcp:tools', true, false],
    ['mcp:tools mcp:space-turn', false, true],
    ['mcp:space-turn mcp:tools', false, true],
    ['mcp:space-turn', false, true],
    ['mcp:observe', false, false],
    ['mcp:toolsx', false, false],
    ['', false, false],
  ])('"%s" is plain tools: %s, space-turn: %s', (scope, plain, spaceTurn) => {
    expect(isPlainToolsScope(scope)).toBe(plain);
    expect(isSpaceTurnScope(scope)).toBe(spaceTurn);
  });

  it.each([undefined, null, 42, ['mcp:tools'], { scope: 'mcp:tools' }])(
    'reads a non-string scope %j as neither',
    (scope) => {
      expect(isPlainToolsScope(scope)).toBe(false);
      expect(isSpaceTurnScope(scope)).toBe(false);
    }
  );
});
