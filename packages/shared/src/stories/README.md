# Stories

Code every client shares, organised by what a person is doing when it runs:
browsing their threads, reading one, catching up on what's new. The web
dashboard, the mobile app and the desktop app each draw these stories their
own way. What the story means lives here, once.

Each story is one directory with an `index.ts`, imported by its own path:

```ts
import { buildTimeline, useThreadHistory } from '@inklabs/shared/stories/thread-viewing';
import { hasUnread } from '@inklabs/shared/stories/thread-read-state';
```

| Story               | What the person is doing                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threads-api`       | Nothing yet. This is what the server sends and where to ask for it; every thread story reads these shapes.                                                                               |
| `thread-browsing`   | Scanning the thread list: which threads show, how a row reads, what search and filters match.                                                                                            |
| `thread-viewing`    | Reading one thread as a conversation: who wrote what, day and unread dividers, grouping, older history, folding long bodies, and markdown parsed for any renderer that is not a browser. |
| `thread-read-state` | Knowing what's new: which messages count as unread against a read cursor.                                                                                                                |

## Rules

- **No platform.** A story never touches the DOM, React Native, Node's
  built-ins, `localStorage` or `fetch`. The client passes in whatever does
  the I/O: a fetcher, a clock, a store. That is what lets the same code run in
  a browser, on a phone and in a terminal. The package's `lib` has no DOM,
  so reaching for one fails the build.
- **React is the one framework allowed.** A story may export hooks (for example
  `useThreadHistory`), because every client is React. React is an optional peer
  dependency, so a client brings its own copy. Plain JavaScript libraries
  that need no platform are fine: `marked` parses message markdown. A client whose bundler
  could find a second `react` (a workspace with its own `node_modules`)
  has to resolve every `react` import to its own copy. Two Reacts in
  one bundle break hooks. `packages/mobile/metro.config.js` shows how.
- **Stories may import each other, through the other story's `index.ts`,
  without cycles.** Today the order is: `threads-api` ← `thread-read-state` ←
  `thread-viewing` ← `thread-browsing`.
- **Tests sit beside the code** and run in CI with the package's own
  `yarn test`.
- **New shared client code starts a story, or joins one.** Name the story after
  the person's activity, not the technical layer: `thread-viewing`, not
  `thread-utils`.
