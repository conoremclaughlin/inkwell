#!/usr/bin/env bash
# `supabase <arguments>` for the root checkout's own local stack, with its
# Vault root key loaded (scripts/lib/supabase-root-key.sh):
#
#   yarn supabase:start            # supabase start
#   yarn supabase:local db reset   # any command that (re)creates the database
#
# A plain `supabase start` no longer works here: supabase/config.toml takes
# the root key from SUPABASE_DB_ROOT_KEY, and without it the database
# container keeps restarting. Commands that only talk to a running stack
# (status, stop, migration list) don't need the key.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/supabase-root-key.sh
source "${ROOT_DIR}/scripts/lib/supabase-root-key.sh"
load_supabase_root_key || exit 1
cd "${ROOT_DIR}"
exec supabase "$@"
