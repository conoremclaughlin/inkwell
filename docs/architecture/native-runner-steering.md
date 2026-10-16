# Native runner steering

## Status and scope

This is the standard Codex follow-up to the hosted runtime steering in #701.
It is **not cleared for production activation** until the owned runner passes
its native compatibility checks. Claude native steering is not selected.
Ordinary inbox mail still queues through the existing path.

Eligible standard Codex runs use a newly owned `codex app-server --listen
stdio://` child from the start. The server never attaches to an arbitrary
interactive or `exec` process, launches a second writer to inject a correction,
or falls back to `exec` after app-server has been selected.

The existing `POST /api/sessions/:id/steer` endpoint takes explicit owner text,
`messageId`, and `turnEpoch`. Its authenticated owner check remains unchanged.
The server creates a native capability only for an explicitly detached,
non-contact, non-Inkling, full-tier generation with canonical identity metadata,
an exact session-bound MCP token, and the current active-run owner. Request
metadata cannot create that capability. Containers and compaction keep the
previous transport.

## One connection, one turn

The transport completes `initialize` / `initialized`, starts or resumes the
exact native thread, then starts one turn. It pins the returned turn ID and
validates any early `turn/started` notification against it. Early events are
bounded and held until identity validation. No additional `turn/start` is
permitted on that connection.

Steering uses `turn/steer` with `expectedTurnId`. Its success response is only
provider acceptance, not an insertion receipt. An unpredictable host-generated
tag correlates an exact `userMessage` observation on the owned native turn;
model text, caller-supplied role labels, unrelated turns, and uncorrelated
echoes cannot promote a receipt. Interactive approval and dynamic-tool requests
are refused by this headless host rather than granted implicitly.

Protocol reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server).
The installed 0.160.0 generated schema confirms the request and notification
field shapes. A schema is not evidence of runtime ordering or consumption.

## Evidence and uncertainty

The native mailbox reuses the hosted parser and limits: 8 KiB per text,
32 KiB per generation, and 128 retained IDs. Same-ID/same-text submissions
reconcile; changed text conflicts. A request intent and pending receipt are
flushed before exactly one dispatch. RPC acceptance remains `pending`.

Native evidence goes into a fresh generation-local private journal under
`.ink/runtime/native-steering/`, with a private directory, exclusive file,
append and file-sync barriers, and sticky write errors. Only a correlated
observation followed by a durable receipt yields `inserted`. It means provider
input observation, not comprehension or completion of the requested work.

These events are not hosted ledger entries and have no replay or queue surface.
They never seed a later prompt. Native provider history may retain input the
provider actually accepted; Inkwell does not replay uncertain requests into it.
There is no cross-process receipt reconciliation in this slice.

Turn end synchronously fences admission. A request not dispatched is refused;
an unresolved dispatched request is unknown. Stop, replacement, expiry,
persistence failure, transport ambiguity, or a late echo cannot upgrade an
unknown receipt. In particular, an observation followed immediately by terminal
output can remain unknown if its persistence barrier has not completed. This
conservative result is intentional, not permission to resend.

EOF gives the owned child a short shutdown window, followed by confirmed stop
if necessary. When process-group ownership is enabled, leader exit alone does
not establish group quiescence. A failed stop remains visible alongside any
journal-close error. Child ownership is reserved before spawn and outlives the
steering port and finalized run. An unconfirmed child blocks the next session
generation, including legacy `exec`, until observed exit (and an empty group
when applicable). Survivor reconciliation only probes; it never signals a
remembered group again. Shutdown closes intake and asks the owned-child registry
to stop its children within a bounded wait. These are in-process guarantees;
a restart still relies on the existing launched-process recovery path.

A known `thread/resume` writer refusal preserves the pre-acceptance
`owner_conflict` classification through cleanup and session finalization. Only
the trusted method reply is classified, and only a static category/summary is
retained, not provider diagnostics. Unrelated initialization errors and ambiguous
`turn/start` failures do not receive this classification. No receipt silently
retries or becomes ordinary mail.

Scoped provider turn failures preserve actionable quota, authentication and
network classifications without retaining diagnostic text. The v2 wire error
variant takes precedence over message matching; only a non-retrying error
notification or the failed turn's own error contributes a classification.
A successful turn clears an earlier notification, and an explicit final error
replaces it. These post-acceptance errors cannot become an owner-conflict
refusal. Session finalization therefore keeps its existing queue policy without
replaying uncertain steering.

## Verification and remaining gates

Focused checks cover mailbox durability and races, binding and journal refusal,
mocked app-server transport and cleanup, real session-service selection with
all external effects mocked, and the existing route's owner checks. They do
not establish full production or live-provider compatibility.

The new isolated native Codex probe completed initialization but refused
`thread/start` while synchronizing managed preferences, before any synthetic
provider request. It did not establish successful start/resume, actual event
ordering, the exact steering echo, or normal successful-turn EOF. Earlier
hand-driven native timing evidence does not replace exercising this runner.
Those checks and sibling review remain merge gates.

Claude's non-query streaming input can append transcript text for a later
query. Avoiding an immediate second query is not a no-future-turn-spill
guarantee. Its isolated compatibility probe also stopped before any provider
request; credential-access restrictions were not relaxed. Keep Claude native
admission off until same-turn correlation and the terminal/resume boundary
are defensible. Antigravity and daemon/proxy attachment are outside this slice.
