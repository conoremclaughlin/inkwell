import { describe, expect, it } from 'vitest';
import {
  analyzeClaudePermissionCoverage,
  type ClaudePermissionRuleLists,
} from './claude-permission-audit';

// Synthetic configuration strings only. No settings loader, shell executor,
// provider, credentials, filesystem fixtures, or production barrel is imported.
const STANDARD = [
  'Bash(*)',
  'WebFetch(*)',
  'WebSearch',
  'mcp__sample__*',
  'mcp__browser__*',
] as const;

function observed(overrides: Partial<ClaudePermissionRuleLists> = {}): ClaudePermissionRuleLists {
  return { allow: [], ask: [], deny: [], ...overrides };
}

const NO_FINDINGS = { missingAllow: [], shadowingAsk: [], shadowingDeny: [] };

describe('analyzeClaudePermissionCoverage', () => {
  it('has no built-in mandatory baseline', () => {
    expect(analyzeClaudePermissionCoverage([], observed())).toEqual(NO_FINDINGS);
    expect(
      analyzeClaudePermissionCoverage([], observed({ ask: ['Bash'], deny: ['WebSearch'] }))
    ).toEqual(NO_FINDINGS);
  });

  it('reports absent standards, not extra observed rules', () => {
    expect(
      analyzeClaudePermissionCoverage(
        STANDARD,
        observed({ allow: ['Bash', 'WebSearch', 'mcp__unrelated__*'] })
      )
    ).toEqual({
      missingAllow: ['WebFetch(*)', 'mcp__sample__*', 'mcp__browser__*'],
      shadowingAsk: [],
      shadowingDeny: [],
    });
  });

  it('reports an empty observed allow list in standard order', () => {
    expect(analyzeClaudePermissionCoverage(STANDARD, observed())).toEqual({
      ...NO_FINDINGS,
      missingAllow: [...STANDARD],
    });
  });

  it('finds exact standard coverage without claiming execution authorization', () => {
    expect(analyzeClaudePermissionCoverage(STANDARD, observed({ allow: STANDARD }))).toEqual(
      NO_FINDINGS
    );
  });

  describe('known coverage', () => {
    it.each([
      ['Bash(*)', 'Bash'],
      ['Bash', 'Bash(*)'],
      ['Bash(echo synthetic)', 'Bash(*)'],
      ['Bash(echo synthetic)', 'Bash'],
      ['Bash(git status:*)', 'Bash(git status:*)'],
      ['WebFetch(*)', 'WebFetch'],
      ['WebFetch', 'WebFetch(*)'],
      ['WebFetch(domain:example.com)', 'WebFetch(*)'],
      ['WebSearch', 'WebSearch'],
      ['WebSearch', 'WebSearch(*)'],
      ['WebSearch(*)', 'WebSearch'],
      ['Read(*)', 'Read'],
      ['Read(/**)', 'Read'],
      ['Read(//workspace/example/**)', 'Read'],
      ['Read(//workspace/example/**)', 'Read(//workspace/example/**)'],
      ['Edit(*)', 'Edit'],
      ['Edit(/**)', 'Edit'],
      ['Edit(~/scratch/**)', 'Edit(~/scratch/**)'],
      ['Write(/**)', 'Write'],
      ['Write(*)', 'Write(*)'],
      ['SyntheticTool(pattern)', 'SyntheticTool(pattern)'],
      ['mcp__sample__get_item', 'mcp__sample__get_item'],
      ['mcp__sample__get_item', 'mcp__sample'],
      ['mcp__sample__get_item', 'mcp__sample__*'],
      ['mcp__sample__*', 'mcp__sample'],
      ['mcp__sample', 'mcp__sample__*'],
      ['mcp__sample', 'mcp__sample'],
      ['mcp__sample__*', 'mcp__sample__*'],
      ['mcp__sample-server_2.v1__get-item.v2', 'mcp__sample-server_2.v1__*'],
      ['mcp__sample__nested__tool', 'mcp__sample__*'],
    ])('%s is covered by %s', (expectedRule, allow) => {
      expect(analyzeClaudePermissionCoverage([expectedRule], observed({ allow: [allow] }))).toEqual(
        NO_FINDINGS
      );
    });
  });

  describe('conservative non-coverage', () => {
    it.each([
      ['Bash(*)', 'Bash(git status:*)'],
      ['Bash', 'Bash(git *)'],
      ['Bash(git status)', 'Bash(git *)'],
      ['Bash(git status:*)', 'Bash(git status *)'],
      ['Bash(*)', 'bash(*)'],
      ['WebFetch(*)', 'WebFetch(domain:example.com)'],
      ['WebSearch', 'WebFetch(*)'],
      ['Read(*)', 'Read(/**)'],
      ['Read(/**)', 'Read(*)'],
      ['Read', 'Read(*)'],
      ['Read', 'Read(/**)'],
      ['Edit(*)', 'Edit(/**)'],
      ['Edit(/**)', 'Edit(*)'],
      ['Edit', 'Edit(/**)'],
      ['Write', 'Write(*)'],
      ['Edit(*)', 'Write(*)'],
      ['Read(~/scratch/**)', 'Read(*)'],
      ['Read(//workspace/example/**)', 'Read(/**)'],
      ['Edit(//workspace/example/**)', 'Edit(//workspace/other/**)'],
      ['Read(//workspace/example/a.txt)', 'Read(//workspace/example/**)'],
      ['SyntheticTool', 'SyntheticTool(*)'],
      ['mcp__sample__*', 'mcp__sample__get_item'],
      ['mcp__sample', 'mcp__sample__get_item'],
      ['mcp__sample__get_item', 'mcp__sample__other_item'],
      ['mcp__sample__get_item', 'mcp__other__get_item'],
      ['mcp__sample__get_item', 'mcp__sample2__*'],
      ['mcp__Sample__get_item', 'mcp__sample__*'],
      ['mcp__sample__get_item', 'mcp__*'],
      ['mcp__sample__*', 'mcp__*'],
      ['mcp__sample__get_item', 'mcp__*__get_item'],
      ['mcp__sample__get_item', 'mcp__sample*'],
      ['mcp__sample__get_item', 'mcp__sample__get_*'],
      ['mcp__sample__get_item', 'mcp__sample__**'],
      ['mcp__sample__get_item', 'mcp__sample__get_item(*)'],
      ['mcp__sample__get_item', 'mcp__sample__'],
      ['mcp__sample__get_item', 'mcp__sample__*\n'],
      ['Bash(*)', ' Bash(*)'],
      ['Bash(*)', 'Bash(*) '],
      ['Bash(*)', 'Bash(*)\n'],
      ['Bash(*)', 'Bash()'],
      ['Bash(*)', '*'],
    ])('%s is not known to be covered by %s', (expectedRule, allow) => {
      expect(analyzeClaudePermissionCoverage([expectedRule], observed({ allow: [allow] }))).toEqual(
        { ...NO_FINDINGS, missingAllow: [expectedRule] }
      );
    });

    it('does not turn an enumeration of tools into a namespace grant', () => {
      expect(
        analyzeClaudePermissionCoverage(
          ['mcp__sample__*'],
          observed({ allow: ['mcp__sample__get_item', 'mcp__sample__list_items'] })
        ).missingAllow
      ).toEqual(['mcp__sample__*']);
    });

    it.each(['', '*', 'mcp__*', 'mcp__*__*', 'mcp__sample__get_*', 'Bash()', 'Bash(*) '])(
      'does not infer coverage from identical unsupported expected/observed strings: %s',
      (rule) => {
        expect(
          analyzeClaudePermissionCoverage([rule], observed({ allow: [rule] })).missingAllow
        ).toEqual([rule]);
      }
    );
  });

  describe.each(['ask', 'deny'] as const)('%s shadows', (effect) => {
    const findingKey = effect === 'ask' ? 'shadowingAsk' : 'shadowingDeny';

    it.each([
      ['Bash(*)', 'Bash'],
      ['Bash', 'Bash(*)'],
      ['Bash(git status)', 'Bash(git status)'],
      ['Bash(git status)', 'Bash(*)'],
      ['WebSearch', 'WebSearch'],
      ['WebSearch', 'WebSearch(*)'],
      ['WebFetch(*)', 'WebFetch'],
      ['Read(/**)', 'Read'],
      ['Read(*)', 'Read(*)'],
      ['Edit(/**)', 'Edit(/**)'],
      ['mcp__sample__*', 'mcp__sample'],
      ['mcp__sample', 'mcp__sample__*'],
      ['mcp__sample__get_item', 'mcp__sample'],
      ['mcp__sample__get_item', 'mcp__sample__*'],
      ['mcp__sample__get_item', 'mcp__sample__get_item'],
    ])(
      'reports a full shadow of %s by %s independently of allow presence',
      (expectedRule, rule) => {
        for (const allow of [[], [expectedRule]]) {
          expect(
            analyzeClaudePermissionCoverage([expectedRule], observed({ allow, [effect]: [rule] }))
          ).toEqual({
            ...NO_FINDINGS,
            missingAllow: allow.length === 0 ? [expectedRule] : [],
            [findingKey]: [{ expectedRule, rule, overlap: 'full' }],
          });
        }
      }
    );

    it.each(['mcp__sample', 'mcp__sample__*'])(
      'reports an exact tool as a partial shadow of namespace %s',
      (expectedRule) => {
        const rule = 'mcp__sample__get_item';
        expect(
          analyzeClaudePermissionCoverage(
            [expectedRule],
            observed({ allow: [expectedRule], [effect]: [rule] })
          )
        ).toEqual({
          ...NO_FINDINGS,
          [findingKey]: [{ expectedRule, rule, overlap: 'partial' }],
        });
      }
    );

    it('still reports partial MCP shadows when a namespace allow is missing', () => {
      const expectedRule = 'mcp__sample__*';
      const rule = 'mcp__sample__get_item';
      expect(
        analyzeClaudePermissionCoverage([expectedRule], observed({ [effect]: [rule] }))
      ).toEqual({
        ...NO_FINDINGS,
        missingAllow: [expectedRule],
        [findingKey]: [{ expectedRule, rule, overlap: 'partial' }],
      });
    });

    it.each([
      ['Read', 'Read(~/scratch/private/**)'],
      ['WebFetch(*)', 'WebFetch(domain:example.com)'],
    ])('reports known narrower scopes of %s separately: %s', (expectedRule, rule) => {
      expect(
        analyzeClaudePermissionCoverage(
          [expectedRule],
          observed({ allow: [expectedRule], [effect]: [rule] })
        )
      ).toEqual({
        ...NO_FINDINGS,
        [findingKey]: [{ expectedRule, rule, overlap: 'partial' }],
      });
    });

    it('does not report unrelated servers, tools, or unsupported MCP wildcards as shadows', () => {
      expect(
        analyzeClaudePermissionCoverage(
          ['mcp__sample__get_item'],
          observed({
            allow: ['mcp__sample'],
            [effect]: [
              'mcp__other__get_item',
              'mcp__sample2__*',
              'mcp__sample__other_item',
              'mcp__*',
              'mcp__sample__get_*',
              'Bash',
            ],
          })
        )
      ).toEqual(NO_FINDINGS);
    });
  });

  it.each(['Bash', 'Bash(*)'])(
    'does not turn narrow Bash policy backstops into missing coverage or shadows of %s',
    (expectedRule) => {
      expect(
        analyzeClaudePermissionCoverage(
          [expectedRule],
          observed({
            allow: ['Bash(*)'],
            // These are inert strings, never commands passed to an executor.
            deny: ['Bash(rm -rf *)', 'Bash(git push --force *)', 'Bash(git reset --hard *)'],
          })
        )
      ).toEqual(NO_FINDINGS);
    }
  );

  it('does not count narrow Bash denies as an allow when blanket Bash is absent', () => {
    expect(
      analyzeClaudePermissionCoverage(['Bash(*)'], observed({ deny: ['Bash(rm -rf *)'] }))
    ).toEqual({ ...NO_FINDINGS, missingAllow: ['Bash(*)'] });
  });

  it('reports a narrower Bash ask as a possible prompt, not a missing blanket allow', () => {
    expect(
      analyzeClaudePermissionCoverage(
        ['Bash(*)'],
        observed({ allow: ['Bash'], ask: ['Bash(git status)'] })
      )
    ).toEqual({
      ...NO_FINDINGS,
      shadowingAsk: [{ expectedRule: 'Bash(*)', rule: 'Bash(git status)', overlap: 'partial' }],
    });
  });

  it('retains asks and denies even when the same allow is shadowed by both', () => {
    const expectedRule = 'mcp__sample__*';
    expect(
      analyzeClaudePermissionCoverage(
        [expectedRule],
        observed({ allow: [expectedRule], ask: [expectedRule], deny: ['mcp__sample__get_item'] })
      )
    ).toEqual({
      missingAllow: [],
      shadowingAsk: [{ expectedRule, rule: expectedRule, overlap: 'full' }],
      shadowingDeny: [{ expectedRule, rule: 'mcp__sample__get_item', overlap: 'partial' }],
    });
  });

  it('deduplicates exact strings without reordering or replacing the authored spelling', () => {
    const expectedRule = 'mcp__sample';
    const deny = 'mcp__sample__get_item';
    expect(
      analyzeClaudePermissionCoverage(
        [expectedRule, 'WebSearch', expectedRule, 'WebSearch'],
        observed({ ask: ['WebSearch', 'WebSearch'], deny: [deny, deny, 'mcp__sample__*'] })
      )
    ).toEqual({
      missingAllow: [expectedRule, 'WebSearch'],
      shadowingAsk: [{ expectedRule: 'WebSearch', rule: 'WebSearch', overlap: 'full' }],
      shadowingDeny: [
        { expectedRule, rule: deny, overlap: 'partial' },
        { expectedRule, rule: 'mcp__sample__*', overlap: 'full' },
      ],
    });
  });

  it('accepts frozen inputs and returns independent, deterministic result arrays', () => {
    const expected = Object.freeze(['mcp__sample__*', 'WebSearch']);
    const rules = Object.freeze({
      allow: Object.freeze(['mcp__sample']),
      ask: Object.freeze(['mcp__sample__get_item']),
      deny: Object.freeze(['WebSearch']),
    });
    const first = analyzeClaudePermissionCoverage(expected, rules);
    const second = analyzeClaudePermissionCoverage(expected, rules);
    expect(first).toEqual(second);
    first.missingAllow.push('synthetic-mutation');
    first.shadowingAsk[0].rule = 'synthetic-mutation';
    first.shadowingDeny.length = 0;
    expect(analyzeClaudePermissionCoverage(expected, rules)).toEqual(second);
    expect(expected).toEqual(['mcp__sample__*', 'WebSearch']);
    expect(rules).toEqual({
      allow: ['mcp__sample'],
      ask: ['mcp__sample__get_item'],
      deny: ['WebSearch'],
    });
  });
});
