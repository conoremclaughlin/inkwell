# Live Inkmail in the native Codex terminal (experimental)

```sh
ink -b codex                     # live mail automatically on supported terminals
ink -b codex --no-codex-inkmail  # opt out
ink -b codex --codex-inkmail     # require it; fail instead of falling back
```

Requires **codex-cli 0.159.2**, macOS/Linux, a registered studio, and session
tracking. Use the normal session picker to start or resume. Review the Inkwell session hooks in Codex's native hook-trust prompt (or `/hooks`). The launcher
**does not grant hook trust**. Until the three hooks are enabled and trusted,
mail remains unread and live delivery is paused.

Live mail is the default for interactive, session-tracked Codex terminals with
supported arguments and the measured version. Unsupported versions/arguments,
missing scope or nonstandard hooks produce a visible fallback to the unchanged
native invocation, with live mail off. `--codex-inkmail` makes these failures
fatal instead; `--no-codex-inkmail` skips preflight and session hook setup entirely.
One-shot prompts, piped/non-terminal runs, `--no-session` and other backends
keep their normal path. User sandbox, approval and feature overrides are not
weakened. A failure after the bridge starts never falls back to a second owner;
relaunch with `--no-codex-inkmail` to use the normal path.

The launcher **does not rewrite project, main-checkout, or user hook files**.
It reads native effective configuration with the actual launch overrides, reuses
exact existing guarded handlers when present, or supplies the three handlers as
non-managed `sessionFlags` hooks. This also works in linked Git worktrees, where
Codex 0.159.2 may read main's `.codex` contents under the worktree's layer name.
Hook sources are additive; conflicting/partial Inkwell handlers or custom session
hook overrides cause a safe refusal/fallback, never another duplicate handler.

Native trust is still human-owned. In the isolated native resume test, approval
persisted in `CODEX_HOME/config.toml` under `hooks.state` entries for
`/<session-flags>/config.toml`. Relaunching with the same commands did not prompt
again. A different node executable, CLI checkout, or hook definition can change
the hash and require re-review. The session-flags trust slots are shared across
projects in CODEX_HOME: trusting build B replaces build A's hash in that slot, so
returning to A needs review again (also measured with synthetic trust records).
No trust is granted by the bridge.

Bridge warnings use Codex's native warning badge/drawer (**F2**), not raw stderr
on top of the terminal. Unchanged failures are reported once; changed conditions
and recovery are reported again. With no connected frontend, bounded diagnostics
are retained until attachment or printed only after the TUI exits. These warnings
are UI-only, not model input or queued user messages. Missing handlers, conflicting
sources, disabled hooks, and untrusted hooks have distinct guidance.

This does not connect an already-running embedded terminal, change the desktop
app, use or configure the shared daemon, relink `ink`, or restart an Inkwell server.
To adopt it for an existing conversation, restart `ink` and select that same
session; no new conversation is required. On/off selection is launch-time only.

## Delivery

The wrapper runs a private App Server and attaches the **native Codex TUI** via
a private Unix WebSocket gateway. The original identity, MCP authentication,
context headers and other `-c` overrides stay on the App Server. Model,
approval/sandbox options and additional workspace roots travel on the native
thread start/resume request. Unknown launch options fall back intact in automatic
mode, or are refused when live mail is explicitly required; they are never
silently discarded. The initial supported subset is in `codex-mail/launch.ts`;
profiles, alternate remotes, picker-style native `resume`, and one-shot `exec`
are not supported by the bridge path.

The gateway binds mail to the exact persistent thread returned to its one TUI.
It ignores ephemeral title-generation threads. It passes approvals to the TUI
and never decides them. It does not inject terminal keystrokes or start a second
execution owner with `codex exec resume`.

The existing scoped Inkmail drain fetches without marking read. Idle mail starts
a turn; busy mail waits in the native queue. **Queue acceptance is not delivery.**
The reader ACKs only after an exact-thread user-message context receipt with
matching client identity and content. It does not interrupt an active turn.

A private write-ahead journal under `~/.ink/codex-mail` stores identities and
content hashes, not message bodies. Codex does **not** deduplicate repeated
`clientUserMessageId` values. After an uncertain send or restart the bridge
reconciles queued submissions and context items; it never blindly resends. If
bounded reconciliation cannot confirm delivery, the mail stays unread and the
terminal shows a warning. Resume the original Codex thread to reconcile an
outstanding intent. Do not delete the journal as a retry mechanism: doing so
can duplicate mail that already reached the model.

### Recovering a blocked message

An unconfirmed intent **holds later mail in that thread**. For legacy inbox
messages it holds the shared global read pointer, so later legacy mail also
waits. Other threaded conversations can still drain. The reader remains live
and advertises freshness while it reconciles; freshness is not proof that all
mail has delivered. Restarting with the same Inkwell session reloads the same
intent and does **not** clear this boundary.

Warnings identify the message ID and thread (or legacy inbox), repeat at most
once per minute per message, and report when an exact receipt is recovered.
There can be a brief gap between dequeue and a completed context item: "not
visible yet" is not proof of loss. Keep the original Codex thread open or resume
it to allow the receipt to arrive. Normal visible queue backpressure is quiet.
A not-visible scan gap is also quiet for its first 15 seconds; read acknowledgement stays blocked throughout.
Transport/journal failures still warn immediately.

If the intent never landed, or a queued row was deliberately deleted, this
version cannot prove that from bounded history and will not resend. Recovery
requires an explicit human decision, not journal deletion or a new session:

1. Fetch the identified message with `markRead: false` and review it manually,
   along with native context/queue state and the intended action's outcome.
2. If the human chooses to handle or skip that message outside the bridge,
   acknowledge the **reviewed range** with `mark_thread_read` (the thread key
   and `throughMessageId`) or `mark_inbox_read` (`throughMessageId`). Both also
   consume earlier rows: review those first. The legacy pointer is timestamp
   based, so review/handle every row sharing the target timestamp too. This is
   a deliberate manual read acknowledgement, **not** a fabricated Codex receipt.
3. Relaunch the bridge with the **same Inkwell session and original Codex thread**
   to clear its in-memory fetch cursor and adopt the manually advanced read
   pointer. Later mail can then drain. If the content still needs model delivery, request
   a new message ID from the sender only after explicitly accepting the risk
   that the original could have been delivered. Check side effects before
   asking to repeat any action.

Keep the journal for reconciliation. There is no automatic resend, automatic
skip, journal-pruning policy, or "safe retry" inferred from empty scans.

The bridge's independent freshness probe continues while healthy mail waits
in the queue. It stops advertising a reader after disconnection, owner exit,
untrusted hooks, or stale mailbox discovery. A live owner with a broken reader
is reported, not silently treated as working delivery.

## Lifecycle and limits

- Configuration-only native preflight uses `config/read` and `hooks/list`, with
  no thread start/resume or model turn. Each request is bounded and its owned
  child is reaped before proceeding. The linked-worktree fixture verified no MCP
  server or hook execution; two probes added about 0.34 seconds on the test host,
  not a general latency guarantee. User feature and configuration overrides stay
  authoritative, including an explicit hooks disable.
- The session-scoped commands (and compatible previously installed handlers) carry
  `--codex-inkmail-only`. Before any identity/session reconciliation, lifecycle
  write or inbox read, they require an explicitly attached Codex context matching
  the session/studio/SB environment and a private, live-wrapper binding to the
  **exact native `session_id` in hook stdin**. The binding is published only from
  the TUI's persistent start/resume response. Pre-bind `SessionStart` is inert:
  the wrapper already provides startup context and owns the initial backend link.
- Subagent payloads carrying `agent_id`, `agent_type` or `agent_transcript_path`
  are refused even when `session_id` matches. On measured Codex 0.159.2, a
  subagent's `UserPromptSubmit` uses the **parent** session ID plus agent fields;
  thread equality alone is insufficient. The captured child emitted
  `SubagentStart`/`SubagentStop`, which the managed block does not register;
  child `SessionStart`/ordinary `Stop` were not observed. Tests replay their
  captured Subagent\* shapes defensively, not as evidence of ordinary child
  SessionStart/Stop. This is version-specific evidence,
  not a promise about future native payloads.
- Headless, parent-owned, unbound, malformed and foreign-thread hooks skip all
  business handlers, appending only a local diagnostic. Nested raw `codex exec`
  may inherit the bridge environment but cannot claim the parent through a
  different thread ID. Binding is revoked on thread switch, connection failure
  and teardown. This is routing isolation, not authentication against a local
  actor forging context/payloads or rewriting files. Custom hooks are not fenced.
- If conflicting Inkwell sources cause fallback, inspect the named sources with
  `/hooks` and review/back up their configuration before changing it. The bridge
  does not rewrite a main checkout shared with other studios. Do not blindly run
  `ink hooks install --force`: old or malformed marker blocks may need deliberate
  repair, and installer output alone does not establish native hook discovery.
- Hook inbox intake stands down while this bridge owns delivery. Hook lifecycle,
  turn epoch and lease behavior remain in the existing handlers.
- TUI exit stops and reaps the App Server before detach/identity-file cleanup.
  A detached guardian watches a wrapper-owned pipe: even wrapper SIGKILL closes
  that pipe and terminates its own child. It never kills processes by name or
  guesses a previous owner's PID.
- Switching persistent threads inside the TUI pauses mail. Besides start/resume,
  native responses naming a different persistent thread conservatively
  trigger the guard (including fork or an unfamiliar method). Read-only
  `thread/read` metadata is exempt: the TUI reads other threads while restoring
  history; those reads never establish or transfer ownership. Relaunch `ink` and
  select the intended session. The initial version does not guess how to move
  Inkwell ownership between native `/new` or `/resume` operations.
- Server `forceSpawn` requests still bypass inline delivery and can collide with
  an attached Codex writer. This change does not relax the writer lock or make
  forced headless resumes safe.
- Queue/receipt APIs are experimental and version-gated. This is not a claim of
  desktop support or of delivery into arbitrary pre-existing embedded sessions.

## Verification

Build **only the local CLI**, never root `yarn build` (which relinks the global
CLI):

```sh
yarn workspace @inklabs/cli build
test_home=$(mktemp -d /tmp/ink-mail-tests-XXXXXX)
(cd packages/cli && env -i PATH="$PATH" HOME="$test_home" \
  CODEX_HOME="$test_home/codex" TMPDIR="$test_home" INK_SERVER_URL=http://127.0.0.1:9 NODE_ENV=test \
  node ../../node_modules/vitest/vitest.mjs run src/lib/codex-mail src/cli.test.ts)
node scripts/probe-codex-live-input.mjs --gateway --permissions-probe
node scripts/probe-codex-live-input.mjs --wrapper
node scripts/probe-codex-live-input.mjs --launcher
node scripts/probe-codex-live-input.mjs --nested-probe
```

The opt-in probes use a fresh HOME/CODEX_HOME/cwd, a synthetic local provider,
no credentials. The ordinary modes execute no model tools. `--wrapper` also uses a stub Inkwell
API and the actual Inkwell lifecycle hooks; its trust keystrokes apply **only**
to hooks in the disposable fixture. It then runs native `codex exec` in the
same migrated/trusted project with a server-shaped context, proving all three
hook guards execute without any Inkwell API calls. `--launcher` additionally
exercises the actual `ink` entry point, session selection and adapter with no
Inkmail CLI flag, then resumes that same conversation and verifies the reader
is fresh again with history preserved. `--nested-probe` adds deterministic
synthetic tool calls: a bounded native `codex exec` child and an in-process
subagent, both against the same loopback provider. Its workspace-write roots are
inside the fixture, with networking enabled for that provider; it never runs
model-selected or destructive shell payloads. It captures native hook payloads,
asserts the parent's backend link/epoch calls remain exclusive, and resumes the
parent while other native threads exist. This is structural no-interference
evidence, not a shared-DB server-finalization integration test. Evidence stays outside git. Unit tests cover
ambiguous acceptance, restart/ACK failure, exact receipts, scope, approvals,
permission mapping, heartbeat failure and direct-node parent death, including
a helper-disabled negative control with a self-terminating fake owner.

Protocol references: [Codex App Server](https://learn.chatgpt.com/docs/app-server)
and [Codex hooks and explicit trust](https://learn.chatgpt.com/docs/hooks).

### Native worktree regression probes

After building only the CLI (no global relink), run:

```sh
node scripts/probe-codex-worktree-hooks.mjs
node scripts/probe-codex-live-input.mjs --linked-worktree --nested-probe
node scripts/probe-codex-live-input.mjs --gateway
```

These opt-in probes use fresh HOME/CODEX_HOME, a disposable Git repository for
worktree cases, and a synthetic loopback provider/API for execution cases. They
verify source isolation, unchanged configs, native human trust persistence,
same-thread resume, exact receipts, nested/subagent guards, and UI-only warnings.
No real account credentials or shared database are used. Native trust approval in
the harness applies only to its synthetic temporary configuration.
