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
    getStateFromPath: (path) => {
      if (!isSignedIn) return undefined;
      const target = parseDeepLink(path);
      if (!target) return undefined;

      switch (target.screen) {
        case 'Thread':
          // Pushed ABOVE Tabs rather than replacing it, so a link opened from
          // a notification has somewhere to go back to.
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
