import { describe, expect, it } from 'vitest';
import { inkSessionOptions } from './ink-session-options.js';

describe('tier-derived headless session options', () => {
  it('refuses the tools tier without an isolated policy path', () => {
    expect(() =>
      inkSessionOptions({ workingDirectory: '/synthetic/studio', executionTier: 'tools' })
    ).toThrow('The tools tier needs a tool policy of its own');
  });

  it('requires the tools profile for every tools-tier SB, independent of its slug', () => {
    expect(
      inkSessionOptions({
        workingDirectory: '/synthetic/studio',
        sbSlug: 'echo',
        executionTier: 'tools',
        toolPolicyPath: '/synthetic/own-policy.json',
      })
    ).toMatchObject({
      profile: 'tools',
      requireProfile: 'tools',
      toolPolicyPath: '/synthetic/own-policy.json',
      withholdProviderTools: true,
    });
  });

  it.each(['full', undefined] as const)('does not infer the %s tier from a policy path', (tier) => {
    const options = inkSessionOptions({
      workingDirectory: '/synthetic/studio',
      executionTier: tier,
      toolPolicyPath: '/synthetic/unused-policy.json',
    });
    expect(options).toMatchObject({ profile: 'safe', withholdProviderTools: false });
    expect(options).not.toHaveProperty('requireProfile');
    expect(options).not.toHaveProperty('toolPolicyPath');
  });
});
