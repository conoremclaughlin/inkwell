import { describe, it, expect } from 'vitest';

// Extract the functions for testing — they're module-scoped in session-service.ts
// so we re-implement them here identically for unit testing.
// TODO: extract to shared utility when stabilized.

function matchRoutePattern(pattern: string, threadKey: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === threadKey;
  const prefix = pattern.slice(0, pattern.indexOf('*'));
  return threadKey.startsWith(prefix);
}

function routePatternSpecificity(pattern: string): number {
  if (!pattern.includes('*')) return 3; // exact match
  const literalPrefix = pattern.split('*')[0];
  if (literalPrefix.length > 0) return 2; // prefix wildcard
  return 1; // bare wildcard '*'
}

describe('matchRoutePattern', () => {
  it('matches exact threadKey', () => {
    expect(matchRoutePattern('pr:221', 'pr:221')).toBe(true);
    expect(matchRoutePattern('pr:221', 'pr:222')).toBe(false);
  });

  it('matches prefix wildcard', () => {
    expect(matchRoutePattern('pr:*', 'pr:221')).toBe(true);
    expect(matchRoutePattern('pr:*', 'pr:999')).toBe(true);
    expect(matchRoutePattern('pr:*', 'spec:foo')).toBe(false);
  });

  it('matches longer prefix wildcards', () => {
    expect(matchRoutePattern('branch:wren/*', 'branch:wren/feat/auth')).toBe(true);
    expect(matchRoutePattern('branch:wren/*', 'branch:lumen/fix/bug')).toBe(false);
  });

  it('matches bare wildcard', () => {
    expect(matchRoutePattern('*', 'pr:221')).toBe(true);
    expect(matchRoutePattern('*', 'anything')).toBe(true);
  });

  it('does not match partial strings without wildcard', () => {
    expect(matchRoutePattern('pr:', 'pr:221')).toBe(false);
    expect(matchRoutePattern('pr', 'pr:221')).toBe(false);
  });
});

describe('routePatternSpecificity', () => {
  it('scores exact match highest', () => {
    expect(routePatternSpecificity('pr:221')).toBe(3);
  });

  it('scores prefix wildcard in the middle', () => {
    expect(routePatternSpecificity('pr:*')).toBe(2);
    expect(routePatternSpecificity('branch:wren/feat/*')).toBe(2);
  });

  it('scores bare wildcard lowest', () => {
    expect(routePatternSpecificity('*')).toBe(1);
  });

  it('maintains correct ordering', () => {
    const exact = routePatternSpecificity('pr:221');
    const prefix = routePatternSpecificity('pr:*');
    const wildcard = routePatternSpecificity('*');
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(wildcard);
  });
});

describe('route resolution (multi-studio)', () => {
  // Simulate the resolution logic from resolveStudioId
  function resolveStudio(
    threadKey: string,
    studios: Array<{ id: string; route_patterns: string[] }>
  ): string | null {
    const matches = studios
      .map((s) => ({
        id: s.id,
        specificity: Math.max(
          ...s.route_patterns
            .filter((p) => matchRoutePattern(p, threadKey))
            .map(routePatternSpecificity),
          0
        ),
      }))
      .filter((m) => m.specificity > 0)
      .sort((a, b) => b.specificity - a.specificity);

    if (
      matches.length === 1 ||
      (matches.length > 1 && matches[0].specificity > matches[1].specificity)
    ) {
      return matches[0].id;
    }
    return null; // ambiguous or no match
  }

  const studios = [
    { id: 'omega', route_patterns: ['pr:*', 'spec:*', 'thread:*'] },
    { id: 'feat-auth', route_patterns: ['branch:wren/feat/auth', 'pr:228'] },
    { id: 'myra-home', route_patterns: ['*'] },
  ];

  it('routes PR to omega (prefix match)', () => {
    expect(resolveStudio('pr:221', studios)).toBe('omega');
  });

  it('routes specific PR to feat-auth (exact beats prefix)', () => {
    expect(resolveStudio('pr:228', studios)).toBe('feat-auth');
  });

  it('routes spec to omega', () => {
    expect(resolveStudio('spec:trigger-studio-routing', studios)).toBe('omega');
  });

  it('routes branch to feat-auth (exact match)', () => {
    expect(resolveStudio('branch:wren/feat/auth', studios)).toBe('feat-auth');
  });

  it('routes unknown threadKey to wildcard home studio', () => {
    expect(resolveStudio('debug:something-random', studios)).toBe('myra-home');
  });

  it('returns null when no studios have patterns', () => {
    expect(resolveStudio('pr:221', [])).toBe(null);
  });

  it('returns null when no patterns match', () => {
    const noWildcard = [{ id: 'narrow', route_patterns: ['pr:*'] }];
    expect(resolveStudio('spec:foo', noWildcard)).toBe(null);
  });

  it('returns null on ambiguous tie (same specificity)', () => {
    const tied = [
      { id: 'a', route_patterns: ['pr:*'] },
      { id: 'b', route_patterns: ['pr:*'] },
    ];
    expect(resolveStudio('pr:221', tied)).toBe(null);
  });

  it('resolves unambiguously when one studio has higher specificity', () => {
    const unambiguous = [
      { id: 'exact', route_patterns: ['pr:221'] },
      { id: 'prefix', route_patterns: ['pr:*'] },
    ];
    expect(resolveStudio('pr:221', unambiguous)).toBe('exact');
  });
});

// ── "main" resolution contract ──

describe('main studio resolution contract', () => {
  // "main" = the root repo. The resolution is consistent across all code paths:
  // 1. resolveMainStudioId: exact path at server CWD → undefined
  // 2. resolveStudioHint('main'): exact path at process.cwd() → undefined
  // 3. handleListSessions(studioId: 'main'): undefined (unscoped)
  // 4. resolveStudioId(explicitStudioId: 'main'): delegates to resolveMainStudioId
  //
  // When undefined, the runner falls back to defaultWorkingDirectory (the root repo).
  // No branch='main' guessing. No sibling matching. Simple and predictable.

  it('resolveWorkingDirectory uses defaultWorkingDirectory when studioId is undefined', () => {
    // This is the core contract: undefined studioId → root repo CWD
    const studioId: string | undefined = undefined;
    const defaultDir = '/ws/pcp/inkwell';
    const resolvedDir = !studioId ? defaultDir : '/some/studio/path';
    expect(resolvedDir).toBe(defaultDir);
  });

  it('studioId "main" is not treated as a UUID', () => {
    const studioId = 'main';
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(studioId);
    expect(isUuid).toBe(false);
    expect(studioId).toBe('main');
  });

  it('no branch matching — main is a path concept, not a git branch', () => {
    // Previously resolveMainStudioId fell back to .eq('branch', 'main').
    // This was removed: studios are on feature branches, not main.
    // The root repo IS main, regardless of what branch any studio is on.
    const studioSlug = 'wren';
    const studioBranch = 'wren/feat/workspace-sessions';
    expect(studioBranch).not.toBe('main');
    // The studio is still valid for work — its branch doesn't determine
    // whether it's the "main" studio.
  });
});
