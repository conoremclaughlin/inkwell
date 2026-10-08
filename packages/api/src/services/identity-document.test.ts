import { describe, expect, it } from 'vitest';
import {
  identityDocument,
  ownRelationships,
  ownValues,
  ownValuesAndRelationships,
} from './identity-document';

describe('an SB’s own values and relationships', () => {
  it('renders the description, then the values, then the relationships, in stored order', () => {
    expect(
      identityDocument({
        description: 'I review carefully.',
        values: ['Precision', 'Care'],
        relationships: { wren: 'A sibling I review with', conor: 'Who I work with' },
      })
    ).toBe(
      [
        'I review carefully.',
        '',
        '## My values',
        '',
        '- Precision',
        '- Care',
        '',
        '## My relationships',
        '',
        '- **wren:** A sibling I review with',
        '- **conor:** Who I work with',
      ].join('\n')
    );
  });

  it('keeps an empty record empty: no headings with nothing under them', () => {
    expect(ownValuesAndRelationships({ values: [], relationships: {} })).toBeNull();
    expect(identityDocument({ description: null, values: [], relationships: {} })).toBeNull();
    expect(identityDocument({ description: 'Only this.' })).toBe('Only this.');
  });

  it('renders values and relationships without a description', () => {
    expect(identityDocument({ values: ['Curiosity'] })).toBe('## My values\n\n- Curiosity');
  });

  it('skips what is not text, and blanks', () => {
    expect(ownValues(['Kept', 3, null, '  ', { v: 1 }, ' Trimmed '])).toEqual(['Kept', 'Trimmed']);
    expect(ownValues('not a list')).toEqual([]);
    expect(ownRelationships({ myra: 'Sister', lumen: 7, ' ': 'nobody', aster: ' ' })).toEqual([
      ['myra', 'Sister'],
    ]);
    expect(ownRelationships(['myra'])).toEqual([]);
    expect(ownRelationships(null)).toEqual([]);
  });
});
