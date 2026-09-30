# Live Inkmail in the native Codex terminal (experimental)

```sh
ink -b codex --codex-inkmail
```

Requires **codex-cli 0.159.2**, macOS/Linux, a registered studio, and session
tracking. Use the normal session picker to start or resume. Review the updated
Inkwell hooks in Codex's native hook-trust prompt (or `/hooks`). The launcher
**does not grant hook trust**. Until the three hooks are enabled and trusted,
mail remains unread and live delivery is paused.

This is opt-in. Without the flag, the existing launcher is unchanged. It does
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

The bridge's independent freshness probe continues while healthy mail waits
in the queue. It stops advertising a reader after disconnection, owner exit,
untrusted hooks, or stale mailbox discovery. A live owner with a broken reader
is reported, not silently treated as working delivery.

## Lifecycle and limits

- Opt-in upgrades only the recognized, marked legacy hook stanza in the local
  `.codex/config.toml` to modern `SessionStart`, `UserPromptSubmit`, and `Stop`
  handlers. Other configuration is preserved. Symlinked or modified hook
  configurations are refused; trust is still the human's decision.
- Hook inbox intake stands down while this bridge owns delivery. Hook lifecycle,
  turn epoch and lease behavior remain in the existing handlers.
- TUI exit stops and reaps the App Server before detach/identity-file cleanup.
  A detached guardian watches a wrapper-owned pipe: even wrapper SIGKILL closes
  that pipe and terminates its own child. It never kills processes by name or
  guesses a previous owner's PID.
- Switching persistent threads inside the TUI pauses mail. Relaunch `ink` and
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
