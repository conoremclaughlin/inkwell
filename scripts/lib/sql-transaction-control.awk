# Report top-level transaction control and psql meta-commands in a SQL file.
#
# The wrapper (scripts/db-migrate.sh) runs a migration inside one psql
# transaction together with its ledger row. psql's single-transaction mode
# does not cover transaction-control statements, so a file that carries its
# own COMMIT would commit the row and a partial file. A line regex cannot
# judge this: COMMIT has several spellings, two statements can share a line,
# and END ends both a transaction and every plpgsql block. So this is a small
# tokenizer. It removes what is not SQL at the top level (line comments,
# block comments, single- and double-quoted text, dollar-quoted bodies with
# any tag), splits what remains on semicolons, and judges the first keyword
# of each statement. Anything inside a function body is invisible to it,
# which is the point: the body's BEGIN and END are not ours.
#
# Refused at the top level: BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK,
# ABORT, SAVEPOINT, RELEASE, PREPARE TRANSACTION, any spelling (COMMIT WORK,
# ROLLBACK TO SAVEPOINT x, COMMIT AND CHAIN, ...); any psql meta-command
# (an unquoted backslash starts one wherever it appears); and BEGIN ATOMIC
# bodies, whose inner semicolons this scanner does not understand.
#
# Usage:   awk -f scripts/lib/sql-transaction-control.awk FILE
# Prints one line per finding. Exit 1 if anything was found, 0 if clean.

BEGIN { RS = "\001" }
{ src = src $0 }

function judge(s,    t, u) {
  t = s
  gsub(/[[:space:]]+/, " ", t)
  sub(/^ /, "", t)
  sub(/ $/, "", t)
  if (t == "") return
  u = toupper(t)
  if (u ~ /(^| )BEGIN ATOMIC( |$)/) {
    report("a BEGIN ATOMIC body (not supported here; use a dollar-quoted body)", t)
    return
  }
  if (u ~ /^(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE TRANSACTION)( |$)/) {
    report("transaction control", t)
  }
}

function report(kind, text) {
  found = 1
  if (length(text) > 60) text = substr(text, 1, 57) "..."
  printf "%s: %s\n", kind, text
}

END {
  n = length(src)
  mode = "sql"
  stmt = ""
  depth = 0
  tag = ""
  estr = 0
  for (i = 1; i <= n; i++) {
    c = substr(src, i, 1)
    nxt = substr(src, i + 1, 1)
    if (mode == "sql") {
      if (c == "-" && nxt == "-") { mode = "lc"; i++; stmt = stmt " "; continue }
      if (c == "/" && nxt == "*") { mode = "bc"; depth = 1; i++; stmt = stmt " "; continue }
      if (c == "'") {
        prev = (i > 1) ? substr(src, i - 1, 1) : ""
        prev2 = (i > 2) ? substr(src, i - 2, 1) : ""
        estr = ((prev == "E" || prev == "e") && prev2 !~ /[A-Za-z0-9_]/) ? 1 : 0
        mode = "sq"; stmt = stmt " "; continue
      }
      if (c == "\"") { mode = "dq"; stmt = stmt " "; continue }
      if (c == "$") {
        if (match(substr(src, i), /^\$[A-Za-z_][A-Za-z0-9_]*\$/) || match(substr(src, i), /^\$\$/)) {
          tag = substr(src, i, RLENGTH)
          mode = "dollar"; i += RLENGTH - 1; stmt = stmt " "; continue
        }
      }
      if (c == "\\") {
        rest = substr(src, i)
        sub(/\n.*/, "", rest)
        report("psql meta-command", rest)
        i += length(rest) - 1
        continue
      }
      if (c == ";") { judge(stmt); stmt = ""; continue }
      stmt = stmt c
      continue
    }
    if (mode == "lc") { if (c == "\n") mode = "sql"; continue }
    if (mode == "bc") {
      if (c == "/" && nxt == "*") { depth++; i++; continue }
      if (c == "*" && nxt == "/") { depth--; i++; if (depth == 0) mode = "sql"; continue }
      continue
    }
    if (mode == "sq") {
      if (estr && c == "\\") { i++; continue }
      if (c == "'" && nxt == "'") { i++; continue }
      if (c == "'") mode = "sql"
      continue
    }
    if (mode == "dq") {
      if (c == "\"" && nxt == "\"") { i++; continue }
      if (c == "\"") mode = "sql"
      continue
    }
    if (mode == "dollar") {
      if (substr(src, i, length(tag)) == tag) { mode = "sql"; i += length(tag) - 1 }
      continue
    }
  }
  if (mode == "sql") judge(stmt)
  else if (mode != "lc") report("unterminated " (mode == "bc" ? "block comment" : mode == "sq" ? "string" : mode == "dq" ? "quoted identifier" : "dollar-quoted body " tag), "")
  exit found ? 1 : 0
}
