#!/bin/sh
# Refuse a commit message that contains credentials.
#
# Wire this up as the commit-msg hook, which runs AFTER the shell has finished
# with the message. That timing is the whole point: on 2026-09-13 a message
# written as  git commit -m "... a \`local\` flag ..."  let zsh treat the
# backticks as command substitution, run the `local` builtin, and paste the
# entire environment — ten live secrets — into the commit. The diff was clean,
# so review saw nothing. Two commits from February had already done the same
# thing and sat on public main for seven months before anyone noticed.
#
# A pre-commit hook cannot catch this (it never sees the message) and no amount
# of documentation can, because the substitution happens before the author can
# read back what they wrote. The finished message is the only place it shows up.
#
# Usage:  scripts/check-commit-msg.sh <path-to-message-file>
# Hook:   echo 'sh "$(git rev-parse --show-toplevel)"/scripts/check-commit-msg.sh "$1"' > .husky/commit-msg

msg_file="$1"

if [ -z "$msg_file" ] || [ ! -f "$msg_file" ]; then
  echo "check-commit-msg: expected a message file path" >&2
  exit 2
fi

# Named variables we know carry real secrets, matched as an assignment.
#
# Deliberately NOT anchored to line start. A `local`/`env` dump emits one
# assignment per line, so an anchored pattern catches the leak we actually had —
# but a $(...) span splices its output mid-sentence, and an anchored pattern
# reads straight past "... honour the JWT_SECRET=<value> flag". Unanchoring
# costs nothing measurable: across the same 1500 main commits used to calibrate
# the dump threshold, both forms flag zero.
#
# The trailing class keeps prose from tripping it: a bare "set JWT_SECRET= in
# your env" has whitespace after the =, and a placeholder is written <like-this>
# or ***. This arm caught the commit message introducing it, which is how the
# exclusion got here -- and then caught the message introducing the prefix group
# below, on "... or MY_GITHUB_TOKEN=." where the value byte was a full stop.
#
# So the class is now a whitelist of bytes a credential can actually START with,
# rather than a blacklist of the punctuation we have been bitten by so far. The
# blacklist was losing a byte at a time to ordinary prose about the guard, which
# is a losing shape: every future commit discussing this file is a new chance to
# find one we had not thought of. Checked against the leaks rather than assumed
# -- none of the three quotes its values, and every named assignment in all
# three starts inside this class.
#
# The optional ([A-Za-z0-9_]*_) prefix matters more than it looks. The word
# boundary before it excludes _, so without the prefix group a name like
# PCP_JWT_SECRET= or MY_GITHUB_TOKEN= read straight through — and a dump prints
# whatever names the environment actually has, which in this repo are routinely
# prefixed. The dump arm still caught a full env dump at three lines, so the gap
# was only ever open for a mid-line splice or a one- or two-line partial: the
# same two shapes the named arm exists to cover. It also keeps the report honest,
# naming PCP_JWT_SECRET rather than the JWT_SECRET tail it matched on.
named='(^|[^A-Za-z0-9_])([A-Za-z0-9_]*_)?(SUPABASE_SECRET_KEY|SUPABASE_PUBLISHABLE_KEY|JWT_SECRET|GITHUB_TOKEN|GOOGLE_CLIENT_SECRET|GOOGLE_CLIENT_ID|TELEGRAM_[A-Z_]*BOT_TOKEN|SB_TEST_PASSWORD|ANTHROPIC_API_KEY|OPENAI_API_KEY|INK_ACCESS_TOKEN|CLAUDE_CODE_MESSAGING_TOKEN|ZSH_EXECUTION_STRING)=["'\'']?[A-Za-z0-9_/+-][^[:space:]]{7,}'

# Vendor token shapes, for secrets not named above.
shapes='(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20}|GOCSPX-[A-Za-z0-9_-]{20}|sb_secret_[A-Za-z0-9_-]{20}|sk-ant-[A-Za-z0-9_-]{20}|[0-9]{8,10}:AA[A-Za-z0-9_-]{33})'

# A scan that did not complete is not a scan that found nothing.
#
# grep exits 0 for a match, 1 for no match, and >=2 for an error — an unreadable
# file, an invalid pattern after an edit, a read fault. Collapsing >=2 into "no
# match" makes the guard fail OPEN exactly when it is malfunctioning, which is
# the worst available direction for a credential check. Each scan therefore
# captures its own status before any pipe (a pipeline reports the LAST command's
# status, so grep's would be discarded by the sed that follows it), and a failed
# scan refuses the commit rather than passing an unchecked message.
scan_failed() {
  echo "" >&2
  echo "Commit blocked: the credential scan did not complete." >&2
  echo "" >&2
  echo "   grep exited $2 while scanning for $1 — that is an error, not a clean" >&2
  echo "   result, so the message has NOT been checked and is refused rather" >&2
  echo "   than assumed safe." >&2
  echo "" >&2
  echo "   Nothing has been committed; your staged changes are untouched." >&2
  echo "   The draft message is at: $msg_file" >&2
  echo "" >&2
  exit 2
}

# Report variable names and line numbers only — never the values, or the hook
# output becomes the next place the secret is written down.
# -o so the report names the variable rather than echoing the prose around it;
# the two sed passes drop the matched value and the leading word boundary.
named_raw=$(grep -inoE "$named" "$msg_file")
rc=$?
[ "$rc" -ge 2 ] && scan_failed "named variables" "$rc"

hits=$(printf '%s' "$named_raw" \
  | sed -E 's/=.*$//' \
  | sed -E 's/^([0-9]+):[^A-Za-z0-9_]*/\1: /')

if [ -z "$hits" ]; then
  shapes_raw=$(grep -inoE "$shapes" "$msg_file")
  rc=$?
  [ "$rc" -ge 2 ] && scan_failed "vendor token shapes" "$rc"

  hits=$(printf '%s' "$shapes_raw" | cut -d: -f1 | sed 's/$/: vendor token pattern/')
fi

# An environment dump is many uppercase assignments at once, even when none is
# individually recognised — this is the arm that catches a secret we never
# thought to name. Threshold picked from real history, not taste: across the
# last 1500 commits on main, 1491 have zero such lines, seven have one, and the
# two that have two are genuine prose about env vars in test setup. Nothing
# legitimate reaches three.
#
# It is deliberately a backstop, not the main guard. The February leaks carried
# only two and four assignment lines, so this arm alone would have missed one of
# them; the named list above is what catches a partial dump.
dump=$(grep -cE '^[A-Z][A-Z0-9_]{3,}=' "$msg_file")
rc=$?
[ "$rc" -ge 2 ] && scan_failed "environment-style assignments" "$rc"

# grep -c prints a count even when it exits 1, but a malformed count would make
# the -ge comparison itself an error, and `[` failing is another silent pass.
case "$dump" in
  '' | *[!0-9]*) scan_failed "environment-style assignments (non-numeric count)" 2 ;;
esac

if [ -n "$hits" ] || [ "$dump" -ge 3 ]; then
  echo ""
  echo "Commit blocked: the message looks like it contains credentials."
  echo ""
  [ -n "$hits" ] && echo "$hits" | sed 's/^/   line /'
  [ "$dump" -ge 3 ] && echo "   $dump environment-style assignments (VAR=value) in the message"
  echo ""
  echo "   If you used -m \"...\", a backtick or \$(...) in the message was executed"
  echo "   by the shell and its output pasted in. Write the message to a file and"
  echo "   commit with -F, which never goes through shell expansion."
  echo ""
  echo "   Nothing has been committed; your staged changes are untouched."
  echo "   The draft message is at: $msg_file"
  echo ""
  exit 1
fi

exit 0
