/**
 * Deep link parsing — URL path to a screen and its params.
 *
 * Kept as a pure function, separate from the React Navigation wiring, because
 * the interesting part is entirely about string handling and deserves tests
 * that do not need a navigator.
 *
 * ## Why this is not just `thread/:threadKey`
 *
 * React Navigation's `:param` matches ONE path segment, and a thread key is
 * not one segment. The key grammar allows slashes — `branch:wren/feat/auth`
 * is a legal key and five of them exist in the live database today — so
 * `thread/branch:wren/feat/auth` would bind `threadKey` to `branch:wren` and
 * silently open the wrong thread, or nothing at all.
 *
 * So `thread/` takes EVERYTHING after it as the key. There is nothing after a
 * thread key in the path grammar, which is what makes that safe.
 *
 * Both spellings work:
 *   inkwell://thread/pr:654                      — readable, fine to type
 *   inkwell://thread/branch:wren/feat/auth       — slashes survive
 *   inkwell://thread?key=branch%3Awren%2Ffeat%2Fauth  — explicit, always safe
 *
 * The query form exists because it is the one a machine should generate: it
 * round-trips any key through `encodeURIComponent` with no reasoning about
 * which characters are special.
 */

export type DeepLinkTarget =
  | { screen: 'Thread'; threadKey: string }
  | { screen: 'Session'; sessionId: string }
  | { screen: 'Tabs'; tab: 'Threads' | 'Chat' | 'Fleet' }
  | { screen: 'NewThread' }
  | { screen: 'Settings' };

const TABS: Record<string, 'Threads' | 'Chat' | 'Fleet'> = {
  threads: 'Threads',
  chat: 'Chat',
  fleet: 'Fleet',
};

/** Decode, tolerating a malformed escape rather than throwing on a bad link. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A stray '%' is a typo, not a reason to crash on launch.
    return value;
  }
}

/**
 * `path` is everything after the scheme prefix, with or without a leading
 * slash, and may carry a query string. Returns null for anything unrecognised
 * — an unknown link opens the app at its default screen, which is friendlier
 * than an error and is what a stale or truncated link deserves.
 */
export function parseDeepLink(path: string): DeepLinkTarget | null {
  if (typeof path !== 'string') return null;

  // Expo Go serves deep links under a `/--/` marker (exp://host:port/--/path).
  // Strip it so the same route table serves Expo Go and a standalone build.
  const withoutGoMarker = path.replace(/^\/?--\//, '/');

  const queryAt = withoutGoMarker.indexOf('?');
  const rawPath = queryAt === -1 ? withoutGoMarker : withoutGoMarker.slice(0, queryAt);
  const query = new URLSearchParams(queryAt === -1 ? '' : withoutGoMarker.slice(queryAt + 1));

  const trimmed = rawPath.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) return null;

  const head = trimmed.split('/')[0].toLowerCase();
  // Deliberately NOT split: the remainder is one value that may contain slashes.
  const rest = trimmed.slice(head.length).replace(/^\//, '');

  if (head === 'thread') {
    const key = (query.get('key') ?? decode(rest)).trim();
    return key ? { screen: 'Thread', threadKey: key } : null;
  }

  if (head === 'session') {
    const id = (query.get('id') ?? decode(rest)).trim();
    return id ? { screen: 'Session', sessionId: id } : null;
  }

  if (head === 'new-thread') return { screen: 'NewThread' };
  if (head === 'settings') return { screen: 'Settings' };

  const tab = TABS[head];
  if (tab) return { screen: 'Tabs', tab };

  return null;
}

/** The inverse, for generating links (notifications, the dashboard, tests). */
export function buildDeepLinkPath(target: DeepLinkTarget): string {
  switch (target.screen) {
    case 'Thread':
      // Always the query form when generating: no judgement call about which
      // characters in the key need escaping.
      return `thread?key=${encodeURIComponent(target.threadKey)}`;
    case 'Session':
      return `session?id=${encodeURIComponent(target.sessionId)}`;
    case 'NewThread':
      return 'new-thread';
    case 'Settings':
      return 'settings';
    case 'Tabs':
      return target.tab.toLowerCase();
  }
}
