# Google credentials: cloud connection and desktop login

Inkwell's Google integrations (Gmail, Calendar, Drive, Docs, Sheets) can draw on
two credential sources. Both grant the same scopes; the server tries them in the
order `GOOGLE_CREDENTIAL_SOURCES` lists (default `cloud,desktop`).

| Source    | Where it lives                                  | How you get it                                  |
| --------- | ----------------------------------------------- | ----------------------------------------------- |
| `cloud`   | `connected_accounts` table                      | Dashboard → Connected Accounts → Connect Google |
| `desktop` | `~/.ink/google/<email>.json` on the server host | `ink google login` with a Desktop OAuth client  |

A desktop file is bound to an Inkwell user **only by email**: the file's `email`
must equal the user's account email. A file for anyone else is invisible to
that user. This matters because one server serves several users and the files
sit in the operator's home directory.

## Why you keep having to reconnect (and the real fix)

Google expires refresh tokens after **7 days** for any OAuth client whose Google
Cloud project has an External consent screen in **Testing** status. That applies
to the dashboard connection and to a desktop login alike; neither source
escapes it. The fix is two clicks in Google Cloud Console:

1. APIs & Services → OAuth consent screen (Audience) → **Publish app** → Confirm.
   This moves the app to "In production" and does **not** submit it for
   verification. Users see an "unverified app" interstitial once; refresh tokens
   stop expiring.
2. Reconnect once (dashboard) or `ink google login` once (desktop).

gog gives the same advice for the same reason.

## Desktop login

1. In Google Cloud Console, create an OAuth client of type **Desktop app** and
   download its JSON. This is the same file `gog auth credentials` takes; one
   client can serve both.
2. On the machine that runs the Inkwell server:

   ```bash
   ink google login --client ~/Downloads/client_secret_XXXX.json
   ```

   The client is copied to `~/.ink/google/client.json`; later logins need no
   flag. A browser opens (`--no-browser` prints the URL instead), Google
   redirects to a one-shot listener on `127.0.0.1`, and the refresh token is
   written to `~/.ink/google/<email>.json` (mode 0600).

3. The server picks the file up on the next Google call. No restart.

```bash
ink google status           # what is stored
ink google status --check   # ask Google whether each login still refreshes
ink google logout you@example.com
```

`INK_GOOGLE_CREDENTIALS_DIR` moves the directory for both the CLI and the
server.

### File shape

```json
{
  "type": "authorized_user",
  "client_id": "…",
  "client_secret": "…",
  "refresh_token": "…",
  "email": "you@example.com",
  "scopes": ["https://www.googleapis.com/auth/gmail.readonly", "…"],
  "obtained_at": "2026-09-08T18:00:00.000Z",
  "source": "ink google login"
}
```

The first four keys are Google's `authorized_user` format (what `gcloud auth
application-default login` writes). The `email` key is required — without it
there is nothing to bind the file to.

## How the server chooses

`OAuthService.getValidAccessToken(userId, 'google')` walks the configured
sources. A source with nothing bound to the user is skipped silently; a source
that had a credential and failed is named in the error:

```
No usable google credential — cloud: Failed to refresh google token; desktop: Google refused the desktop credential /Users/you/.ink/google/<account>.json (400): {"error":"invalid_grant",…}
```

A user with no desktop file sees exactly the errors they always saw.

`get_integration_health` and `GET /api/admin/connected-accounts` report which
source the verdict describes (`accountSource` / `desktopCredentials`), so "the
cloud row expired but the desktop file is serving" is visible rather than
inferred.

A refusal from Google (`invalid_grant`, `invalid_client`) is remembered against
a digest of the file's bytes: later calls fail fast with the same reason until a
new login writes a new refresh token, and touching the file without changing it
changes nothing. Network failures are not remembered. The server reads each
file's content and metadata through one open handle, so an atomic re-login
(temp file + rename) can never pair old bytes with a new timestamp.

A credential file the server cannot read or parse is not "no file": the binding
for that user is reported as unknown (with a count, never other people's
filenames), while a readable file bound to a different user keeps working.
