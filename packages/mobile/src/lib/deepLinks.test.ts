import { describe, it, expect, vi } from 'vitest';
import { getActionFromState } from '@react-navigation/core';
import { buildDeepLinkPath, parseDeepLink, type DeepLinkTarget } from './deepLinks';

vi.mock('expo-linking', () => ({
  createURL: (path: string) => `exp://127.0.0.1:8092/--${path}`,
  addEventListener: () => ({ remove: () => {} }),
  parse: (url: string) => ({ path: url, queryParams: {} }),
}));

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
    expect(parseDeepLink('/thread/inkwell%3Apr%3A632')).toEqual({
      screen: 'Thread',
      threadKey: 'inkwell:pr:632',
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

/**
 * A prototype key is not a tab.
 *
 * An object lookup answers for inherited keys, so `TABS['constructor']`
 * returned `Object.prototype.constructor` — a function — and `TABS['__proto__']`
 * returned an object. Both are truthy, so both produced a Tabs target whose
 * `tab` was not a screen name at all, and that value went on to the navigator.
 * Only these two appear because `head` is lowercased first, which is exactly
 * the kind of accident that makes the class easy to miss.
 */
describe('prototype keys are not routes', () => {
  it.each(['/constructor', '/__proto__', '/prototype', '/valueOf', '/toString'])(
    'returns null for %o',
    (path) => {
      expect(parseDeepLink(path)).toBeNull();
    }
  );

  it('still routes the real tabs', () => {
    expect(parseDeepLink('/fleet')).toEqual({ screen: 'Tabs', tab: 'Fleet' });
  });
});

/**
 * The state→action seam, against React Navigation's real converter.
 *
 * A link opened while the app is RUNNING must add to what is there, not
 * replace it. React Navigation decides that in getActionFromState: a
 * multi-route state with no `initialRouteName` to anchor it converts to
 * **RESET**, which destroys and rebuilds the navigator. Measured in the
 * simulator before the fix — following a link while on the Fleet tab returned
 * new stack and Tabs keys with the tab index back at 0 — so a half-composed
 * Thread would lose its draft to a notification.
 *
 * Asserting the action type is the whole point: the state shape is identical
 * either way, so nothing about the state alone can tell you which happens.
 */
describe('warm links navigate rather than reset', () => {
  /**
   * Driven through the SHIPPED linking options end to end: a real path goes to
   * production's getStateFromPath, and the state it returns goes to React
   * Navigation's real converter with production's own config. Nothing here is
   * a local copy of either, so breaking production breaks these — which is the
   * only version of this test worth having.
   */
  async function actionForPath(path: string) {
    const { createLinking } = await import('../linking');
    const linking = createLinking(true);
    const state = linking.getStateFromPath!(path, linking.config as never);
    expect(state, `no state for ${path}`).toBeTruthy();
    return getActionFromState(state as never, linking.config as never);
  }

  it.each([
    '/thread/pr:101',
    '/thread/branch:wren/feat/auth',
    '/session/abc',
    '/new-thread',
    '/settings',
    '/fleet',
  ])('%o converts to NAVIGATE, never RESET', async (path) => {
    expect((await actionForPath(path))?.type).toBe('NAVIGATE');
  });

  it('navigates to the target itself, leaving the stack below untouched', async () => {
    expect(await actionForPath('/thread/pr:101')).toMatchObject({
      type: 'NAVIGATE',
      payload: { name: 'Thread', params: { threadKey: 'pr:101' } },
    });
  });

  it('carries the chosen tab through', async () => {
    expect(await actionForPath('/fleet')).toMatchObject({
      type: 'NAVIGATE',
      payload: { params: { screen: 'Fleet' } },
    });
  });

  /**
   * The control. The same production state, converted WITHOUT the anchor, is
   * RESET — so the assertions above are load-bearing rather than describing
   * something React Navigation would have done anyway. It also documents
   * precisely what `initialRouteName` buys, since the state is identical in
   * both cases and only the action differs.
   */
  it('is RESET without initialRouteName, which is the bug being prevented', async () => {
    const { createLinking } = await import('../linking');
    const linking = createLinking(true);
    const state = linking.getStateFromPath!('/thread/pr:101', linking.config as never);
    expect(getActionFromState(state as never)?.type).toBe('RESET');
  });

  it('stays inert when signed out, so a link cannot reach a navigator that is not mounted', async () => {
    const { createLinking } = await import('../linking');
    const linking = createLinking(false);
    expect(linking.getStateFromPath!('/thread/pr:101', linking.config as never)).toBeUndefined();
  });
});

/** The shipped config must be the one the tests above proved. */
describe('the linking config actually used', () => {
  it('anchors on Tabs', async () => {
    const { createLinking } = await import('../linking');
    expect(createLinking(true).config).toMatchObject({ initialRouteName: 'Tabs' });
  });
});
