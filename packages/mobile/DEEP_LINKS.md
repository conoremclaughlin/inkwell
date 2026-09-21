# Deep links

The app registers the `inkwell` URL scheme, so any screen can be opened from
outside it: a notification, the dashboard, a chat message, or a terminal.

## The links

| Link                                                       | Opens                                       |
| ---------------------------------------------------------- | ------------------------------------------- |
| `inkwell://thread/pr:654`                                  | that thread, with a back button to the tabs |
| `inkwell://thread?key=branch%3Awren%2Ffeat%2Fauth`         | same, for any key at all                    |
| `inkwell://session/<id>`                                   | a session transcript                        |
| `inkwell://threads` · `inkwell://chat` · `inkwell://fleet` | that tab                                    |
| `inkwell://new-thread` · `inkwell://settings`              | those screens                               |

Anything unrecognised opens the app normally rather than erroring — a deep
link arrives from outside, so a stale or truncated one should be harmless.
Links only resolve while signed in; followed while signed out, the app opens
at Login and the link can be followed again afterwards.

## Two spellings for a thread key, and why

`thread/<key>` takes **everything** after `thread/` as the key, rather than one
path segment. Thread keys may contain slashes — `branch:wren/feat/auth` is
legal and five such keys exist in the database — and React Navigation's
`:param` matches a single segment, so the obvious `thread/:threadKey` config
binds `branch:wren` and opens the wrong thread. Taking the remainder is safe
because nothing follows the key in the path grammar.

`thread?key=<encoded>` is the form to **generate**. It round-trips any key
through `encodeURIComponent` with no reasoning about which characters are
special, so code building a link should use `buildDeepLinkPath` and get this
one. When both are present, `?key=` wins.

Parsing lives in `src/lib/deepLinks.ts` (pure, tested); the navigation wiring
is `src/linking.ts`.

## Driving the app from a terminal

Useful for testing, and the reason this exists: `idb ui tap` cannot drive
current simulators (see below), but deep links navigate without it.

```bash
# Standalone / dev build
xcrun simctl openurl booted "inkwell://thread/pr:654"

# Expo Go — links are served under a /--/ marker, which the parser strips
xcrun simctl openurl booted "exp://127.0.0.1:8092/--/thread/pr:654"
xcrun simctl openurl booted "exp://127.0.0.1:8092/--/thread/branch:wren/feat/auth"
```

`xcrun simctl io booted screenshot out.png` captures the result. Both are
public, supported Apple tooling, unlike `idb`, whose companion reaches into
private frameworks and is pinned to a 2022 build that cannot drive an Xcode 27
simulator.
