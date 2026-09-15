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
# nonsense. No real credential appears in this file. The personal-data cases
# (ADDRESSES, MARKERS, --tree) use an invented marker and assemble any address
# that must be refused at runtime from a variable, so this file itself passes
# the tree-wide scan CI runs over every tracked file.
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

# Every case runs with a private-marker list present, because the guard
# refuses to run without one (MARKERS in scripts/check-staged-files.sh). The
# list is synthetic — one nonsense marker, a comment and a blank line — so the
# comment/blank filter is exercised on every run, not only in its own case.
markers_fixture="$work/private-markers"
printf '# synthetic marker list for the suite\n\nCANARYPERSON\n' > "$markers_fixture"
INK_PRIVATE_MARKERS="$markers_fixture"
export INK_PRIVATE_MARKERS

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

# Quoted paths (Lumen r1 #1): git's --name-only C-quotes a quote, a tab or a
# non-ASCII byte, and `git show` of the quoted rendering fails. The token must
# still be found, and a clean file under such a name must still pass.
for name in 'café.txt' 'quoted"name.txt' 'tab	name.txt'; do
  r=$(new_repo "scan-quoted-$pass" "$nohooks")
  stage "$r" "$name" "token ghp_$F36"
  out=$(run_index "$r"); rc=$?
  [ "$rc" -eq 1 ] && ok "token inside a file named [$name] is refused" || bad "token inside a file named [$name] is refused" "exit $rc: $(echo "$out" | tr '\n' ' ')"
  echo "$out" | grep -qF "$name: line(s) 1" && ok "refusal reports the unquoted path for [$name]" || bad "refusal reports the unquoted path for [$name]" "$(echo "$out" | tr '\n' ' ')"
done
r=$(new_repo scan-quoted-env "$nohooks")
stage "$r" 'ümlaut/.env.local' 'X=1'
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok "a credential file under a non-ASCII directory is refused by name" || bad "a credential file under a non-ASCII directory is refused by name" "exit $rc: $(echo "$out" | tr '\n' ' ')"
r=$(new_repo scan-quoted-clean "$nohooks")
stage "$r" 'café.txt' 'nothing to see'
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 0 ] && ok "a clean file under a quoted name still passes" || bad "a clean file under a quoted name still passes" "exit $rc: $(echo "$out" | tr '\n' ' ')"

# A path containing a newline cannot be carried losslessly: refuse, never misread.
r=$(new_repo scan-newline "$nohooks")
stage "$r" 'two
lines.txt' 'clean'
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 2 ] && ok "a path containing a newline fails closed (exit 2)" || bad "a path containing a newline fails closed" "exit $rc: $(echo "$out" | tr '\n' ' ')"

# A blob read that fails is a scan that did not happen (Lumen r1 #1): stub git
# so `git show` exits 128 and everything else is real.
mkdir -p "$work/gitstub"
realgit=$(command -v git)
printf '#!/bin/sh\nif [ "$1" = show ]; then exit 128; fi\nexec %s "$@"\n' "$realgit" > "$work/gitstub/git"
chmod +x "$work/gitstub/git"
r=$(new_repo scan-readfail "$nohooks")
stage "$r" ordinary.txt "token ghp_$F36"
out=$(cd "$r" && PATH="$work/gitstub:$PATH" sh "$guard" 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "a failing git show fails closed (exit 2) instead of passing" || bad "a failing git show fails closed" "exit $rc: $(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q 'ordinary.txt' && ok "the read failure names the path" || bad "the read failure names the path" "$(echo "$out" | tr '\n' ' ')"

# The conversion that FEEDS THE LOOP must be checked on its own (Lumen r2 #2).
# The stub counts `tr '\000' '\n'` calls and faults only the second, which is
# the shape that mattered: the counts succeeded, the feed did not, and the loop
# then scanned nothing and reported clean. The assertion is the security
# contract rather than a specific code — with a token staged and a conversion
# faulted, the guard must NOT report clean.
mkdir -p "$work/trstub"
realtr=$(command -v tr)
cat > "$work/trstub/tr" <<'TRSTUB'
#!/bin/sh
if [ "$1" = '\000' ] && [ "$2" = '\n' ]; then
  n=0
  [ -f "$TR_COUNT" ] && read -r n < "$TR_COUNT"
  n=$((n + 1))
  printf '%s\n' "$n" > "$TR_COUNT"
  if [ "$n" -eq "$TR_FAIL_AT" ]; then
    printf '%s\n' 'synthetic path conversion failure' >&2
    exit 2
  fi
fi
exec "$REAL_TR" "$@"
TRSTUB
chmod +x "$work/trstub/tr"

r=$(new_repo scan-trfail-second "$nohooks")
stage "$r" ordinary.txt "token ghp_$F36"
rm -f "$work/tr-count"
out=$(cd "$r" && PATH="$work/trstub:$PATH" TR_COUNT="$work/tr-count" TR_FAIL_AT=2 REAL_TR="$realtr" sh "$guard" 2>&1); rc=$?
[ "$rc" -ne 0 ] && ok "a faulted second path conversion never reports clean" || bad "a faulted second path conversion never reports clean" "exit 0 with a token staged: $(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q "$F36" && bad "second-conversion failure prints no value" "token bytes in output" || ok "second-conversion failure prints no value"

r=$(new_repo scan-trfail-first "$nohooks")
stage "$r" ordinary.txt "token ghp_$F36"
rm -f "$work/tr-count"
out=$(cd "$r" && PATH="$work/trstub:$PATH" TR_COUNT="$work/tr-count" TR_FAIL_AT=1 REAL_TR="$realtr" sh "$guard" 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "a faulted path-list conversion fails closed (exit 2)" || bad "a faulted path-list conversion fails closed (exit 2)" "exit $rc: $(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q "$F36" && bad "conversion failure prints no value" "token bytes in output" || ok "conversion failure prints no value"

# Merge-only content (Lumen r1 #2): a credential file introduced in the merge
# resolution, present in neither parent's diff.
r=$(new_repo scan-merge "$nohooks")
stage "$r" base.txt 'base'; git -C "$r" commit -q --no-verify -m 'fixture: base' 2>/dev/null
git -C "$r" checkout -q -b topic; stage "$r" topic.txt 'topic'; git -C "$r" commit -q --no-verify -m 'fixture: topic' 2>/dev/null
git -C "$r" checkout -q - ; stage "$r" main.txt 'main'; git -C "$r" commit -q --no-verify -m 'fixture: main' 2>/dev/null
git -C "$r" merge -q --no-commit --no-ff topic >/dev/null 2>&1
stage "$r" .env.local 'X=1'
git -C "$r" commit -q --no-verify -m 'fixture: merge resolution' 2>/dev/null
sha=$(git -C "$r" rev-parse HEAD)
[ "$(git -C "$r" rev-list --parents -n1 "$sha" | wc -w | tr -d ' ')" -eq 3 ] || bad "fixture is a merge commit" "not a merge"
out=$(cd "$r" && sh "$guard" --commit "$sha" 2>&1); rc=$?
[ "$rc" -eq 1 ] && ok "--commit mode refuses a credential file introduced only in a merge resolution" || bad "--commit mode refuses a merge-only credential file" "exit $rc: $(echo "$out" | tr '\n' ' ')"
out=$(cd "$r" && sh "$guard" --commit "$sha~1" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "--commit mode still passes the clean first parent" || bad "--commit mode still passes the clean first parent" "exit $rc"

# Type change (Lumen r1 #4): a tracked symlink replaced by a regular file with
# a token is a T entry, which ACMR skipped.
r=$(new_repo scan-typechange "$nohooks")
stage "$r" base.txt 'base'
ln -s base.txt "$r/config.txt"; git -C "$r" add config.txt
git -C "$r" commit -q --no-verify -m 'fixture: symlink' 2>/dev/null
rm "$r/config.txt"; stage "$r" config.txt "token ghp_$F36"
git -C "$r" diff --cached --name-status | grep -q '^T' || bad "fixture is a type change" "$(git -C "$r" diff --cached --name-status)"
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok "symlink-to-file type change with a token is refused (index)" || bad "symlink-to-file type change with a token is refused (index)" "exit $rc: $(echo "$out" | tr '\n' ' ')"
git -C "$r" commit -q --no-verify -m 'fixture: typechange' 2>/dev/null
sha=$(git -C "$r" rev-parse HEAD)
out=$(cd "$r" && sh "$guard" --commit "$sha" 2>&1); rc=$?
[ "$rc" -eq 1 ] && ok "symlink-to-file type change with a token is refused (--commit)" || bad "symlink-to-file type change with a token is refused (--commit)" "exit $rc: $(echo "$out" | tr '\n' ' ')"

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

echo "ADDRESSES and MARKERS (personal data)"

# Assembled at runtime: a literal address on either of these would make this
# file fail the tree scan it exists to test.
realdom=gmail.com
lookalike=northside-clinic.com

r=$(new_repo scan-addr-reserved "$nohooks")
stage "$r" src/fixture.ts "const a = 'ada@example.com'; const b = 'x@clinic.example'; const c = 'y@host.test'; const d = 'z@nope.invalid'; const e = 'q@sub.example.co.uk'; const f = 'me@example.com.json'; const g = 'a@-example.com'; const h = 'a@example..com';"
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 0 ] && ok "reserved-domain addresses are allowed (example.*, .test, .invalid, .example, odd example forms)" || bad "reserved-domain addresses are allowed" "exit $rc: $(echo "$out" | tr '\n' ' ')"

r=$(new_repo scan-addr-legacy "$nohooks")
stage "$r" src/fixture.ts "const a = 'a@test.com'; const b = 'b@x.com'; const c = 'notify@noreply.github.com'; const d = 'id@mail.gmail.com';"
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 0 ] && ok "grandfathered and infrastructure domains are allowed, parents included" || bad "grandfathered and infrastructure domains are allowed" "exit $rc: $(echo "$out" | tr '\n' ' ')"

r=$(new_repo scan-addr-real "$nohooks")
stage "$r" src/fixture.ts "line one
const who = 'person@$realdom';
const also = 'desk@$lookalike';
const fine = 'ok@example.com';"
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok "an address on an unlisted domain is refused" || bad "an address on an unlisted domain is refused" "exit $rc: $(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q 'src/fixture.ts: line(s) 2,3' && ok "address refusal reports path and both line numbers, not the clean line" || bad "address refusal reports path and both line numbers" "$(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q "$realdom" && bad "address refusal does not print the address" "domain bytes in output" || ok "address refusal does not print the address"
echo "$out" | grep -q 'fixture-domains.sh' && ok "address refusal points at the list" || bad "address refusal points at the list" "$(echo "$out" | tr '\n' ' ')"

r=$(new_repo scan-addr-case "$nohooks")
stage "$r" a.txt "Person@$(printf '%s' "$realdom" | tr 'a-z' 'A-Z')"
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok "domain comparison folds case" || bad "domain comparison folds case" "exit $rc"

r=$(new_repo scan-addr-exempt "$nohooks")
stage "$r" .mailmap "Someone <noreply@pcp.dev> <someone@$realdom>"
stage "$r" .yarn/releases/yarn.cjs "// hello@$realdom"
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 0 ] && ok ".mailmap and .yarn/ are exempt from the address arm" || bad ".mailmap and .yarn/ are exempt from the address arm" "exit $rc: $(echo "$out" | tr '\n' ' ')"

r=$(new_repo scan-addr-nested-mailmap "$nohooks")
stage "$r" docs/.mailmap "x@$realdom"
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok "only the root .mailmap is exempt" || bad "only the root .mailmap is exempt" "exit $rc"

r=$(new_repo scan-marker-hit "$nohooks")
stage "$r" src/notes.md "first line
mentions canaryperson in lower case"
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 1 ] && ok "a private marker is refused regardless of case" || bad "a private marker is refused regardless of case" "exit $rc: $(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q 'src/notes.md: line(s) 2' && ok "marker refusal reports path and line" || bad "marker refusal reports path and line" "$(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -qi canaryperson && bad "marker refusal does not print the marker" "marker bytes in output" || ok "marker refusal does not print the marker"

r=$(new_repo scan-marker-exempt "$nohooks")
stage "$r" .mailmap "CANARYPERSON <x@example.com>"
out=$(run_index "$r"); rc=$?
[ "$rc" -eq 0 ] && ok ".mailmap is exempt from the marker arm" || bad ".mailmap is exempt from the marker arm" "exit $rc: $(echo "$out" | tr '\n' ' ')"

r=$(new_repo scan-marker-missing "$nohooks")
stage "$r" src/x.ts 'clean'
out=$(cd "$r" && INK_PRIVATE_MARKERS="$work/does-not-exist" sh "$guard" 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "a missing private-marker list refuses with exit 2 rather than passing" || bad "a missing private-marker list refuses with exit 2" "exit $rc: $(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q 'does-not-exist' && ok "the missing-list refusal names the path it looked for" || bad "the missing-list refusal names the path it looked for" "$(echo "$out" | tr '\n' ' ')"

printf '# only a comment\n\n   \n' > "$work/empty-markers"
r=$(new_repo scan-marker-empty "$nohooks")
stage "$r" src/x.ts 'clean text'
out=$(cd "$r" && INK_PRIVATE_MARKERS="$work/empty-markers" sh "$guard" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "a list of comments and blank lines is the opt-out and matches nothing" || bad "a list of comments and blank lines is the opt-out and matches nothing" "exit $rc: $(echo "$out" | tr '\n' ' ')"

printf 'CANARYPERSON\r\n' > "$work/crlf-markers"
r=$(new_repo scan-marker-crlf "$nohooks")
stage "$r" a.txt 'has canaryperson here'
out=$(cd "$r" && INK_PRIVATE_MARKERS="$work/crlf-markers" sh "$guard" 2>&1); rc=$?
[ "$rc" -eq 1 ] && ok "a CRLF marker list still matches" || bad "a CRLF marker list still matches" "exit $rc: $(echo "$out" | tr '\n' ' ')"

r=$(new_repo scan-tree "$nohooks")
stage "$r" src/ok.ts 'export {};'
git -C "$r" commit -q --no-verify -m 'fixture: clean' 2>/dev/null
out=$(cd "$r" && sh "$guard" --tree HEAD 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "--tree passes a clean tree" || bad "--tree passes a clean tree" "exit $rc: $(echo "$out" | tr '\n' ' ')"
stage "$r" src/people.ts "const p = 'person@$realdom';"
git -C "$r" commit -q --no-verify -m 'fixture: carries an address' 2>/dev/null
out=$(cd "$r" && sh "$guard" --tree 2>&1); rc=$?
[ "$rc" -eq 1 ] && ok "--tree (default HEAD) refuses a tree carrying an unlisted address" || bad "--tree (default HEAD) refuses a tree carrying an unlisted address" "exit $rc: $(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q 'Tree check failed' && ok "--tree words the refusal for a tree" || bad "--tree words the refusal for a tree" "$(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q 'src/people.ts: line(s) 1' && ok "--tree reports path and line" || bad "--tree reports path and line" "$(echo "$out" | tr '\n' ' ')"
out=$(cd "$r" && sh "$guard" --tree HEAD~1 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "--tree scans the named revision, not HEAD" || bad "--tree scans the named revision, not HEAD" "exit $rc: $(echo "$out" | tr '\n' ' ')"
out=$(cd "$r" && sh "$guard" --tree no-such-rev 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "--tree with an unknown revision fails closed (exit 2)" || bad "--tree with an unknown revision fails closed (exit 2)" "exit $rc: $(echo "$out" | tr '\n' ' ')"

# The CI opt-out, VERBATIM. /dev/null is a character device, not a regular
# file; a -f test refused it and the documented command exited 2 before
# scanning (Lumen, r1). The marker arm must be off and the other arms on.
r=$(new_repo scan-ci-optout "$nohooks")
stage "$r" src/ok.ts 'export {};'
stage "$r" src/mentions.md 'this file says canaryperson and is fine without a list'
git -C "$r" commit -q --no-verify -m 'fixture: clean tree with a marker word' 2>/dev/null
out=$(cd "$r" && INK_PRIVATE_MARKERS=/dev/null sh "$guard" --tree HEAD 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "INK_PRIVATE_MARKERS=/dev/null --tree HEAD (the exact CI command) scans and passes" || bad "INK_PRIVATE_MARKERS=/dev/null --tree HEAD (the exact CI command) scans and passes" "exit $rc: $(echo "$out" | tr '\n' ' ')"
stage "$r" src/people.ts "const p = 'person@$realdom';"
git -C "$r" commit -q --no-verify -m 'fixture: carries an address' 2>/dev/null
out=$(cd "$r" && INK_PRIVATE_MARKERS=/dev/null sh "$guard" --tree HEAD 2>&1); rc=$?
[ "$rc" -eq 1 ] && ok "with the marker arm opted out, the address arm still refuses" || bad "with the marker arm opted out, the address arm still refuses" "exit $rc: $(echo "$out" | tr '\n' ' ')"

# A directory at the marker path is not a list.
mkdir -p "$work/markers-dir"
r=$(new_repo scan-marker-dir "$nohooks")
stage "$r" src/x.ts 'clean'
out=$(cd "$r" && INK_PRIVATE_MARKERS="$work/markers-dir" sh "$guard" 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "a directory at the marker path refuses with exit 2" || bad "a directory at the marker path refuses with exit 2" "exit $rc: $(echo "$out" | tr '\n' ' ')"

# Fail closed: the credential library is present but the domain list is not.
mkdir -p "$work/nodomains/lib"
cp "$guard" "$work/nodomains/check-staged-files.sh"
cp "$patterns" "$work/nodomains/lib/credential-patterns.sh"
r=$(new_repo scan-nodomains "$nohooks")
stage "$r" src/x.ts 'clean'
out=$(cd "$r" && sh "$work/nodomains/check-staged-files.sh" 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "missing fixture-domain list refuses with exit 2 rather than passing" || bad "missing fixture-domain list refuses with exit 2" "exit $rc: $(echo "$out" | tr '\n' ' ')"

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
