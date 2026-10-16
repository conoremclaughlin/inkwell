# Inkwell Browser Companion

An opt-in Chrome MV3 extension for deliberately sharing page context and reviewing
suggested field changes. Built with WXT, following Inkah's build pattern rather
than copying its all-sites content script. No browsing recorder or background agent.

The panel now connects explicitly to hosted chat with one of the paired owner's
inklings. Messages use the existing inbox dispatch and hosted runtime, not a
second extension agent loop. Page control is still separate: connecting or
chatting does not read a tab. The older snapshot/confirmed-fill prototype remains
under its own disclosure. This is local source, not a deployed or real-account
acceptance claim.

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

1. Expand **Pairing and connection settings** and pair with your dashboard.
2. Click **Connect**, choose your inkling, and send a message. The server must
   include the companion chat endpoints; the older auth-only server is not enough.
3. The panel reads replies from that installation grant's own conversation.
   The server derives the thread from the grant and selected identity UUID;
   clients cannot supply another workspace, conversation, runtime or SB slug.
4. Closing/reloading the panel drops its connection intent. A surviving document
   may reconnect after worker suspension, but a new document needs Connect.
   Bearers stay in worker memory. Disconnect in any panel stops every panel and
   requests installation revocation through the existing pairing path.

Ambiguous sends are never replayed automatically. The exact message and operation
reference are written to trusted-context session storage before dispatch and
reconciled through an exact, read-only receipt lookup,
even when its message is outside the recent-history window. A missing receipt
stays unknown. A crash before dispatch can conservatively leave an unsent operation
unknown too; it is not safe to infer rejection from absence. The panel shows the
saved message and offers **Retry this exact message**. Only that explicit click
may resend the byte-identical body with the original operation ID; the server's
unique client-message index prevents a second stored copy. A retry never invents
a replacement ID or silently substitutes the current draft. Unconfirmed bodies
remain in session storage, including across Disconnect, until a matching receipt
clears them or the browser session ends. They never enter local/sync storage and
no bearer is persisted. Older reference-only entries can still reconcile but
cannot retry without their original body. Chat Stop closes the local connection,
not a remote runtime or an already accepted message.

Resource denials affect only that conversation request. A terminal credential
failure ends the document's intent and offers Reconnect instead of polling a dead
connection. Every chat endpoint checks current workspace membership; writes also
require the same write role as a person's ordinary inbox send. Grant liveness
alone is not current membership.

Only owned, self-serve app inklings appear in the picker; workspace development
SBs are not implicitly included. Conversation history is scoped to the pairing
grant. A new pairing (including after a browser restart or grant expiry) starts
a new conversation; old threads remain in Inkwell but are not exposed to that
new installation grant.

The selected inkling retains its ordinary tools. Page content will be labelled
untrusted when page integration lands; no claim of a restricted runtime or prompt
injection containment is made. Scoped page control, named task tabs/groups, and
page-text intake remain follow-ups, not implicit effects of Connect. Pasted chat
text gets a narrow control-character cleanup in the visible draft before Send:
bidi controls, zero-width spacing, BOM, control bytes and hidden Unicode tags are
removed, while writing, joiners, emoji presentation and recognised subdivision
flags are preserved. This is not a detector for visible prompt injection. The
researched third-party cleaners are not installed or represented as audited.

Installation-wide Disconnect broadcasts before returning. If persistence, remote
revocation, and delivery to a surviving panel all fail together, that panel may
retain intent across worker replacement. This residual is not represented as a
confirmed revocation; no owner-only Disconnect restriction is introduced.

### Installation pairing checkpoint

Use **Open pairing approval** to open the authenticated dashboard. The extension
creates a random installation secret and passes only its SHA-256 commitment and
installation ID in the approval URL's fragment. The dashboard requires a human
confirmation before minting a code, bound to the selected workspace. Paste that
code back in the extension. If sign-in loses the request, reopen approval from
the panel. Neither loading the link nor receiving a code starts a model turn.

The worker claims the code over the fixed companion namespace with explicit
`credentials: 'omit'`, no redirects, and the exact chosen dashboard origin.
Pairing credentials use `storage.session`, explicitly restricted to trusted
extension contexts; other trusted extension pages are part of this trust boundary,
not isolated from one another. Credentials are never returned in panel messages,
rendered, put in URLs, or stored in local/sync storage. Pairing alone does not
mint a bearer token or admit a page; the separate Connect action starts chat access.

**Disconnect** fences a pending claim without waiting for its network response.
The worker attempts to revoke a late successful claim, never reattaches it. A failed revocation retains
only the credential needed for an explicit idempotent retry. An unacknowledged
claim is **unknown**, including after worker suspension: it is never retried.
Without its one-time receipt the client cannot confirm remote revocation. After
Disconnect, a terminal missing-receipt outcome allows a fresh installation and
approval in the same browser session. It never retries the old claim or calls the
old grant revoked: the grant's twelve-hour expiry remains the backstop.
Replacement is blocked while a claim can still return a receipt, or a known grant
still needs revocation. The panel offers remote retry only when that credential
is present. After a worker restart, the old request cannot deliver a receipt to
the new worker; that does not revoke a server grant.

A session-storage write failure stops new pairing, but does not block cleanup.
The worker keeps a known grant in memory solely to revoke it, including a late
receipt. Remote confirmation and unsaved local state are reported separately.
If revocation also fails, retry while that worker still holds the receipt; a
worker restart can lose unsaved state. Closing the panel is not revocation.

Pairing tests use synthetic Chrome APIs, storage, fetch, and dashboard responses.
They do not demonstrate deployed migrations/proxy behavior, real-account pairing,
native panel acceptance, or Firefox installation support.

### Snapshot handoff (independent of pairing)

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
  cookies/history/debugger access or general dashboard token in the extension.
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
- The dashboard's **Check original thread** link carries the send's workspace and
  thread key. Its read-only recovery page keeps both bound on requests and in its
  cache, even if the dashboard changes workspace. It never changes that selection,
  retries a send, or offers reply/reaction controls. Finding a thread is not a
  receipt for a particular operation. The extension's future delivery-check
  adapter can build this same target with `browserRecoveryPath`; a durable
  operation lookup is still separate work.
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

Production page wiring requires separate page authorization. The selected
inkling uses its ordinary execution tier; a privacy marker in a prompt does
not contain a runtime with shell/network access. Unit tests
use synthetic snapshots, injected clocks and fake adapters, not native Chrome or
an actual authenticated SB roundtrip.

## Sidebar conversation view

`src/chat-panel.ts` and `src/chat-panel.css` provide the next conversation view,
with network access supplied by the hosted panel adapter. The reusable view
accepts a trusted, typed state snapshot plus injected send/Stop/subscription
callbacks; these are UI contracts, not server API schemas or authorization.

- The selected SB, thread, attached page, sharing and connection states stay
  visible. Messages render as bounded plain text, never HTML or executable links.
- Snapshot rows are oldest-first. Within the newest 100 supplied rows, duplicate
  IDs use the last occurrence's complete fields and position. Rendering and
  delivery reconciliation consume that same canonical snapshot; older history is
  not scanned to backfill rows removed by deduplication.
- Storage, queueing, active execution, completion, rejection and uncertain
  delivery remain distinct. A successful HTTP request is not a read receipt.
  Adapters must explicitly map server statuses to the closed `ChatDeliveryState`
  set. Unmapped values count as `unknown` evidence, not an absent echo; repeating
  an unmapped status cannot reconcile an uncertain send.
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
- While a send is pending, the newest same-conversation echo takes precedence
  over retained evidence, including in a snapshot that changes the page binding.
  An observed `unknown` remains evidence, not an absent echo: it also overrides
  an unversioned send callback, even after the row leaves the visible window.
  Callback status is fallback only when there is no observed echo. A later
  authoritative adapter snapshot can reconcile the guard without resubmitting.
  Once reconciled, a later `unknown` row does not automatically re-lock this view;
  the adapter must distinguish admission evidence from execution uncertainty and
  own durable retry gating independently of the rendered history window.
- Uncertain sends retain an operation reference after the old page and draft
  are discarded. An optional `inspectDelivery` adapter callback opens a check
  for that exact conversation and operation, never a retry. It receives no
  page binding or message body, and inspection does not reconcile the guard.
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

The production panel now imports this view. Chat APIs stay inside the browser
credential allowlist and use existing owner-scoped inkling listing, inbox dispatch,
and durable client-message deduplication. Page-grant admission and real Chrome
targeting remain unwired. Unit tests use synthetic state and fake callbacks.

### Shared external-content cleanup

Page capture, paste, and `web_fetch` use the same browser-safe Unicode policy in
`@inklabs/shared/security/untrusted-content`. It removes control, bidi, zero-width
spacing and tag payloads without normalizing scripts; writing/emoji joiners,
variation selectors and recognized subdivision flags are preserved. Titles and
field labels are cleaned too. Page requests use the same fresh, randomized
untrusted-data boundary as `web_fetch`, around all page-sourced fields. Neither
cleanup nor the boundary is a prompt-injection detector or an authorization gate.

The DOM adapter feeds computed styles into the shared hidden-style rules, then
checks text-range geometry and clipping. Ordinary below-the-fold text stays in;
there is no vertical viewport cutoff for normal flow. Current form values remain
excluded. Deep ancestry and large rectangle lists are bounded; partially clipped
text runs are conservatively omitted, which can omit some visible text too.
Near-transparent text, same-color foreground/background, complex occlusion and
canvas-painted text are not covered by a general visibility guarantee.

The compiled capture path was exercised on a locally served planted page through
the panel, worker and isolated content script. Whole-page capture retained
below-the-fold and above-the-scroll-position controls; selection clipping,
Unicode cleanup, form-value exclusion and the 390 px overflow check passed.
The private test supplied a loopback host permission and source-tab binding, so
it does not establish the browser-action permission gesture or model acceptance.

The compiled extension also passed a two-message synthetic HTTP conversation in
real isolated Chromium, including authenticated extension-document ports, two
panels with separate Connect intent, cross-panel Disconnect, and a 390 px overflow
check. A DevTools-terminated worker reached stopped and restarted states; both
surviving panels resumed, while reloading a panel required a fresh Connect.
The follow-up smoke also recovered from a conversation-level 403, surfaced a
terminal grant refusal as Reconnect, and recovered a pre-insert failure after
reload only when Retry was clicked, preserving the exact operation ID and body.
The test seeds an invented pairing record and supplies static replies: it
does not demonstrate native sidepanel geometry, host-permission prompts, actual
dashboard login, the database, or an LLM turn. Those remain acceptance work.
