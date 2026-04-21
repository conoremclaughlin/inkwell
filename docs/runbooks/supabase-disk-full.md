# Runbook: Local Supabase disk full / Docker VM out of space

## Symptom

- Supabase local stack suddenly fails. The Inkwell server logs:
  ```
  code: 'PGRST002',
  message: 'Could not query the database for the schema cache. Retrying.'
  ```
- `docker ps` shows containers running but DB operations hang or 503.
- Supabase Studio (localhost:54323) returns 502/503.
- `docker system df` shows the VM filesystem at or near 100%.

## Quick diagnosis

Always check two things, in this order:

1. **Docker VM disk** — the Linux VM that hosts containers has a fixed-size
   disk image (`~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw`
   on macOS, 64 GiB by default). If it fills up, Postgres can't write WAL.
   ```bash
   docker run --rm --privileged -v /:/host alpine df -h /host/var/lib/docker
   ```
2. **Container log sizes** — the default json-file driver has no rotation
   and grows forever.
   ```bash
   docker run --rm --privileged -v /:/host alpine \
     sh -c 'du -sh /host/var/lib/docker/containers/*/*.log 2>/dev/null | sort -h | tail -10'
   ```

On 2026-04-19 the culprit was a single Kong container log at **46.8 GB**
(9.4 GB/day × 5 days of no rotation) caused by a retry stampede hammering
a 503-ing PostgREST.

## Recovery (non-destructive)

Truncate the offending container log in place — Docker tolerates this and
the container keeps running:

```bash
# Find the biggest offender.
docker run --rm --privileged -v /:/host alpine \
  sh -c 'du -sh /host/var/lib/docker/containers/*/*.log 2>/dev/null | sort -h | tail -5'

# Truncate it (substitute the container ID prefix).
docker run --rm --privileged -v /:/host alpine \
  truncate -s 0 /host/var/lib/docker/containers/<prefix>/<prefix>-json.log
```

Postgres should recover via WAL replay within seconds. Verify:

```bash
docker exec supabase_db_pcp psql -U postgres -c 'select 1;'
# expect: ?column? → 1
```

If Postgres doesn't come back on its own, restart just the DB container
(do NOT `docker compose down -v` — that drops data):

```bash
docker restart supabase_db_pcp
```

## Root cause & prevention

Two amplifying factors turned a normal brownout into an outage:

1. **No Docker log rotation.** The default json-file driver keeps logs
   forever. See `docs/setup/docker-log-rotation.md` for the fix: set
   `max-size` / `max-file` in `~/.docker/daemon.json`.

2. **Retry stampedes with no backoff.** Callers like `ink wait` and the
   Inkwell server's `resolveUser` were hitting PostgREST every 15s or on
   every tool call during the brownout. Each 503 became a Kong log entry.
   Fixed in the same PR:
   - `packages/api/src/utils/supabase-retry.ts` — retry + circuit breaker
     for Supabase calls.
   - `packages/api/src/services/user-resolver.ts` — wrapped in
     `withSupabaseRetry`.
   - `packages/cli/src/commands/wait.ts` — exponential backoff on
     consecutive poll errors.

## After recovery

- Check for pathological callers that have been hot-retrying for hours:
  ```bash
  docker logs --since 1h supabase_kong_pcp 2>&1 | grep -c '503'
  ```
- Confirm `~/.docker/daemon.json` has rotation enabled. Restart Docker
  Desktop after changing it.
- Consider raising the Docker VM disk size (Docker Desktop → Settings →
  Resources → Advanced → Disk image size) if your dataset genuinely needs it.
