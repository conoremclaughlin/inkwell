#!/usr/bin/env python3
"""Fail when a tracked file reintroduces the pre-rename "pcp" naming.

Why this exists: 01b9047b renamed ``.pcp`` -> ``.ink`` and ``PCP_`` -> ``INK_``
"across the codebase", and it did not. What it missed did not look like
leftover naming — it looked like working code, and stayed broken for months:

* the dashboard sent ``X-PCP-Workspace-Id``; the server had moved to
  ``x-ink-workspace-id``, so every workspace selection was silently dropped
* ``yarn logs:ink:raw`` / ``logs:ink:errors`` were documented but the scripts
  were still named ``logs:pcp:*``, so the documented commands did not exist
* ``admin.ts`` matched ``backend.includes('pcp')`` when the stored value is
  ``'ink'``, making the ink-runtime transcript branch unreachable
* the REPL command is ``/ink``; the dispatch switch only had ``case 'pcp'``
* ``npx create-pcp`` in the wizard's own help; the package is
  ``@inklabs/create-inkwell``

A half-finished rename is worse than no rename: both spellings look plausible,
so nothing reads as wrong. This guard makes the residue visible.

Two rules keep the exemptions honest, both from Lumen's review of #659:

1. **No whole-file exemptions.** An earlier version skipped entire files, so a
   brand new ``PCP_NEW_THING`` in ``admin.ts`` — a file exempted for its
   cookies — passed. Every exemption now names the literal it permits, and
   every other line in that file is still checked.
2. **Every exemption is boundary-anchored.** Bare literals matched as
   substrings, so ``PCP_PORT_BASE_V2`` inherited ``PCP_PORT_BASE``'s exemption
   anywhere in the tree.

Exemptions exist for names something outside this repo already stores:
database objects, persisted JSON keys, claims inside already-signed tokens,
browser cookies, keys in users' config files, container names, on-disk state
files, and the checkout path. Add one only with a reason.

Run: python3 scripts/check-ink-naming.py
Its own tests: python3 scripts/check-ink-naming.test.py
"""

from __future__ import annotations

import re
import subprocess
import sys

# Paths that are history or vendored, not code we are renaming.
EXCLUDE_PATHS = re.compile(
    r"^\.yarn/|^packages/[^/]+/dist/|^supabase/migrations/|^CHANGELOG\.md$|"
    r"^\.mailmap$|^scripts/check-ink-naming\.py$|^scripts/check-ink-naming\.test\.py$"
)

# Literals permitted anywhere, each with the reason it cannot be renamed.
ALLOWED: list[tuple[str, str]] = [
    (r"pcp_config", "live database table"),
    (r"pcp_admin", "type claim inside already-issued JWTs"),
    (r"pcp_tool", "entry type in the persisted session ledger, replayed"),
    (r"pcp-admin-refresh", "cookie already set in browsers"),
    (r"pcp-admin-token", "cookie already set in browsers"),
    (r"pcp-managed:(?:start|end)", "legacy markers in users' codex config.toml"),
    (r"plugins\.entries\.pcp", "key in users' openclaw.json"),
    (r"supabase_(?:db|kong)_pcp", "local Supabase container names"),
    (r"PCP_PORT_BASE", "legacy env var, still accepted as a fallback"),
    (r"PCP_SERVER_URL", "legacy env var, still accepted as a fallback"),
    (r"PCP_JWT_SECRET", "fixture for the credential guard's prefixed-name case"),
    (r"Personal Context Protocol", "the protocol's own name; Inkwell implements it"),
    (r"(?:metadata|metadataRecord|rawMeta|meta)\.pcp", "persisted inbox metadata key"),
    (r"pcp\.(?:sender|recipient|subject)", "persisted inbox metadata key"),
    (r"pcp(?=:\s*\{)", "persisted inbox metadata key, as an object literal"),
    (r"project:pcp/[a-z-]+", "topic keys on memory rows already written"),
    # The checkout lives at ~/ws/pcp/…; Claude Code and Gemini flatten that
    # path to Users-…-ws-pcp-… for their project directories, so both spellings
    # are filesystem paths rather than product names.
    (r"ws[/-]pcp[/-]", "checkout path"),
    (r"ws/pcp", "checkout path"),
    (r"/pcp/personal-context-protocol", "checkout path"),
    (r"pcp\.dev", "frozen legacy entry in the fixture-domain allowlist"),
    (r"\.pcp", "pre-rename ~/.pcp location, referenced deliberately"),
]

# Literals permitted only in the file that needs them. The rest of that file is
# still checked — that is the whole point of scoping them here.
FILE_ALLOWED: dict[str, list[tuple[str, str]]] = {
    # Every entry names a LITERAL, and quoted forms are preferred because the
    # quote is itself a boundary. A bare `pcp` exemption used to sit here and
    # it covered any new hyphenated name in the same file — `pcp-new-tool`
    # passed in chat.ts (Lumen, #659 r2). Files whose only pre-rename text is
    # already in ALLOWED carry no entry at all.
    "packages/api/src/services/thread-key/parser.test.ts": [
        (r"'pcp'", "pins the pcp->inkwell project alias"),
        (r"pcp:[A-Za-z0-9:_-]*", "alias-prefixed thread keys under test"),
    ],
    "packages/api/src/services/thread-key/unregistered-prefix.test.ts": [
        (r"'pcp'", "pins the project alias"),
        (r"`pcp`", "pins the project alias"),
        (r"pcp:[A-Za-z0-9:_-]*", "alias-prefixed thread keys under test"),
    ],
    "packages/api/src/services/thread-key/thread-key.service.ts": [
        (r"'pcp'", "documents the alias parse bug"),
        (r"pcp:issue:x", "the key from that bug report"),
    ],
    "packages/web/src/lib/workspace-selection.ts": [
        (r"pcp:selectedWorkspaceId", "legacy localStorage key, read once"),
    ],
    "packages/web/src/lib/api/client.test.ts": [
        (r"X-PCP-Workspace-Id", "names the dead header the bug sent"),
    ],
    "packages/cli/src/commands/claude.ts": [
        (r"__pcp__", "legacy session-picker prefix, still stripped"),
        (r"pcp:", "legacy pcp:<id> session choice, still accepted"),
    ],
    "packages/cli/src/cli.test.ts": [
        (r"pcp:[0-9a-f]+", "covers the legacy pcp:<id> session choice"),
    ],
    "packages/cli/src/commands/chat.ts": [
        (r"case 'pcp'", "keeps /pcp as a silent alias for /ink"),
        (r"'pcp' kept as a silent alias", "the comment explaining that alias"),
        (r"'pcp-activity'", "persisted ledger source, replayed"),
        (r"'pcp-activity-history'", "persisted ledger source, replayed"),
    ],
    "packages/cli/src/commands/chat-hydration.test.ts": [
        (r"'pcp-activity'", "covers the persisted ledger sources"),
        (r"'pcp-activity-history'", "covers the persisted ledger sources"),
    ],
    "packages/cli/src/commands/session.ts": [
        (r"includes\('pcp'\)", "legacy backend value on pre-rename rows"),
        (r"'pcp'", "names that value in the comment above it"),
    ],
    "packages/cli/src/commands/session.test.ts": [
        (r"'pcp'", "covers the legacy backend value"),
    ],
    "packages/api/src/routes/admin.ts": [
        (r"includes\('pcp'\)", "legacy backend value on pre-rename rows"),
        (r"'pcp'", "names that value in the comment above it"),
        (r"pcp-pair-", "legacy pairing token prefix already in the database"),
    ],
    "packages/api/src/routes/admin-mobile-auth.test.ts": [
        (r"pcp-pair-", "covers the legacy pairing token prefix"),
    ],
    "packages/api/src/mcp/tools/inbox-handlers.test.ts": [
        (r"pcp(?= metadata)", "prose about the persisted inbox metadata key"),
    ],
    "packages/cli/src/backends/gemini.ts": [
        (r"'pcp'", "comment pinning the retired MCP server name"),
    ],
    "packages/shared/src/runner/mcp-config.ts": [
        (r"'pcp'", "comment pinning the retired MCP server name"),
    ],
    "packages/openclaw-plugin/openclaw.plugin.json": [
        (r'"pcp"', "plugin id users already have in openclaw.json"),
    ],
    "packages/spec/protocol-v0.1.md": [
        (r'"pcp"', "MCP server entry in a pre-rename config example"),
    ],
    "packages/shared/src/runner/runtime-hints.ts": [
        (r"pcpSessionId", "migrates and mirrors the legacy key in sessions.json"),
    ],
    "packages/cli/src/session/runtime.ts": [
        (r"pcpSessionId", "migrates and mirrors the legacy key in sessions.json"),
    ],
    "packages/cli/src/session/legacy-runtime-compat.test.ts": [
        (r"pcpSessionId", "fixture must stay in the pre-rename spelling"),
    ],
    "packages/shared/src/security/delegation-token.ts": [
        (r"PCP-DELEGATION", "accepts the pre-rename signed typ"),
    ],
    "packages/cli/src/repl/delegation-token.test.ts": [
        (r"PCP-DELEGATION", "mints a pre-rename token by hand"),
    ],
    "packages/create-inkwell/src/progress.ts": [
        (r"\.create-pcp-progress\.json", "reads the legacy resume file"),
    ],
    "packages/create-inkwell/src/index.test.ts": [
        (r"\.create-pcp-progress\.json", "covers the legacy resume file"),
    ],
    ".gitignore": [
        (r"\.create-pcp-progress\.json", "still ignores the legacy resume file"),
    ],
    "scripts/lib/integration-stack.py": [
        (r"pcp-integration(?:-[A-Za-z0-9_]+)?", "legacy stack name, supported for --stop"),
        (r"\(\?:ink\|pcp\)-integration", "the validator pattern that accepts both"),
        (r'"pcp-"', "the prefix test that makes legacy stop-only"),
        (r"_pcp_it", "names the legacy bookkeeping schema in a comment"),
    ],
    "scripts/test-integration-stack.py": [
        (r"pcp-integration(?:-[A-Za-z0-9_]+)?", "covers the legacy stack name"),
        (r"supabase_db_pcp-integration", "the legacy stack's container name"),
    ],
    "packages/api/src/config/env.ts": [
        (r"PCP_", "documents the INK_/PCP_ fallback"),
    ],
    "packages/shared/src/studio/mcp-config-sync.ts": [
        (r"pcp-managed", "legacy codex markers on users' disks"),
    ],
}


def anchor(pattern: str) -> str:
    """Wrap a pattern so it cannot match inside a longer identifier.

    Without this, `PCP_PORT_BASE` exempts `PCP_PORT_BASE_V2`, and any exemption
    becomes a prefix others can hide behind (Lumen, #659 review).

    The boundary excludes a hyphen as well as word characters, and that is not
    cosmetic: `supabase_db_pcp` masked `supabase_db_pcp-integration`, so the
    integration fixtures kept a container name that no longer matched their
    own project and every identity check refused. CI caught it; I had run the
    sibling suite locally and not that one.

    The boundary is added only on an end that actually finishes with a word
    character. `ws[/-]pcp[/-]` deliberately ends on a separator and is followed
    by more path — demanding a non-word character after it would stop it
    matching `…-ws-pcp-personal-context-protocol`, which is the checkout path
    it exists to allow.
    """
    lead = r"(?<![A-Za-z0-9_])" if re.match(r"[A-Za-z0-9_]", pattern) else ""
    trail = r"(?![A-Za-z0-9_-])" if re.search(r"[A-Za-z0-9_]$", pattern) else ""
    return rf"{lead}(?:{pattern}){trail}"


def build(patterns: list[tuple[str, str]]) -> "re.Pattern[str] | None":
    if not patterns:
        return None
    # Case-sensitive on purpose: with IGNORECASE the `\.pcp` entry matched the
    # `.PCP` in `process.env.PCP_NEW_THING` and let a new legacy-spelled env
    # var through. Each entry is written in the case it really has.
    return re.compile("|".join(anchor(p) for p, _ in patterns))


GLOBAL_RE = build(ALLOWED)
FILE_RE = {path: build(rules) for path, rules in FILE_ALLOWED.items()}
PCP_RE = re.compile("pcp", re.IGNORECASE)


def tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files"], capture_output=True, text=True, check=True
    ).stdout.splitlines()
    return [f for f in out if f and not EXCLUDE_PATHS.search(f)]


def violations_in(path: str, lines: list[str]) -> list[tuple[int, str]]:
    scoped = FILE_RE.get(path)
    found = []
    for number, line in enumerate(lines, 1):
        if not PCP_RE.search(line):
            continue
        stripped = GLOBAL_RE.sub("", line) if GLOBAL_RE else line
        if scoped:
            stripped = scoped.sub("", stripped)
        if PCP_RE.search(stripped):
            found.append((number, line.rstrip()))
    return found


def main() -> int:
    files = tracked_files()
    if not files:
        print("check-ink-naming: no files to scan", file=sys.stderr)
        return 1

    offenders: list[tuple[str, int, str]] = []
    for path in files:
        try:
            with open(path, encoding="utf-8") as handle:
                lines = handle.readlines()
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        for number, line in violations_in(path, lines):
            offenders.append((path, number, line))

    if not offenders:
        print(f"check-ink-naming: clean ({len(files)} files scanned)")
        return 0

    current = None
    for path, number, line in offenders:
        if path != current:
            print(path)
            current = path
        print(f"  {number}: {line.strip()[:120]}")

    print(
        "\n"
        f'Found pre-rename "pcp" naming in {len({o[0] for o in offenders})} file(s).\n'
        "\n"
        "Use Ink/Inkwell instead: INK_* for environment variables, x-ink-* for\n"
        'headers, ink*/Ink* for identifiers, "Inkwell" in prose. "Personal Context\n'
        'Protocol" is still correct when naming the protocol itself (packages/spec)\n'
        "rather than the implementation.\n"
        "\n"
        "If the name has to keep its old spelling because something outside this repo\n"
        "already stores it — a database object, a persisted JSON key, a claim in an\n"
        "issued token, a browser cookie, a key in a user's config — add the literal to\n"
        "ALLOWED (anywhere) or FILE_ALLOWED (that file only) in\n"
        "scripts/check-ink-naming.py, with the reason. Do not exempt a whole file.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
