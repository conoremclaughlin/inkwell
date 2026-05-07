<inkmail count="{{COUNT}}">
{{MESSAGES}}
</inkmail>

<ink-reminder>
If your runtime state has changed since your last context update (started/stopped a server, opened a PR, kicked off a build, changed ports, etc.), update your session context via `update_session_phase(context: "...")` so it survives compaction. Context is your scratch board for transient active state — what's running, what's pending, what port you're on.
</ink-reminder>
