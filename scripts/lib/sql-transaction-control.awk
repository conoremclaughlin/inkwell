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
# A dollar quote needs a token boundary before it: PostgreSQL lexes foo$tag$
# as one identifier (identifiers may contain $ after their first character),
# so a $ that follows an identifier character never opens a quote here.
# PostgreSQL's identifier characters are ASCII letters, digits, _ and $,
# plus every byte above 0x7F (it does not interpret non-ASCII further), so
# this scanner works on bytes and must run under LC_ALL=C, which the wrapper
# sets: the same file then lexes the same way on every machine, and awk
# never fails on multibyte input.
#
# A line comment ends at LF or CR, as in PostgreSQL's scanner, and a file
# that ends inside a line comment, or without a final semicolon or newline,
# still has its last statement judged.
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

# PostgreSQL's identifier characters, byte-wise: ASCII letter/digit/_/$, or
# any byte >= 0x80. Under LC_ALL=C string comparison is byte comparison.
function ident_char(ch) {
  return ch != "" && (ch ~ /[A-Za-z0-9_$]/ || ch >= "\200")
}
function ident_start(ch) {
  return ch != "" && (ch ~ /[A-Za-z_]/ || ch >= "\200")
}

# The dollar tag that starts at position p, or "" if none: $$, or $ then an
# identifier-start, identifier characters (no $), then $.
function dollar_tag(p,    q, ch) {
  if (substr(src, p + 1, 1) == "$") return "$$"
  q = p + 1
  ch = substr(src, q, 1)
  if (!ident_start(ch)) return ""
  while (q <= n) {
    ch = substr(src, q, 1)
    if (ch == "$") return substr(src, p, q - p + 1)
    if (!ident_char(ch)) return ""
    q++
  }
  return ""
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
      if (c == "$" && (i == 1 || !ident_char(substr(src, i - 1, 1)))) {
        tag = dollar_tag(i)
        if (tag != "") {
          mode = "dollar"; i += length(tag) - 1; stmt = stmt " "; continue
        }
      }
      if (c == "\\") {
        rest = substr(src, i)
        sub(/[\n\r].*/, "", rest)
        report("psql meta-command", rest)
        i += length(rest) - 1
        continue
      }
      if (c == ";") { judge(stmt); stmt = ""; continue }
      stmt = stmt c
      continue
    }
    if (mode == "lc") { if (c == "\n" || c == "\r") mode = "sql"; continue }
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
  # End of input inside a line comment is the end of that comment; the
  # statement before it is still a statement.
  if (mode == "sql" || mode == "lc") judge(stmt)
  else report("unterminated " (mode == "bc" ? "block comment" : mode == "sq" ? "string" : mode == "dq" ? "quoted identifier" : "dollar-quoted body " tag), "")
  exit found ? 1 : 0
}
