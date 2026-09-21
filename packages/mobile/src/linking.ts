import * as Linking from 'expo-linking';
import type { LinkingOptions } from '@react-navigation/native';
import { parseDeepLink } from './lib/deepLinks';
import type { RootStackParamList } from './navigation';

/**
 * Deep links into the signed-in app.
 *
 * `Linking.createURL('/')` yields whatever prefix this runtime actually uses —
 * `inkwell://` in a standalone build, `exp://<host>:<port>/--/` under Expo Go —
 * so the same links work in both without the caller knowing which one it is.
 * The literal `inkwell://` is listed as well so a link typed by hand (or fired
 * by `xcrun simctl openurl`) works in a standalone build even when the
 * generated prefix differs.
 *
 * Path parsing lives in lib/deepLinks, and this file hands it the whole path
 * rather than using React Navigation's `config.screens` map. That is not
 * stylistic: a `:param` matches a single path segment, and thread keys contain
 * slashes (`branch:wren/feat/auth`), so the declarative form silently opens the
 * wrong thread. See that module's header.
 */

export const DEEP_LINK_SCHEME = 'inkwell';

/**
 * Routes are only linkable while signed in — every target below lives in the
 * authenticated navigator. Following a link into a navigator that is not
 * mounted does nothing useful, so when signed out we return undefined and the
 * app opens at Login. The link is not lost in any meaningful sense: it can be
 * followed again once there is a session.
 */
export function createLinking(isSignedIn: boolean): LinkingOptions<RootStackParamList> {
  return {
    prefixes: [Linking.createURL('/'), `${DEEP_LINK_SCHEME}://`],

    /**
     * `initialRouteName` is what keeps a link from wiping the app.
     *
     * React Navigation converts the state below into an action via
     * getActionFromState. Without a config naming the first route, a
     * two-route state has no anchor, so the conversion emits **RESET** with
     * both routes — which on a running app destroys and rebuilds the whole
     * navigator. Measured 2026-09-17: following a link while on the Fleet tab
     * came back with new stack and Tabs keys and the tab index at 0, so the
     * user lost their place, and a Thread being composed would lose its draft
     * with it.
     *
     * With `initialRouteName: 'Tabs'`, the same state converts to **NAVIGATE**
     * to the target alone, which pushes onto what is already there. `screens`
     * is required by the type and stays empty: the path map is not used, since
     * getStateFromPath below owns parsing.
     *
     * Pinned in deepLinks.test.ts against the real getActionFromState rather
     * than against a belief about it.
     */
    config: { initialRouteName: 'Tabs', screens: {} },

    getStateFromPath: (path) => {
      if (!isSignedIn) return undefined;
      const target = parseDeepLink(path);
      if (!target) return undefined;

      switch (target.screen) {
        case 'Thread':
          // Tabs first so a cold launch has somewhere to go back to, and so
          // the conversion above has its anchor.
          return {
            routes: [{ name: 'Tabs' }, { name: 'Thread', params: { threadKey: target.threadKey } }],
          };
        case 'Session':
          return {
            routes: [
              { name: 'Tabs' },
              { name: 'Session', params: { sessionId: target.sessionId } },
            ],
          };
        case 'NewThread':
          return { routes: [{ name: 'Tabs' }, { name: 'NewThread' }] };
        case 'Settings':
          return { routes: [{ name: 'Tabs' }, { name: 'Settings' }] };
        case 'Tabs':
          return { routes: [{ name: 'Tabs', state: { routes: [{ name: target.tab }] } }] };
      }
    },
  };
}
