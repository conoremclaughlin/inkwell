#!/bin/sh
# Regression coverage for the staged-file credential guard.
#
# Three tiers:
#
#   PARITY   — the vendor shapes in scripts/lib/credential-patterns.sh must be
#              byte-identical to `shapes=` in scripts/check-commit-msg.sh. Two
#              guards with two lists drift; this pins them together until the
#              message guard sources the library too.
#   SCANNER  — scripts/check-staged-files.sh called directly against a
#              disposable repository's index and commits.
#   WIRING   — .husky/pre-commit exercised through a real `git commit`. The
#              guard passing its own tests says nothing about whether the hook
#              invokes it, so the wiring gets its own tier.
#
# Every fixture is SYNTHETIC: values match the vendor shapes and are otherwise
# nonsense. No real credential appears in this file.
#
# Usage:  sh scripts/check-staged-files.test.sh
#
# GUARD_UNDER_TEST and HOOKS_UNDER_TEST point the scanner and wiring tiers at a
# deliberately broken copy so the suite can be checked for going red. A tier
# that cannot fail is not evidence.

set -u

root=$(cd "$(dirname "$0")/.." && pwd) || exit 1
guard="${GUARD_UNDER_TEST:-$root/scripts/check-staged-files.sh}"
hooks_dir="${HOOKS_UNDER_TEST:-$root/.husky}"
patterns="$root/scripts/lib/credential-patterns.sh"
msg_guard="$root/scripts/check-commit-msg.sh"

# Isolate git from the environment this suite inherits (hook-exported GIT_*
# variables, global hooksPath, command-scope config). Same reasoning as
# scripts/check-commit-msg.test.sh, which explains each line.
git_isolate() {
  unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_PREFIX \
    GIT_CONFIG GIT_CEILING_DIRECTORIES GIT_TEMPLATE_DIR GIT_INDEX_VERSION 2>/dev/null
  n=${GIT_CONFIG_COUNT:-0}
  case "$n" in '' | *[!0-9]*) n=0 ;; esac
  [ "$n" -lt 32 ] && n=32
  i=0
  while [ "$i" -lt "$n" ]; do
    unset "GIT_CONFIG_KEY_$i" "GIT_CONFIG_VALUE_$i" 2>/dev/null
    i=$((i + 1))
  done
  unset GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS 2>/dev/null
  GIT_CONFIG_GLOBAL=/dev/null
  GIT_CONFIG_SYSTEM=/dev/null
  GIT_CONFIG_NOSYSTEM=1
  export GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_NOSYSTEM
}
git_isolate

work=$(mktemp -d "${TMPDIR:-/tmp}/check-staged-files-test.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT INT TERM

# Stubs so the real pre-commit's lint-staged and yarn steps never run inside a
# fixture: npx would try to download lint-staged and yarn would look for a
# project. The guard under test runs before either, so the stubs only matter on
# the allowed path.
mkdir -p "$work/stubs"
printf '#!/bin/sh\nexit 0\n' > "$work/stubs/npx"
printf '#!/bin/sh\nexit 0\n' > "$work/stubs/yarn"
chmod +x "$work/stubs/npx" "$work/stubs/yarn"
PATH="$work/stubs:$PATH"
export PATH

nohooks="$work/nohooks"
mkdir -p "$nohooks"

pass=0
fail=0
ok() {
  pass=$((pass + 1))
  echo "  ok   $1"
}
bad() {
  fail=$((fail + 1))
  echo "  FAIL $1"
  [ $# -gt 1 ] && echo "         $2"
}

F4=FAKE
F20=$F4$F4$F4$F4$F4
F32=$F20$F4$F4$F4
F36=$F32$F4
F33=${F32}F

# A fresh repository with hooks disabled (scanner tier) or pointed at the hooks
# under test (wiring tier).
new_repo() {
  d="$work/$1"
  git init -q "$d" || return 1
  git -C "$d" config user.email tester@example.com
  git -C "$d" config user.name tester
  git -C "$d" config commit.gpgsign false
  git -C "$d" config core.hooksPath "$2"
  printf '%s\n' "$d"
}

# Stage a file with the given content, run the guard in index mode, echo status.
stage() { # repo path content
  mkdir -p "$(dirname "$1/$2")"
  printf '%s' "$3" > "$1/$2"
  # -f: a developer's global ignore file may hide fixture names like
  # .claude/settings.local.json, and the guard, not gitignore, is under test.
  git -C "$1" add -f -- "$2"
}

run_index() { # repo
  (cd "$1" && sh "$guard" 2>&1)
}

echo "PARITY (lib vs commit-msg guard)"
lib_shapes=$(sed -n "s/^shapes='\(.*\)'$/\1/p" "$patterns")
msg_shapes=$(sed -n "s/^shapes='\(.*\)'$/\1/p" "$msg_guard")
if [ -z "$lib_shapes" ]; then
  bad "credential-patterns.sh defines shapes" "no shapes= line found"
elif [ "$lib_shapes" = "$msg_shapes" ]; then
  ok "vendor shapes are byte-identical in both guards"
else
  bad "vendor shapes are byte-identical in both guards" "the two shapes= lines differ"
fi

echo "SCANNER (scripts/check-staged-files.sh)"

r=$(new_repo scan-clean "$nohooks")
stage "$r" src/thing.ts 'export const answer = 42;'
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 0 ] && ok "ordinary source file is allowed" || bad "ordinary source file is allowed" "exit $rc: $(echo "$out" | tr '\n' ' ')"

r=$(new_repo scan-empty "$nohooks")
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 0 ] && ok "empty index is allowed" || bad "empty index is allowed" "exit $rc"

r=$(new_repo scan-envlocal "$nohooks")
stage "$r" .env.local 'SUPABASE_SECRET_KEY=CANARYVALUE9182'
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok ".env.local is refused by name" || bad ".env.local is refused by name" "exit $rc: $(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q '\.env\.local' && ok "refusal names the file" || bad "refusal names the file" "$(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q CANARYVALUE9182 && bad "refusal does not print the file's content" "content leaked into output" || ok "refusal does not print the file's content"

r=$(new_repo scan-nested-env "$nohooks")
stage "$r" packages/api/.env 'X=1'
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok "nested .env is refused by name" || bad "nested .env is refused by name" "exit $rc"

r=$(new_repo scan-env-variants "$nohooks")
stage "$r" .env.production 'X=1'
stage "$r" packages/web/.env.development.local 'X=1'
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok ".env.<anything> variants are refused" || bad ".env.<anything> variants are refused" "exit $rc"
c=$(echo "$out" | grep -c -E '^\s+(\.env\.production|packages/web/\.env\.development\.local)$')
[ "$c" -eq 2 ] && ok "every refused path is listed" || bad "every refused path is listed" "listed $c of 2: $(echo "$out" | tr '\n' ' ')"

r=$(new_repo scan-example "$nohooks")
stage "$r" .env.example 'JWT_SECRET=replace-me
SUPABASE_SECRET_KEY=
GITHUB_TOKEN=your-token-here'
stage "$r" .env.docker.example 'JWT_SECRET='
stage "$r" packages/api/config.sample 'JWT_SECRET=x'
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 0 ] && ok "example, sample and docker.example templates with named placeholders are allowed" || bad "example, sample and docker.example templates with named placeholders are allowed" "exit $rc: $(echo "$out" | tr '\n' ' ')"

r=$(new_repo scan-keys "$nohooks")
stage "$r" deploy/server.pem '-----BEGIN PRIVATE KEY-----'
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok "*.pem is refused" || bad "*.pem is refused" "exit $rc"

r=$(new_repo scan-sshkey "$nohooks")
stage "$r" id_rsa 'not really'
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok "id_rsa is refused" || bad "id_rsa is refused" "exit $rc"

r=$(new_repo scan-sshpub "$nohooks")
stage "$r" keys/id_rsa.pub 'ssh-rsa AAAA public'
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 0 ] && ok "id_rsa.pub is allowed" || bad "id_rsa.pub is allowed" "exit $rc: $(echo "$out" | tr '\n' ' ')"

r=$(new_repo scan-ink "$nohooks")
stage "$r" .ink/identity.json '{"agentId":"wren"}'
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok ".ink/identity.json is refused" || bad ".ink/identity.json is refused" "exit $rc"

r=$(new_repo scan-ink-nested "$nohooks")
stage "$r" packages/api/.ink/auth.json '{}'
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok "nested .ink/auth.json is refused" || bad "nested .ink/auth.json is refused" "exit $rc"

r=$(new_repo scan-ink-skills "$nohooks")
stage "$r" .ink/skills/my-skill/SKILL.md '# fine'
stage "$r" .ink/ROLE.md 'role'
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 0 ] && ok ".ink/skills and .ink/ROLE.md stay committable" || bad ".ink/skills and .ink/ROLE.md stay committable" "exit $rc: $(echo "$out" | tr '\n' ' ')"

r=$(new_repo scan-claude-local "$nohooks")
stage "$r" .claude/settings.local.json '{}'
stage "$r" .mcp.json '{}'
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok ".claude/settings.local.json and .mcp.json are refused" || bad ".claude/settings.local.json and .mcp.json are refused" "exit $rc"

r=$(new_repo scan-claude-shared "$nohooks")
stage "$r" .claude/settings.json '{}'
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 0 ] && ok ".claude/settings.json (shared, not local) is allowed" || bad ".claude/settings.json (shared, not local) is allowed" "exit $rc: $(echo "$out" | tr '\n' ' ')"

r=$(new_repo scan-shape-gh "$nohooks")
stage "$r" src/config.ts "export const token = 'ghp_$F36';"
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok "GitHub token shape inside a source file is refused" || bad "GitHub token shape inside a source file is refused" "exit $rc: $(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q 'src/config.ts: line(s) 1' && ok "refusal reports path and line number" || bad "refusal reports path and line number" "$(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q "$F36" && bad "refusal does not print the token" "token bytes in output" || ok "refusal does not print the token"

r=$(new_repo scan-shape-supabase "$nohooks")
stage "$r" docs/notes.md "the key was sb_secret_$F20 and the bot was 12345678:AA$F33"
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok "Supabase and Telegram shapes inside markdown are refused" || bad "Supabase and Telegram shapes inside markdown are refused" "exit $rc"

r=$(new_repo scan-shape-google "$nohooks")
stage "$r" a.txt "GOCSPX-$F20"
stage "$r" b.txt "github_pat_$F20"
stage "$r" c.txt "sk-ant-$F20"
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok "Google, fine-grained GitHub and Anthropic shapes are refused" || bad "Google, fine-grained GitHub and Anthropic shapes are refused" "exit $rc"
c=$(echo "$out" | grep -c -E '^\s+[abc]\.txt: line\(s\) 1$')
[ "$c" -eq 3 ] && ok "each offending file is listed once" || bad "each offending file is listed once" "listed $c of 3: $(echo "$out" | tr '\n' ' ')"

r=$(new_repo scan-shape-short "$nohooks")
stage "$r" src/ok.ts "const prefix = 'ghp_'; const other = 'sb_secret_short';"
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 0 ] && ok "prefix-only mentions below the length floor are allowed" || bad "prefix-only mentions below the length floor are allowed" "exit $rc: $(echo "$out" | tr '\n' ' ')"

r=$(new_repo scan-binary "$nohooks")
mkdir -p "$r/assets"
printf 'PNG\000\001ghp_%s\000' "$F36" > "$r/assets/blob.bin"
git -C "$r" add assets/blob.bin
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 0 ] && ok "binary content is not scanned for shapes" || bad "binary content is not scanned for shapes" "exit $rc: $(echo "$out" | tr '\n' ' ')"

r=$(new_repo scan-index-not-worktree "$nohooks")
stage "$r" src/x.ts 'clean'
printf '%s' "ghp_$F36" > "$r/src/x.ts"   # dirty the working tree AFTER staging
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 0 ] && ok "scans the index, not the working tree" || bad "scans the index, not the working tree" "exit $rc: a working-tree edit that is not staged was scanned"

r=$(new_repo scan-commit-mode "$nohooks")
stage "$r" .env.local 'X=1'
git -C "$r" commit -q --no-verify -m 'fixture: a root commit that carries a credential file' 2>/dev/null
sha=$(git -C "$r" rev-parse HEAD)
out=$(cd "$r" && sh "$guard" --commit "$sha" 2>&1); rc=$?
[ "$rc" -eq 1 ] && ok "--commit mode refuses a credential file in a commit" || bad "--commit mode refuses a credential file in a commit" "exit $rc: $(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q 'Push blocked' && ok "--commit mode words the refusal for a push" || bad "--commit mode words the refusal for a push" "$(echo "$out" | tr '\n' ' ')"
stage "$r" src/ok.ts 'fine'
git -C "$r" rm -q --cached .env.local
git -C "$r" commit -q --no-verify -m 'fixture: clean commit' 2>/dev/null
sha=$(git -C "$r" rev-parse HEAD)
out=$(cd "$r" && sh "$guard" --commit "$sha" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "--commit mode allows a clean commit even when an earlier commit was bad" || bad "--commit mode allows a clean commit" "exit $rc: $(echo "$out" | tr '\n' ' ')"

out=$(cd "$r" && sh "$guard" --commit 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "--commit without a SHA is a usage error (exit 2)" || bad "--commit without a SHA is a usage error" "exit $rc"
out=$(cd "$r" && sh "$guard" --bogus 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "unknown argument is a usage error (exit 2)" || bad "unknown argument is a usage error" "exit $rc"

# Fail closed: a copy of the guard whose pattern library is missing.
mkdir -p "$work/orphan"
cp "$guard" "$work/orphan/check-staged-files.sh"
r=$(new_repo scan-orphan "$nohooks")
stage "$r" src/x.ts 'clean'
out=$(cd "$r" && sh "$work/orphan/check-staged-files.sh" 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "missing pattern library refuses with exit 2 rather than passing" || bad "missing pattern library refuses with exit 2" "exit $rc: $(echo "$out" | tr '\n' ' ')"

# Fail closed: a library that loads but defines nothing.
mkdir -p "$work/hollow/lib"
cp "$guard" "$work/hollow/check-staged-files.sh"
printf '#!/bin/sh\nshapes=\n' > "$work/hollow/lib/credential-patterns.sh"
out=$(cd "$r" && sh "$work/hollow/check-staged-files.sh" 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "empty pattern library refuses with exit 2" || bad "empty pattern library refuses with exit 2" "exit $rc: $(echo "$out" | tr '\n' ' ')"

echo "WIRING (.husky/pre-commit)"

msg="$work/clean.msg"
printf 'test: a clean commit message\n' > "$msg"

r=$(new_repo wire-refuse "$hooks_dir")
stage "$r" .env.local 'X=1'
out=$(git -C "$r" commit -q -F "$msg" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && ! git -C "$r" rev-parse -q --verify HEAD >/dev/null 2>&1; then
  ok "pre-commit refuses a credential file and no commit is created"
else
  bad "pre-commit refuses a credential file and no commit is created" "exit $rc; HEAD exists: $(git -C "$r" rev-parse -q --verify HEAD 2>/dev/null || echo no)"
fi
echo "$out" | grep -q 'Commit blocked' && ok "hook output carries the guard's refusal" || bad "hook output carries the guard's refusal" "$(echo "$out" | tr '\n' ' ')"

r=$(new_repo wire-allow "$hooks_dir")
stage "$r" src/ok.ts 'export {};'
out=$(git -C "$r" commit -q -F "$msg" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && git -C "$r" rev-parse -q --verify HEAD >/dev/null 2>&1; then
  ok "pre-commit allows a clean commit through to the rest of the hook"
else
  bad "pre-commit allows a clean commit" "exit $rc: $(echo "$out" | tr '\n' ' ')"
fi

# The hook must fail closed when the guard it points at is missing.
mkdir -p "$work/broken-hooks/.husky"
cp "$hooks_dir/pre-commit" "$work/broken-hooks/.husky/pre-commit"
chmod +x "$work/broken-hooks/.husky/pre-commit"
r=$(new_repo wire-broken "$work/broken-hooks/.husky")
stage "$r" src/ok.ts 'export {};'
out=$(git -C "$r" commit -q -F "$msg" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && ! git -C "$r" rev-parse -q --verify HEAD >/dev/null 2>&1; then
  ok "pre-commit with a missing guard refuses rather than falling open"
else
  bad "pre-commit with a missing guard refuses rather than falling open" "exit $rc"
fi
echo "$out" | grep -q 'missing its readable staged-file guard' && ok "missing-guard refusal says what is missing" || bad "missing-guard refusal says what is missing" "$(echo "$out" | tr '\n' ' ')"

echo ""
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
