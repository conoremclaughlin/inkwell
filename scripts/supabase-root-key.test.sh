#!/usr/bin/env bash
# Regression coverage for the local stack's Vault root key:
# scripts/lib/supabase-root-key.sh (load it from its file), the wrapper
# scripts/supabase-local.sh (yarn supabase:start), and
# scripts/setup-local-supabase.sh (which must load it before `supabase start`).
#
# Hermetic: HOME is a temp dir, `supabase` and `docker` are stubs on PATH that
# record their calls, and the key is random per run, made here. The stub
# reports whether it was given the key by comparing hashes; no output of this
# test ever contains the key.
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/root-key-test.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT
export HOME="${WORK}/home"
mkdir -p "${HOME}" "${WORK}/bin"
CALLS="${WORK}/calls"
KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
KEY_HASH="$(printf '%s' "${KEY}" | shasum -a 256 | cut -c1-64)"

cat > "${WORK}/bin/supabase" <<'EOF'
#!/usr/bin/env bash
given=$(printf '%s' "${SUPABASE_DB_ROOT_KEY:-}" | shasum -a 256 | cut -c1-64)
echo "supabase $* key=${given}" >> "${STUB_CALLS}"
EOF
cat > "${WORK}/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "${STUB_CALLS}"
EOF
chmod +x "${WORK}/bin/supabase" "${WORK}/bin/docker"
export PATH="${WORK}/bin:${PATH}"
export STUB_CALLS="${CALLS}"

pass=0
fail=0
ok() {
  pass=$((pass + 1))
  printf 'ok   %s\n' "$1"
}
bad() {
  fail=$((fail + 1))
  printf 'FAIL %s: %s\n' "$1" "$2"
}

FILE="${HOME}/.ink/secrets/supabase-db-root-key"
write_key() {
  mkdir -p "$(dirname "${FILE}")"
  rm -f "${FILE}"
  (umask 077 && printf '%s\n' "$1" > "${FILE}")
}

# Runs the loader in a subshell; prints what it exported, as a hash, and its stderr.
load() {
  (
    # shellcheck source=lib/supabase-root-key.sh
    source "${ROOT_DIR}/scripts/lib/supabase-root-key.sh"
    if load_supabase_root_key 2>"${WORK}/err"; then
      printf 'loaded %s\n' "$(printf '%s' "${SUPABASE_DB_ROOT_KEY}" | shasum -a 256 | cut -c1-64)"
    else
      printf 'refused set=%s\n' "${SUPABASE_DB_ROOT_KEY+yes}"
    fi
  )
}

# 1. A good key file is loaded, exactly, and nothing prints it.
write_key "${KEY}"
out="$(load)"
if [ "${out}" = "loaded ${KEY_HASH}" ] && ! grep -q "${KEY}" "${WORK}/err"; then
  ok "a key file only its owner can read is loaded exactly"
else
  bad "a key file only its owner can read is loaded exactly" "${out}"
fi

# 2. No file: refused, the file is named, and an inherited key is not used.
rm -f "${FILE}"
out="$(SUPABASE_DB_ROOT_KEY="${KEY}" load)"
if [ "${out}" = "refused set=" ] && grep -q "${FILE}" "${WORK}/err" && grep -q "openssl rand -hex 32" "${WORK}/err"; then
  ok "a missing file is refused, named, with how to make one, and an inherited key is not used"
else
  bad "a missing file is refused, named, with how to make one, and an inherited key is not used" "${out}: $(cat "${WORK}/err")"
fi

# 3. A file others can read is refused.
write_key "${KEY}"
chmod 644 "${FILE}"
out="$(load)"
if [ "${out}" = "refused set=" ] && grep -q "chmod 600" "${WORK}/err" && ! grep -q "${KEY}" "${WORK}/err"; then
  ok "a key file others can read is refused, without printing it"
else
  bad "a key file others can read is refused, without printing it" "${out}"
fi

# 3b. An access control list is refused whatever the mode, with how to remove
# it. macOS: an `everyone allow read` entry, which leaves the mode bits at 600
# and (with any extended attribute) shows `@` rather than `+` in ls -l. Linux:
# a named entry with its mask emptied, so the mode bits still read 600 and only
# the list itself shows it.
write_key "${KEY}"
acl_repair=""
if [[ "$(uname -s)" == "Darwin" ]]; then
  chmod +a 'everyone allow read' "${FILE}" && acl_repair="chmod -N"
elif command -v setfacl >/dev/null 2>&1; then
  setfacl -m u:nobody:r,m::--- "${FILE}" && acl_repair="setfacl -b"
fi
if [[ -n "${acl_repair}" ]]; then
  out="$(load)"
  if [ "${out}" = "refused set=" ] && grep -q "access control list" "${WORK}/err" &&
    grep -q "${acl_repair}" "${WORK}/err" && ! grep -q "${KEY}" "${WORK}/err"; then
    ok "a key file with an access control list is refused, with ${acl_repair} to remove it"
  else
    bad "a key file with an access control list is refused, with ${acl_repair} to remove it" "${out}: $(cat "${WORK}/err")"
  fi
  if [[ "${acl_repair}" == "chmod -N" ]]; then chmod -N "${FILE}"; else setfacl -b "${FILE}"; fi
  out="$(load)"
  if [ "${out}" = "loaded ${KEY_HASH}" ]; then
    ok "once the access control list is removed, the key loads"
  else
    bad "once the access control list is removed, the key loads" "${out}: $(cat "${WORK}/err")"
  fi
else
  printf 'skip an access control list is refused (no ACL tool on this platform)\n'
fi

# 3c. An access control list that can't be read is refused, not taken as none:
# stubs make `ls -le` (macOS) and `getfacl` (Linux) fail.
mkdir -p "${WORK}/no-acl-bin"
cat > "${WORK}/no-acl-bin/ls" <<'EOF'
#!/usr/bin/env bash
for argument in "$@"; do [[ "${argument}" == "-le" ]] && exit 1; done
exec /bin/ls "$@"
EOF
printf '#!/usr/bin/env bash\nexit 1\n' > "${WORK}/no-acl-bin/getfacl"
chmod +x "${WORK}/no-acl-bin/ls" "${WORK}/no-acl-bin/getfacl"
write_key "${KEY}"
out="$(PATH="${WORK}/no-acl-bin:${PATH}" load)"
if [ "${out}" = "refused set=" ] && grep -q "Could not read the access control list" "${WORK}/err"; then
  ok "an access control list that can't be read is refused"
else
  bad "an access control list that can't be read is refused" "${out}: $(cat "${WORK}/err")"
fi

# 4. A file that isn't 64 hexadecimal characters is refused.
for content in "short" "${KEY}0" "${KEY:0:63}z"; do
  write_key "${content}"
  out="$(load)"
  if [ "${out}" = "refused set=" ] && grep -q "64 hexadecimal" "${WORK}/err"; then
    ok "a malformed key file is refused (${#content} characters)"
  else
    bad "a malformed key file is refused (${#content} characters)" "${out}"
  fi
done

# 5. A symlink is refused, even to a good key.
write_key "${KEY}"
mv "${FILE}" "${WORK}/real-key"
ln -s "${WORK}/real-key" "${FILE}"
out="$(load)"
if [ "${out}" = "refused set=" ] && grep -q "symbolic link" "${WORK}/err"; then
  ok "a symlinked key file is refused"
else
  bad "a symlinked key file is refused" "${out}"
fi
rm -f "${FILE}"

# 6. SUPABASE_DB_ROOT_KEY_FILE names another file.
write_key "${KEY}"
mv "${FILE}" "${WORK}/other-key"
out="$(SUPABASE_DB_ROOT_KEY_FILE="${WORK}/other-key" load)"
if [ "${out}" = "loaded ${KEY_HASH}" ]; then
  ok "SUPABASE_DB_ROOT_KEY_FILE names the file to read"
else
  bad "SUPABASE_DB_ROOT_KEY_FILE names the file to read" "${out}"
fi

# 7. The wrapper hands supabase the key and its arguments.
write_key "${KEY}"
: > "${CALLS}"
bash "${ROOT_DIR}/scripts/supabase-local.sh" start --debug >/dev/null 2>"${WORK}/err"
rc=$?
if [ "${rc}" -eq 0 ] && [ "$(cat "${CALLS}")" = "supabase start --debug key=${KEY_HASH}" ]; then
  ok "yarn supabase:start runs supabase with the key and its arguments"
else
  bad "yarn supabase:start runs supabase with the key and its arguments" "rc=${rc} $(cat "${CALLS}")"
fi

# 8. Without the file, the wrapper never runs supabase.
rm -f "${FILE}"
: > "${CALLS}"
bash "${ROOT_DIR}/scripts/supabase-local.sh" start >/dev/null 2>"${WORK}/err"
rc=$?
if [ "${rc}" -ne 0 ] && [ ! -s "${CALLS}" ] && grep -q "${FILE}" "${WORK}/err"; then
  ok "without the key file, the wrapper refuses before supabase runs, naming the file"
else
  bad "without the key file, the wrapper refuses before supabase runs, naming the file" "rc=${rc} $(cat "${CALLS}")"
fi

# 9. The setup script loads the key before it starts the stack, and stops without it.
: > "${CALLS}"
INK_ENV_FILE="${WORK}/env.local" bash "${ROOT_DIR}/scripts/setup-local-supabase.sh" >/dev/null 2>"${WORK}/err"
rc=$?
if [ "${rc}" -ne 0 ] && ! grep -q "^supabase start" "${CALLS}" && grep -q "${FILE}" "${WORK}/err"; then
  ok "yarn supabase:local:setup refuses before supabase start without the key file"
else
  bad "yarn supabase:local:setup refuses before supabase start without the key file" "rc=${rc} $(cat "${CALLS}")"
fi
write_key "${KEY}"
: > "${CALLS}"
INK_ENV_FILE="${WORK}/env.local" bash "${ROOT_DIR}/scripts/setup-local-supabase.sh" >/dev/null 2>"${WORK}/err"
if grep -q "^supabase start --workdir ${ROOT_DIR} key=${KEY_HASH}$" "${CALLS}" &&
  grep -q "^supabase db reset --workdir ${ROOT_DIR} --local key=${KEY_HASH}$" "${CALLS}"; then
  ok "yarn supabase:local:setup starts and resets the stack with the key"
else
  bad "yarn supabase:local:setup starts and resets the stack with the key" "$(cat "${CALLS}")"
fi

# 10. config.toml asks for the key from the variable this loads.
if grep -qx 'root_key = "env(SUPABASE_DB_ROOT_KEY)"' "${ROOT_DIR}/supabase/config.toml"; then
  ok "supabase/config.toml takes [db] root_key from SUPABASE_DB_ROOT_KEY"
else
  bad "supabase/config.toml takes [db] root_key from SUPABASE_DB_ROOT_KEY" "line missing"
fi

# 11. The migration-order check starts a shadow database, which takes the key
# too: the README runs it through the wrapper, never as a plain command.
readme="${ROOT_DIR}/supabase/migrations/README.md"
if grep -q '^yarn supabase:local db diff --local --schema public$' "${readme}" &&
  ! grep -qE '^supabase (start|db (diff|reset))' "${readme}"; then
  ok "the migrations README runs its shadow build through yarn supabase:local"
else
  bad "the migrations README runs its shadow build through yarn supabase:local" "$(grep -nE '^(yarn )?supabase' "${readme}")"
fi

printf '\n%d passed, %d failed\n' "${pass}" "${fail}"
[ "${fail}" -eq 0 ]
