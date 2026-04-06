import { describe, expect, it } from 'vitest';
import {
  compilePolicyPattern,
  expandPolicySpecs,
  matchesAnyPolicyPattern,
  matchesPolicyPattern,
  normalizePolicyToken,
} from '@inklabs/shared';

describe('shared tool policy core', () => {
  it('normalizes tokens', () => {
    expect(normalizePolicyToken('  Send_To_Inbox  ')).toBe('send_to_inbox');
  });

  it('matches wildcard patterns', () => {
    expect(matchesPolicyPattern('send_to_inbox', 'send_*')).toBe(true);
    expect(matchesPolicyPattern('send_to_inbox', 'trigger_*')).toBe(false);
    expect(compilePolicyPattern('*')?.test('anything')).toBe(true);
    expect(compilePolicyPattern('')?.test('anything')).toBeUndefined();
  });

  it('matches against a pattern set', () => {
    expect(matchesAnyPolicyPattern('send_to_inbox', ['trigger_*', 'send_*'])).toBe(true);
    expect(matchesAnyPolicyPattern('remember', ['trigger_*', 'send_*'])).toBe(false);
  });

  it('expands policy group specs', () => {
    const expanded = expandPolicySpecs(['group:pcp-comms', 'remember'], {
      'group:pcp-comms': ['send_to_inbox', 'trigger_agent'],
    });
    expect(expanded).toContain('send_to_inbox');
    expect(expanded).toContain('trigger_agent');
    expect(expanded).toContain('remember');
  });

  it('dedupes and ignores empty policy specs', () => {
    const expanded = expandPolicySpecs(['', 'group:pcp-comms', 'send_to_inbox'], {
      'group:pcp-comms': ['send_to_inbox', 'trigger_agent'],
    });
    expect(expanded).toEqual(['send_to_inbox', 'trigger_agent']);
  });
});
