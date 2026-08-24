# Alerting & webhooks

General alerting infrastructure: anything can POST an alert, and it fans out to
Conor, to the SBs, and to any registered outbound webhook.

It is deliberately **not** an inkwell feature. Nothing in the alert path needs a
session, an agent, or a model, because the outage that motivated it — the Docker
filesystem filling on 2026-08-24 and taking down inkwell, inkread and inktrade
together — is exactly the outage that kills sessions, agents and models first.

## The load-bearing constraint

> The checker must not depend on the thing it is reporting on.

Two corollaries that shaped the design:

- **No LLM in the checker.** When the box is out of disk, sessions do not spawn
  and triggers die. An agent-based monitor is downstream of the very failure it
  exists to report.
- **Not a scheduled reminder either.** Reminders are dispatched by the inkwell
  server, which is one of the processes the outage kills. A reminder and a cron
  job are not interchangeable here: only one of them still runs.

So the checker is a shell script on cron, and if it cannot reach inkwell it
delivers to Telegram directly.

## Parts

| Piece                                               | Where                               | Role                                                                |
| --------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------- |
| `POST /api/alerts`                                  | `packages/api/src/routes/alerts.ts` | Ingest. Dedupes, decides who to tell, fans out.                     |
| `POST /api/alerts/checkin`                          | same                                | Liveness ping. Silence past a promised cadence is itself alertable. |
| `GET /api/alerts`                                   | same                                | Recent events (bearer auth).                                        |
| `GET /api/alerts/sources`                           | same                                | Monitor liveness with a computed staleness verdict.                 |
| `ink-disk-monitor.sh`                               | `scripts/`                          | The checker. Disk + Docker, no LLM, Telegram fallback.              |
| `alert_events` / `alert_sources` / `alert_webhooks` | migration `20260824222928`          | Dedupe state, liveness, outbound registry.                          |

## Server configuration

```bash
# .env.local
ALERT_INGEST_TOKEN=<long random string>
ALERT_INGEST_USER_ID=<your user uuid>
```

Both are required together. The token is bound to one configured user rather
than trusting a `userId` in the request body — otherwise one leaked secret
becomes an alerting channel for every user in the system.

Requests may authenticate with **either** `x-ink-alert-token` (for dumb
checkers) or a normal `Authorization: Bearer` PCP JWT (for SBs and services).

## Checker configuration

`~/.ink/monitor.env`:

```bash
INK_ALERT_URL=http://localhost:3001/api/alerts
INK_ALERT_TOKEN=<same value as ALERT_INGEST_TOKEN>
INK_CRITICAL_GB=4          # wake him regardless of hour
INK_WARNING_GB=10
INK_MONITOR_INTERVAL=300

# Fallback used ONLY when inkwell is unreachable
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_CHAT_ID=<chat id>

# Optional external dead-man's switch (see below)
INK_DEADMAN_URL=https://hc-ping.com/<uuid>
```

Install on cron:

```bash
crontab -e
*/5 * * * * /path/to/scripts/ink-disk-monitor.sh >> ~/.ink/logs/disk-monitor.log 2>&1
```

Exit codes: `0` healthy · `1` warning raised · `2` critical raised · `3` ran but
could not report.

## The 4 GB threshold

Agreed between Conor and Myra on 2026-08-20, after the disk hit 100% overnight
(850 of 926 GB, bottoming out at 864 MB free): **below 4 GB free on any check,
wake him regardless of hour.**

Encoded as a property of _severity_, not of the disk monitor — `critical`
bypasses quiet hours for every source. An alarm that politely waits until
morning is not an alarm.

## Dedupe, cooldown, escalation

A 5-minute cron raising the same condition would otherwise send 288 messages a
day. So:

- Posts sharing a `dedupeKey` collapse onto **one open incident**, incrementing
  `occurrence_count`.
- Re-notification waits out `cooldownSeconds` (default 1h).
- **Escalation speaks immediately.** warning → critical re-notifies mid-cooldown,
  because a condition getting worse is new information.
- De-escalation does not. Improvement is not urgent.
- `status: "ok"` resolves the incident and sends **one** recovery notice — and
  only if the incident was ever announced, since recovering from an alarm nobody
  heard is not news.

Ingest is a single `INSERT ... ON CONFLICT` against a partial unique index, not
a read-then-write. Two checkers posting the same condition at once is ordinary,
and the read-then-write version loses all but one of those posts to a duplicate
key error — the same race fixed in #536.

## Liveness: why silence is a signal

An empty result and a broken pipe are indistinguishable from the inside. A
monitor that only speaks when something is wrong is indistinguishable from a
monitor that has died.

So every run posts a check-in, `alert_sources` records the promised cadence, and
a source that goes quiet past `expected_interval_seconds × grace` raises its own
critical alert. A source that has _never_ checked in is not stale — it has made
a promise it has not yet had a chance to keep, and alarming at registration
would train everyone to ignore the alarm.

### The honest limitation

The staleness sweep runs **inside the API server**. It detects a dead _checker_.
It cannot detect a dead _box_, because if the host is what died, nothing local is
left to notice. A second local watcher does not fix this — two local watchers
die together when the disk fills, which is the failure we actually had.

The only observer that survives our outage is one that is not ours:
`INK_DEADMAN_URL`, the healthchecks.io / Dead Man's Snitch shape, where you POST
on every successful run and _they_ alarm when a POST does not arrive on
schedule. That inverts the dependency. It is optional, cheap, and boring — which
for an alarm path is a feature.

## Outbound webhooks

`alert_webhooks` rows receive matching alerts as signed POSTs:

```
x-ink-timestamp: 1787610000000
x-ink-signature: <hex hmac-sha256 of `${timestamp}.${body}` with the row secret>
```

The timestamp is inside the signed material, so a captured request cannot be
replayed later with a fresh header. Receivers should reject signatures whose
timestamp falls outside a tolerance window (`verifyWebhookSignature` defaults to
5 minutes).

Empty `severities` / `sources` arrays mean "no filter". Both must match when
both are set.

## Delivery is reported per sink

`accepted` and `delivered` are different claims. The ingest response returns a
`deliveries[]` array saying what happened to each sink, and the same array is
persisted to `alert_events.delivery`. A checker that collapses those two into
one boolean will report success through a dead Telegram token.

Sinks run concurrently and are settled independently — a refused inbox trigger,
a broken bot token, or a dead outbound webhook degrades that one sink and
nothing else. The event is written **before** any delivery is attempted, so a
throwing sink can never take the record of the incident down with it.

## Related

- `docs/runbooks/supabase-disk-full.md` — what to do once an alert fires
- `docs/setup/docker-log-rotation.md` — reducing the rate the disk fills
