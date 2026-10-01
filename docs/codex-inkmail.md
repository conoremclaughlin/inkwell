# Live Inkmail in the native Codex terminal (experimental)

```sh
ink -b codex --codex-inkmail
```

Requires **codex-cli 0.159.2**, macOS/Linux, a registered studio, and session
tracking. Use the normal session picker to start or resume. Review the updated
Inkwell hooks in Codex's native hook-trust prompt (or `/hooks`). The launcher
**does not grant hook trust**. Until the three hooks are enabled and trusted,
mail remains unread and live delivery is paused.

This is opt-in. Without the flag, the existing launcher path is unchanged, but
the **project hook migration persists** (see Lifecycle and limits). It does
not connect an already-running embedded terminal, change the desktop app, use
or configure the shared daemon, relink `ink`, or restart an Inkwell server.

## Delivery

The wrapper runs a private App Server and attaches the **native Codex TUI** via
a private Unix WebSocket gateway. The original identity, MCP authentication,
context headers and other `-c` overrides stay on the App Server. Model,
approval/sandbox options and additional workspace roots travel on the native
thread start/resume request. Unknown launch options are refused instead of
silently discarded. The initial supported subset is in `codex-mail/launch.ts`;
profiles, alternate remotes, picker-style native `resume`, and one-shot `exec`
are not supported by this opt-in path.

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

- Opt-in upgrades only the recognized, marked legacy hook stanza in the local
  `.codex/config.toml` to modern `SessionStart`, `UserPromptSubmit`, and `Stop`
  handlers. Other configuration is preserved. Symlinked or modified hook
  configurations are refused; trust is still the human's decision.
- **The migration affects the whole studio**, not just this invocation. Once
  enabled and trusted, modern hooks also apply to ordinary Codex launches and
  headless `codex exec` there. Without the bridge environment, existing hook
  inbox intake resumes. Server-shaped headless lifecycle/finalize compatibility
  after this migration has **not** been end-to-end validated by this PR; avoid
  enabling it in a studio concurrently used by a headless runner until that
  validation is complete. The native wrapper probe is not a substitute for it.
- Hook commands are pinned to the node binary and CLI checkout used to migrate.
  If either changes, review/back up custom hooks, run
  `ink hooks install --backend codex --force` using the intended CLI build,
  then relaunch with `--codex-inkmail` and review native hook trust again.
- Hook inbox intake stands down while this bridge owns delivery. Hook lifecycle,
  turn epoch and lease behavior remain in the existing handlers.
- TUI exit stops and reaps the App Server before detach/identity-file cleanup.
  A detached guardian watches a wrapper-owned pipe: even wrapper SIGKILL closes
  that pipe and terminates its own child. It never kills processes by name or
  guesses a previous owner's PID.
- Switching persistent threads inside the TUI pauses mail. Besides start/resume,
  any native response naming a different persistent thread conservatively
  triggers the guard (including fork or an unfamiliar method). Relaunch `ink` and
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
yarn workspace @inklabs/cli exec vitest run src/lib/codex-mail
node scripts/probe-codex-live-input.mjs --gateway --permissions-probe
node scripts/probe-codex-live-input.mjs --wrapper
```

The opt-in probes use a fresh HOME/CODEX_HOME/cwd, a synthetic local provider,
no credentials, and no model-executed tools. `--wrapper` also uses a stub Inkwell
API and the actual Inkwell lifecycle hooks; its trust keystrokes apply **only**
to hooks in the disposable fixture. Evidence stays outside git. Unit tests cover
ambiguous acceptance, restart/ACK failure, exact receipts, scope, approvals,
permission mapping, heartbeat failure and direct-node parent death, including
a helper-disabled negative control with a self-terminating fake owner.

Protocol references: [Codex App Server](https://learn.chatgpt.com/docs/app-server)
and [Codex hooks and explicit trust](https://learn.chatgpt.com/docs/hooks).
