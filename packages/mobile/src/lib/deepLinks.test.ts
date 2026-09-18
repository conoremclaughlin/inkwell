import { describe, it, expect } from 'vitest';
import { buildDeepLinkPath, parseDeepLink, type DeepLinkTarget } from './deepLinks';

describe('parseDeepLink', () => {
  it('opens a thread from a plain key', () => {
    expect(parseDeepLink('/thread/pr:654')).toEqual({ screen: 'Thread', threadKey: 'pr:654' });
  });

  /**
   * The reason this module exists. `:param` in a React Navigation path config
   * matches one segment, and a thread key is not one segment: the grammar
   * allows slashes, and five keys in the live database have them. Binding to
   * the first segment would open `branch:wren` — a different thread, or none.
   */
  it.each([
    ['branch:wren/feat/auth', '/thread/branch:wren/feat/auth'],
    ['branch:wren/fix/a/b/c', '/thread/branch:wren/fix/a/b/c'],
  ])('keeps every slash in %o', (key, path) => {
    expect(parseDeepLink(path)).toEqual({ screen: 'Thread', threadKey: key });
  });

  it('accepts the query form, which is what a generator should emit', () => {
    const key = 'branch:wren/feat/auth';
    expect(parseDeepLink(`/thread?key=${encodeURIComponent(key)}`)).toEqual({
      screen: 'Thread',
      threadKey: key,
    });
  });

  it('prefers an explicit ?key over the path, so the safe form always wins', () => {
    expect(parseDeepLink('/thread/pr:1?key=pr:2')).toEqual({ screen: 'Thread', threadKey: 'pr:2' });
  });

  it('decodes a percent-encoded path key', () => {
    expect(parseDeepLink('/thread/pcp%3Apr%3A632')).toEqual({
      screen: 'Thread',
      threadKey: 'pcp:pr:632',
    });
  });

  // Expo Go serves links as exp://host:port/--/thread/pr:654; the same route
  // table has to serve both runtimes or every link is tested in the wrong one.
  it.each(['--/thread/pr:654', '/--/thread/pr:654'])('strips the Expo Go marker in %o', (path) => {
    expect(parseDeepLink(path)).toEqual({ screen: 'Thread', threadKey: 'pr:654' });
  });

  it('opens a session', () => {
    expect(parseDeepLink('/session/a20d5722')).toEqual({
      screen: 'Session',
      sessionId: 'a20d5722',
    });
  });

  it.each([
    ['/threads', 'Threads'],
    ['/chat', 'Chat'],
    ['/fleet', 'Fleet'],
    ['/Fleet', 'Fleet'],
  ])('routes %o to the %s tab', (path, tab) => {
    expect(parseDeepLink(path)).toEqual({ screen: 'Tabs', tab });
  });

  it('routes the standalone stack screens', () => {
    expect(parseDeepLink('/settings')).toEqual({ screen: 'Settings' });
    expect(parseDeepLink('/new-thread')).toEqual({ screen: 'NewThread' });
  });

  it('tolerates leading and trailing slashes', () => {
    expect(parseDeepLink('///thread/pr:654///')).toEqual({
      screen: 'Thread',
      threadKey: 'pr:654',
    });
  });

  /**
   * Null means "open the app normally". A deep link arrives from outside the
   * app — a stale notification, a truncated paste, someone else's scheme — so
   * an unrecognised one must not be an error state on launch.
   */
  it.each([
    ['', 'empty'],
    ['/', 'root only'],
    ['/nope', 'unknown route'],
    ['/thread', 'thread with no key'],
    ['/thread/', 'thread with an empty key'],
    ['/thread?key=', 'thread with an empty query key'],
    ['/thread/%20%20', 'thread whose key is only whitespace'],
    ['/session', 'session with no id'],
  ])('returns null for %o (%s)', (path) => {
    expect(parseDeepLink(path)).toBeNull();
  });

  it('does not throw on a malformed escape', () => {
    expect(() => parseDeepLink('/thread/%E0%A4%A')).not.toThrow();
    expect(parseDeepLink('/thread/%E0%A4%A')).toEqual({
      screen: 'Thread',
      threadKey: '%E0%A4%A',
    });
  });

  it('survives a non-string, which a native module can hand us', () => {
    expect(parseDeepLink(undefined as unknown as string)).toBeNull();
  });
});

describe('buildDeepLinkPath', () => {
  const cases: DeepLinkTarget[] = [
    { screen: 'Thread', threadKey: 'pr:654' },
    { screen: 'Thread', threadKey: 'branch:wren/feat/auth' },
    { screen: 'Thread', threadKey: 'thread:a b&c=d?e' },
    { screen: 'Session', sessionId: 'a20d5722-f771' },
    { screen: 'NewThread' },
    { screen: 'Settings' },
    { screen: 'Tabs', tab: 'Threads' },
    { screen: 'Tabs', tab: 'Fleet' },
  ];

  // The pair has to agree or generated links open the wrong screen. Testing
  // them against each other is the only check that catches a change to one.
  it.each(cases)('round-trips %o', (target) => {
    expect(parseDeepLink(`/${buildDeepLinkPath(target)}`)).toEqual(target);
  });

  it('escapes a key rather than trusting it to be URL-safe', () => {
    expect(buildDeepLinkPath({ screen: 'Thread', threadKey: 'branch:wren/feat/auth' })).toBe(
      'thread?key=branch%3Awren%2Ffeat%2Fauth'
    );
  });
});
