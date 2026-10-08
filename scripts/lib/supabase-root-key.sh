#!/usr/bin/env bash
# The local stack's Vault root key (supabase/config.toml, [db] root_key).
#
# config.toml reads the key from SUPABASE_DB_ROOT_KEY. Without the config
# line, every local stack used the Supabase CLI's built-in key, the same on
# every machine; without the variable, `supabase start` now leaves the
# database container restarting. This loads it from a file only its owner can
# read: ~/.ink/secrets/supabase-db-root-key, unless SUPABASE_DB_ROOT_KEY_FILE
# names another. It never prints the key.
#
# Losing the file loses every Vault secret in the local database: keep a copy
# in a password manager. Create one, without showing it, with:
#   mkdir -p ~/.ink/secrets && (umask 077 && set -o noclobber && openssl rand -hex 32 > ~/.ink/secrets/supabase-db-root-key)
#
# Only the root checkout's own stack reads this file. The integration harness
# (scripts/lib/integration-stack.py) and CI give each test stack a throwaway
# key of its own.

supabase_root_key_file() {
  printf '%s' "${SUPABASE_DB_ROOT_KEY_FILE:-${HOME}/.ink/secrets/supabase-db-root-key}"
}

# Exports SUPABASE_DB_ROOT_KEY from the file, or says what is wrong with the
# file, naming it, and returns 1. An inherited SUPABASE_DB_ROOT_KEY is never
# used: the file is the one source.
load_supabase_root_key() {
  local file mode key
  file="$(supabase_root_key_file)"
  unset SUPABASE_DB_ROOT_KEY
  if [[ -L "${file}" ]]; then
    echo "[supabase] The Vault root key file ${file} is a symbolic link; keep the key in the file itself." >&2
    return 1
  fi
  if [[ ! -f "${file}" ]]; then
    echo "[supabase] No Vault root key file at ${file}." >&2
    echo "[supabase] The local stack needs one (supabase/config.toml, [db] root_key). Create it with:" >&2
    echo "[supabase]   mkdir -p \"$(dirname "${file}")\" && (umask 077 && set -o noclobber && openssl rand -hex 32 > \"${file}\")" >&2
    echo "[supabase] and keep a copy in a password manager: losing it loses every Vault secret." >&2
    echo "[supabase] If the stack already holds Vault secrets, restore the file from that copy instead." >&2
    return 1
  fi
  # Permission bits after the owner's (ls -l is the same on macOS and Linux).
  mode="$(ls -l "${file}" | cut -c5-10)"
  if [[ "${mode}" != "------" ]]; then
    echo "[supabase] The Vault root key file ${file} can be read by others; run: chmod 600 \"${file}\"" >&2
    return 1
  fi
  key="$(tr -d '[:space:]' < "${file}")"
  if [[ ! "${key}" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "[supabase] The Vault root key file ${file} must hold 64 hexadecimal characters (openssl rand -hex 32)." >&2
    return 1
  fi
  export SUPABASE_DB_ROOT_KEY="${key}"
}
