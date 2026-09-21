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
* the REPL command is ``/ink``; the CLI README documented ``/pcp``
* ``npx create-pcp`` in the wizard's own help; the package is
  ``@inklabs/create-inkwell``

A half-finished rename is worse than no rename: both spellings look plausible,
so nothing reads as wrong. This guard makes the residue visible.

ALLOWED below are names that must keep the old spelling because something
outside this repo already stores them — database objects, persisted JSON keys,
claims in tokens already issued, browser cookies, keys in users' config files,
container names, and the checkout path itself. Add to it only with a reason.

Run: python3 scripts/check-ink-naming.py
"""

from __future__ import annotations

import re
import subprocess
import sys

# Paths that are history or vendored, not code we are renaming.
EXCLUDE_PATHS = re.compile(
    r"^\.yarn/|^packages/[^/]+/dist/|^supabase/migrations/|^CHANGELOG\.md$|"
    r"^\.mailmap$|^scripts/check-ink-naming\.py$"
)

# Literals removed from a line before it is judged. Each entry is (pattern, why).
ALLOWED = [
    (r"pcp-admin-refresh", "cookie already set in browsers"),
    (r"pcp-admin-token", "cookie already set in browsers"),
    (r"pcp-managed:(start|end)", "legacy markers in users' codex config.toml"),
    (r"plugins\.entries\.pcp", "key in users' openclaw.json"),
    (r"supabase_(db|kong)_pcp", "local Supabase container names"),
    (r"PCP_PORT_BASE", "legacy env var, still accepted as a fallback"),
    (r"PCP_SERVER_URL", "legacy env var, still accepted as a fallback"),
    (r"PCP_JWT_SECRET", "fixture for the credential guard's prefixed-name case"),
    (r"Personal Context Protocol", "the protocol's own name; Inkwell implements it"),
    (r"pcp_config", "live database table"),
    (r"pcp_admin", "type claim in already-issued JWTs"),
    (r"pcp_tool", "entry type in the persisted session ledger, replayed"),
    (r"(metadata|metadataRecord|rawMeta|meta)\.pcp", "persisted inbox metadata key"),
    (r"pcp\.(sender|recipient|subject)", "persisted inbox metadata key"),
    (r"pcp:\s*\{", "persisted inbox metadata key, as an object literal"),
    (r"pcp\b(?=\s*metadata)", "prose about the persisted inbox metadata key"),
    (r'"id":\s*"pcp"', "plugin id users already have in openclaw.json"),
    (r"pcp\.dev", "frozen legacy entry in the fixture-domain allowlist"),
    (r"project:pcp/[a-z-]+", "topic keys on memory rows already written"),
    (r"legacy 'pcp' server name", "comment pinning the retired MCP server name"),
    (r"/pcp/personal-context-protocol", "checkout path"),
    (r'"pcp":\s*\{', "MCP server entry in a pre-rename config example"),
    # The checkout lives at ~/ws/pcp/…; Claude Code and Gemini flatten that path
    # to Users-…-ws-pcp-… for their project directories, so both spellings are
    # filesystem paths rather than product names.
    (r"ws[/-]pcp[/-]", "checkout path"),
    (r"ws/pcp", "checkout path"),
    (r"\.pcp(?![\w-])", "pre-rename ~/.pcp location, referenced deliberately"),
]

# Files that pin a legacy spelling in full, with the reason.
PINNED = {
    "packages/api/src/services/thread-key/parser.test.ts": "pins the pcp->inkwell project alias",
    "packages/api/src/services/thread-key/unregistered-prefix.test.ts": "pins the project alias",
    "packages/api/src/services/thread-key/thread-key.service.ts": "documents the alias parse bug",
    "packages/shared/src/studio/mcp-config-sync.ts": "legacy codex markers on users' disks",
    "packages/openclaw-plugin/config-compat.test.ts": "legacy openclaw.json keys",
    "packages/web/src/lib/workspace-selection.ts": "reads the legacy localStorage key once",
    "packages/web/src/lib/api/client.test.ts": "names the dead header the bug sent",
    "packages/cli/src/commands/claude.ts": "still accepts the legacy pcp:<id> session choice",
    "packages/cli/src/cli.test.ts": "covers the legacy pcp:<id> session choice",
    "packages/cli/src/commands/chat.ts": "keeps /pcp as a silent alias for /ink",
    "packages/cli/src/commands/session.ts": "legacy backend value on pre-rename rows",
    "packages/cli/src/commands/session.test.ts": "covers the legacy backend value",
    "packages/api/src/routes/admin.ts": "legacy cookies and legacy backend value",
    "packages/api/src/config/env.ts": "documents the INK_/PCP_ fallback",
    "packages/mobile/app.config.js": "documents the INK_/PCP_ fallback",
    "packages/mobile/src/lib/appConfig.test.ts": "covers the INK_/PCP_ fallback",
    "packages/api/src/services/sessions/antigravity-runner.ts": "INK_/PCP_ fallback",
    "packages/api/src/services/sessions/antigravity-runner.test.ts": "covers that fallback",
    "scripts/dev-concurrently.mjs": "INK_/PCP_ fallback",
    "scripts/check-commit-msg.sh": "credential-guard fixture",
    "scripts/check-commit-msg.test.sh": "credential-guard fixture",
    "packages/api/src/skills/service.ts": "explains why ~/.pcp is never read",
    "packages/api/src/skills/service.test.ts": "asserts ~/.pcp is never read",
}

# Case-sensitive on purpose: with IGNORECASE, the `\.pcp` entry matched the
# `.PCP` in `process.env.PCP_NEW_THING` and let a brand new legacy-spelled
# env var through. Each entry below is written in the case it really has.
ALLOWED_RE = re.compile("|".join(f"(?:{p})" for p, _ in ALLOWED))
PCP_RE = re.compile("pcp", re.IGNORECASE)


def tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files"], capture_output=True, text=True, check=True
    ).stdout.splitlines()
    return [f for f in out if f and not EXCLUDE_PATHS.search(f)]


def main() -> int:
    files = tracked_files()
    if not files:
        print("check-ink-naming: no files to scan", file=sys.stderr)
        return 1

    violations: list[tuple[str, int, str]] = []
    for path in files:
        if path in PINNED:
            continue
        try:
            with open(path, encoding="utf-8") as handle:
                lines = handle.readlines()
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        for number, line in enumerate(lines, 1):
            if not PCP_RE.search(line):
                continue
            if PCP_RE.search(ALLOWED_RE.sub("", line)):
                violations.append((path, number, line.rstrip()))

    if not violations:
        print(f"check-ink-naming: clean ({len(files)} files scanned)")
        return 0

    current = None
    for path, number, line in violations:
        if path != current:
            print(path)
            current = path
        print(f"  {number}: {line.strip()[:120]}")

    print(
        "\n"
        f"Found pre-rename \"pcp\" naming in {len({v[0] for v in violations})} file(s).\n"
        "\n"
        "Use Ink/Inkwell instead: INK_* for environment variables, x-ink-* for\n"
        "headers, ink*/Ink* for identifiers, \"Inkwell\" in prose. \"Personal Context\n"
        "Protocol\" is still correct when naming the protocol itself (packages/spec)\n"
        "rather than the implementation.\n"
        "\n"
        "If the name has to keep its old spelling because something outside this repo\n"
        "already stores it — a database object, a persisted JSON key, a claim in an\n"
        "issued token, a browser cookie, a key in a user's config — add it to ALLOWED\n"
        "or PINNED in scripts/check-ink-naming.py with the reason.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
