# CodeQL priority remediation

Scope: the 69 open default-branch alerts inventoried on 2026-09-15
(2 critical, 58 high, 9 medium). Alert numbers below refer to that inventory,
not a claim that default-branch alerts close before this branch is merged.

## Alert ledger

| Alerts     | Boundary and disposition                                                                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 65         | Remove shell-based skill directory deletion; validate names and reject canonical symlinks.                                                                                                                              |
| 66         | Explicit shell-free argv, docker option terminator, and mocked runner fixtures. The reported shell flow crossed test/production call sites; separately terminate remote Codex prompt options on fresh and resume paths. |
| 67–70      | Replace interpolated shell commands with argument-vector execution in doctor and test helpers.                                                                                                                          |
| 16–42      | Validate studio components and final normalized durable/ephemeral paths before materialization. Media additionally retains realpath and regular-file checks.                                                            |
| 60–63      | Render fixed OAuth callback pages; provider/query/error/account strings do not enter HTML. Validate provider-bound state before consumption.                                                                            |
| 56, 57, 59 | Replace regex HTML filtering with sanitize-html parsing, allowing no tags or attributes. Prompt sanitization is not authorization or execution isolation.                                                               |
| 58         | Replace partial regex escaping in an attachment test with a literal assertion.                                                                                                                                          |
| 45–55      | Apply configurable ingress/OAuth rate limits before route work. Direct loopback clients are deliberately exempt by default; requests carrying forwarding indicators are not.                                            |
| 44         | Use crypto.randomInt for pairing symbols. The old alphabet had 32 symbols and its byte-modulo sampling was already unbiased; this preserves uniformity if the alphabet changes.                                         |
| 64         | Generate session identifiers using crypto.randomUUID.                                                                                                                                                                   |
| 4–6        | Bound email validation and replace backtracking suffix normalization with linear/bounded operations.                                                                                                                    |
| 10–12, 76  | Remove credential parse exceptions and backfill selector values from logs. Apply the same parse-error hygiene to desktop CLI credentials.                                                                               |
| 1–3        | Set workflow-wide contents:read permissions; omitted permissions receive no grant.                                                                                                                                      |
| 13–15      | Proposed false positives: remaining flows carry public Google scope labels or their count, not a token. See evidence below; reviewer approval required.                                                                 |
| 43         | Implement cookie CSRF controls on both sides of the web proxy. The query does not recognize this custom-header defense; reviewer approval required before dismissal.                                                    |
| 71         | OAuth authorization-code GET callback: protocol/design exception with state validation and no-store/no-referrer response headers, not a password collection endpoint. Reviewer approval required.                       |

No rule exclusions, inline suppressions, or alert dismissals are included.

## Remaining scanner findings: review evidence

### Public permission names (13–15)

`missingGoogleScopes()` filters the static `GOOGLE_OAUTH_SCOPES` list. The CLI
prints those missing permission URLs or the number of missing permissions.
The residual `stdout-purity.ts` finding follows the same data through the
console-to-stderr adapter. The original backfill-selector flow through that
adapter has been removed at its source. Removing useful permission diagnostics
or renaming a constant just to evade a sensitive-name heuristic is not a fix.

### Cookie mutations and the web proxy (43)

A bearer header alone is not proof against CSRF here: the dashboard proxy
manufactures it from ambient cookies, and an expired/invalid bearer may fall
back to a refresh cookie on the API.

- The web proxy validates exact Origin, or Referer when Origin is absent,
  before any credential conversion. Opaque origins and same-site siblings are
  rejected. Target origin comes from the actual request URL, not an untrusted
  forwarded-host header; custom ports and LAN hosts remain supported.
  Next.js URL normalization is disabled so loopback IP literals retain their
  actual browser origin instead of being rewritten to localhost. Local host
  aliases and different ports are still distinct origins, not exemptions.
- After that check, the proxy supplies `X-Inkwell-CSRF: 1`. This is a
  **non-simple request header**, not a secret token. Incoming copies cannot
  bypass the proxy's origin check.
- Unsafe API requests carrying cookies require that header, even if they also
  carry Authorization. Direct cookie clients must provide it too. Cookie-free
  native bearer clients do not need it.
- The API's existing credentialed CORS origin allowlist remains explicit and
  unchanged. Tests verify that untrusted origins cannot preflight the header.
- GET/HEAD/OPTIONS remain exempt; OAuth callbacks rely on their separate,
  provider-bound, expiring, single-use state.

This follows the [OWASP custom-header API defense](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#employing-custom-request-headers-for-ajaxapi),
with origin verification at the cookie-to-bearer boundary. Do not widen
credentialed CORS or add cookie-authenticated mutations using safe HTTP methods
without revisiting the defense. Reverse proxies must preserve the web request's
original host/protocol. These controls do not address XSS or client-side CSRF.

CodeQL's `MissingCsrfMiddleware.ql` recognizes certain token libraries and
cookie/session token comparisons, not this non-simple-header design. A clean
scan must not be manufactured by adding a cosmetic token comparison.

### Authorization-code callback (71)

The GET parameter is an OAuth authorization code received from the provider.
It is exchanged server-side; fixed callback HTML does not interpolate it.
State is scalar, provider-bound, expiring and consumed once; responses forbid
caching and referrer propagation. URL-bearing infrastructure logs must still
be treated as sensitive. Moving this callback to POST unilaterally would break
provider redirects rather than resolve the protocol's exposure tradeoff.

## Operational limits and verification

- Rate budgets are in memory, per process and socket IP. The defaults are
  1,200 requests/minute aggregate and an additional shared 60/minute on the
  OAuth endpoints. Existing tighter mobile account/IP limits remain unchanged,
  including for localhost. OAuth-rejected attempts still consume the aggregate
  budget; no capacity is reserved for lifecycle traffic.
- Direct loopback clients (127.0.0.0/8, ::1 and mapped IPv4 equivalents) are
  exempt from these two new budgets by default. This changes neither
  authentication nor CORS/CSRF. Forwarding indicators (`Forwarded`,
  `X-Forwarded-*`, `CF-*`, `X-Real-IP`, `True-Client-IP`, `Via`, `CDN-Loop`)
  remove the exemption even when empty or claiming localhost. Their values
  are never used to grant an exemption or choose a budget key. Thus a local
  dashboard proxy can still share a limited bucket with other forwarded traffic.
- A headerless local proxy is indistinguishable from a direct local client.
  Disable the loopback exemption for that deployment; do not assume this
  heuristic proves network provenance. Future explicit proxy trust and client
  attribution are specified in the shared artifact **ink://specs/http-rate-limiting**.
  No Cloudflare header trust or blanket Express trust-proxy is enabled here.
- The following environment variables are validated at startup. Numeric values
  must be positive decimal integers (zero is not a disable switch); windows
  are bounded to Node's timer capacity. Invalid values fail startup rather than
  silently removing protection. Changes require a server restart, not a rebuild:

  | Variable                         | Default | Purpose                                                      |
  | -------------------------------- | ------- | ------------------------------------------------------------ |
  | `INK_HTTP_RATE_LIMIT_MAX`        | `1200`  | Aggregate requests per window                                |
  | `INK_HTTP_RATE_LIMIT_WINDOW_MS`  | `60000` | Aggregate window in milliseconds                             |
  | `INK_OAUTH_RATE_LIMIT_MAX`       | `60`    | Shared OAuth requests per window                             |
  | `INK_OAUTH_RATE_LIMIT_WINDOW_MS` | `60000` | OAuth window in milliseconds                                 |
  | `INK_RATE_LIMIT_EXEMPT_LOOPBACK` | `true`  | Direct-loopback exemption; use `false` to count all requests |

  A reverse proxy or NAT still shares a budget for non-exempt traffic. This is
  neither a distributed quota nor a concurrency limit or substitute for authorization.

- Studio roots remain operator-selected. Normalized path containment is not
  a general filesystem sandbox against a hostile local process replacing
  symlinks. No tenant or repository authorization policy is broadened.
- Security payloads are tested on pure guards or mocked process boundaries.
  Real executor probes use harmless commands. The old dangerous Pi adapter
  fixtures now stop at the guard; an echo sentinel tests refusal wiring.
- Attachment fixtures are invented. Removing an old fixture from the current
  tree does not purge previously published history; that is tracked separately.
- Record exact local and hosted scan results, focused test counts, and CI status
  in the PR. Never equate a passing heuristic scan with absence of secrets or
  vulnerabilities.
