# Docker log rotation for local Supabase

## Why

By default, Docker's `json-file` logging driver keeps container logs
forever. On 2026-04-19 a single Kong container grew to **46.8 GB** of JSON
logs in five days and filled the entire Docker Desktop VM disk, taking
the local Supabase stack offline until logs were truncated.

Rotation is a one-line config. We should all enable it.

## Fix (macOS / Docker Desktop, Linux)

Create or edit `~/.docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "3",
    "compress": "true"
  }
}
```

This caps each container at ~150 MB of retained logs (3 rotations × 50 MB)
with gzip compression. Re-start Docker Desktop for it to take effect.

## Apply via script

```bash
./scripts/setup-docker-log-rotation.sh
```

The script writes `~/.docker/daemon.json` (merging with any existing keys
using `jq`) and prompts you to restart Docker Desktop.

## Gotchas

- **Existing containers don't pick up the new driver.** The settings
  apply to _newly created_ containers. To apply to the Supabase stack,
  restart it:
  ```bash
  supabase stop
  supabase start
  ```
  (Data is preserved — `supabase start` reuses the named volumes.)
- **Don't lower `max-size` below ~10m.** Debug logs around a real outage
  are useful; overly aggressive rotation hides them.
- If a single container is growing by gigabytes/day, rotation alone
  isn't the answer — investigate the caller (see
  `docs/runbooks/supabase-disk-full.md`).
