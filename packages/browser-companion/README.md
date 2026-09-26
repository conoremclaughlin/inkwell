# Inkwell Browser Companion

An opt-in Chrome MV3 extension for deliberately sharing page context and reviewing
suggested field changes. Built with WXT, following Inkah's build pattern rather
than copying its all-sites content script. No browsing recorder or background agent.

The current UI is a snapshot/share/confirmed-fill prototype. It does **not** yet
provide a live conversation in the sidebar or automatic follow-up page inspection.
The required page-aware read/chat/interact experience is being built separately.

## Build and load

Use Node 22 and the repository's Yarn version:

```sh
yarn install --immutable
yarn workspace @inklabs/browser-companion type-check
yarn workspace @inklabs/browser-companion test
yarn workspace @inklabs/browser-companion build
```

Install runs `wxt prepare` to generate the ignored `.wxt` types before tests.
Skipping install scripts requires running that preparation explicitly.

In Chrome 116+, open **chrome://extensions**, enable Developer mode, and **Load
unpacked** from `packages/browser-companion/.output/chrome-mv3`. Pin the extension.
Build output is intentionally untracked. Reload the extension after rebuilding.
Nothing installs into your everyday browser automatically.

The matching dashboard must include the `/browser-companion` route. The default
dashboard origin is `http://localhost:3002`; use your web port, not API port 3001.
Other localhost/127.0.0.1 ports work; remote dashboards require HTTPS. Existing
dashboard authentication and API authorization are unchanged.

## First conversation

1. On the source page, select the text you want help with and click the extension
   icon. In its panel, click **Selected text**. Larger page capture is a separate,
   explicitly confirmed option.
2. Review the snapshot: URL path, title, excerpt and eligible field labels/IDs.
   Existing form values are not shared. The attention counts are incomplete hints,
   not a secret detector or privacy clearance.
3. Choose the dashboard origin and **Review in Inkwell**. Approve access to that
   dashboard host only. Chrome's host grant covers all ports; the application
   additionally checks the exact origin, path, tab and document.
4. In the signed-in dashboard, write your instruction, choose an SB, review the
   exact outgoing message and explicitly send. If redirected to sign in, choose
   **Review in Inkwell** again after signing in.
5. Replies appear in the thread. A tagged, valid proposal has **Review in
   extension**; alternatively paste its JSON into the extension's proposal box.
6. Review exact proposed values in the extension and confirm **Apply these exact
   changes**. Filling itself can trigger site autosave or other requests. The
   extension never clicks Submit, but cannot prevent site scripts doing so.

The wire format for replies is a fenced `inkwell-browser-proposal` JSON block:

```json
{
  "version": 1,
  "snapshotId": "00000000-0000-4000-8000-000000000001",
  "changes": [{ "fieldId": "f0", "value": "Suggested text" }]
}
```

Use the actual capture's ID and supplied field IDs. No selectors, arbitrary code,
clicks, navigation or submission commands are accepted. Replies remain untrusted.

## Privacy and recovery

- Permissions: `activeTab`, `scripting`, `storage`, `sidePanel`, plus the dashboard
  host you explicitly approve. No always-granted sites, ambient content scripts,
  cookies/history/debugger access or account token in the extension.
- Capture excludes form values, hidden/editable text, query strings and fragments.
  Titles, URL paths and visible text may still contain sensitive information.
- Sending shares context with Inkwell, the recipient and its model provider. Copies
  may remain in histories, logs, summaries or memories. The private-context marker
  asks SBs not to copy raw data into memory/session context or external relays; it
  is guidance, **not enforced downstream containment or deletion**.
- One capture at a time, ten-minute action TTL. Worker suspension retains ephemeral
  session state; browser restart clears it. Source navigation, tab closure, changed
  fields or replaced elements invalidate the action. Recapture and review again;
  the existing dashboard can preserve your instruction.
- `Forget` clears the extension's capture, not already-sent thread/model history.
  Expired state is cleared on access, not on a promised forensic-erasure timer.
- A storage receipt does not mean the recipient was woken or read the request.
  Structured trigger failures are shown explicitly. Ambiguous send/fill responses
  are never automatically retried; inspect the thread/page before trying again.
- A fill is at-most-once, not transactional. A site can change later fields during
  an input event; partial application is reported without pretending to roll back.

## Extension or Playwright?

Use the extension for co-present help in an everyday signed-in tab, without cookie
export. Use Playwright for reproducible UI tests, controlled multi-step automation,
navigation and assertions. Playwright can also use headed/persistent/CDP sessions;
it is not inherently a cold or unattended browser. Both need appropriate authority
for consequential actions, and neither promises a CAPTCHA/bot/SSO bypass.

V1 supports top-frame ordinary HTTP(S) pages, text inputs and textareas only. No
cross-origin iframe traversal, closed shadow roots, canvas/PDF interpretation,
native dialogs, browser/store pages, password/payment/OTP fields or complex rich
editors. Site frameworks may reject synthetic input; verify the result manually.
The dashboard bridge trusts the chosen dashboard origin, not a nonce as a substitute
for authentication. No broad CORS or localhost-auth exception was introduced.

## Verification scope

Tests exercise protocol/privacy bounds, isolated DOM capture, stale-target refusal,
at-most-once writes, mocked Chrome sender boundaries, worker recovery, expiry and
dashboard human-send behavior. CI also typechecks and builds the production MV3
package. Test fixtures are invented; never use real page captures as fixtures.

An isolated Chromium smoke probe loaded the compiled extension, invoked its actual
browser action for `activeTab`, captured a synthetic form, imported a proposal and
confirmed a fill. It checked value/password/query exclusion, no pre-confirm mutation
and no submit. The panel HTML ran in an extension tab: native panel geometry, real
dashboard authentication and an actual SB roundtrip are separate manual acceptance
checks, not covered by those assertions.

A second compiled-browser probe exercised the serialized dashboard bridge against
a synthetic loopback page: capture offer, receipt, returned proposal, explicit
confirmation and observed field change. Its localhost permission was pre-granted
through Chromium developer settings in an isolated profile, **not** accepted via
the native permission prompt. This verifies the bridge, not real dashboard auth,
mail delivery or the optional-permission dialog. It also exposed a panel refresh
race: the saved origin could overwrite an edited dashboard port. Regression tests
now preserve edited origins and keep actions disabled until refresh completes.

Architecture and rollout live in the versioned Inkwell artifacts
`ink://specs/browser-companion`, `ink://specs/live-agent-surfaces` and
`ink://specs/task-scoped-skills`, not local copies of the specs.

## Read-and-chat foundation (not enabled)

`src/read-session.ts` provides a read-only local lifecycle for the successor:

- One fixed attachment, including exact HTTP(S) origin and same-document navigation identity; fresh capture
  and authoritative grant revalidation for each read, with no snapshot replay.
- Local Stop rejects pending work without waiting for a network reply. Late
  authorization/capture results cannot revive that stopped instance.
- Fixed ten-minute/60-read local ceilings (shorter grants win), independent of the
  15-second per-read liveness bound. Verification latency consumes that bound.
  Failed attempts spend the local budget; concurrent reads refuse.
- Snapshot URLs must match the exact trusted origin, including scheme and port;
  this does not authenticate a page title or replace adapter document checks.
- Explicit `status()` calls recheck expiry and may abort pending IO; property
  inspection alone has no cancellation side effect.
- Wall and monotonic clocks independently bound lifetime; clock rollback refuses.
  Timers interrupt pending IO, while explicit deadline checks also cover delayed
  timers. These checks do not depend on the server's heartbeat/reaper.

This is an **unwired library**, not authenticated browser access or an egress
boundary. It does not store credentials, grant Chrome permission, capture a real
page, dispatch an SB or write to a website. Its adapter must authenticate and
recheck the server grant/owner, atomically reserve the server budget, bind Chrome
operations to the exact document/navigation, and enforce the private result path.
Local counters do not survive worker replacement; persistent server budgets must.
Do not restore a stopped instance or construct a replacement from stale authority.

Production wiring requires the separate browser-client authorization and
browser-restricted execution/egress contracts. A privacy marker in a prompt does
not contain an unrestricted coding backend with shell/network access. Unit tests
use synthetic snapshots, injected clocks and fake adapters, not native Chrome or
an actual authenticated SB roundtrip.

## Sidebar conversation view (not enabled)

`src/chat-panel.ts` and `src/chat-panel.css` provide the next conversation view,
without changing the installed prototype or adding network access. The view
accepts a trusted, typed state snapshot plus injected send/Stop/subscription
callbacks; these are UI contracts, not server API schemas or authorization.

- The selected SB, thread, attached page, sharing and connection states stay
  visible. Messages render as bounded plain text, never HTML or executable links.
- Storage, queueing, active execution, completion, rejection and uncertain
  delivery remain distinct. A successful HTTP request is not a read receipt.
- One send is pending at a time. Editing remains possible; an older receipt
  cannot erase a newer draft. Thread/account/SB/controller/grant/document changes
  fence late callbacks and discard drafts rather than carry them to a new target.
- Stop calls the local revoker synchronously, even during pending IO. It does not
  claim remote cancellation or undo effects already started.
- An ambiguous send blocks resubmission until the adapter reconciles its exact
  operation ID in the same account/workspace, thread and SB. Navigation, regrant,
  page detach, or switching away and back does not clear that guard. This bounded
  in-memory tracking is **not durable idempotency**; the adapter must reconcile
  after a view reload and provide ordered, authenticated snapshots.
- Echoed local messages stay retired when the supplied history window slides;
  they do not reappear below newer replies. Echo tracking shares the bounded
  local-message buffer rather than accumulating an unbounded ID set.
- Keyed transcript updates preserve unchanged rows/body nodes during appended
  replies and status ticks, as well as draft typing and unchanged refreshes.
  Text is only reassigned when changed; screen-reader behavior still needs native
  acceptance testing. Switching views cannot revive the last locally stopped
  read-session identity; a new read session remains distinct.
- Destroy removes listeners, clears visible data and aborts local
  pending delivery, but is not a remote grant-revocation operation.

Production entrypoints do not import this view yet. Pairing, thread-scoped API,
page-grant admission, browser-restricted runtime/egress, real Chrome targeting,
and authenticated multi-turn acceptance remain necessary before enabling live
page-aware chat. Unit tests use synthetic state and fake callbacks, not an SB.
