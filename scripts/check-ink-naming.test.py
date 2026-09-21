#!/usr/bin/env python3
"""Tests for the ink-naming guard.

The guard is only worth having if it fails on the shapes that actually got
through last time, so the cases below are those shapes, not invented ones.

It has already passed for the wrong reason twice:

* the first version was shell, and `s/ws/pcp//g` broke sed's substitute
  delimiter on every line — it stripped nothing, matched nothing, exited 0
* the second compiled its allowlist with IGNORECASE, so the `\\.pcp` entry
  matched the `.PCP` in `process.env.PCP_NEW_THING` and a brand new
  legacy-spelled env var passed

Both are pinned below. So are the two weaknesses Lumen found in review: a
whole-file exemption hiding a new name in an exempted file, and an unanchored
literal exempting every longer name that starts with it.

Run: python3 scripts/check-ink-naming.test.py
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("guard", ROOT / "scripts" / "check-ink-naming.py")
assert spec and spec.loader
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def flags(path: str, line: str) -> bool:
    """Would the guard flag this line, in this file?"""
    return bool(guard.violations_in(path, [line]))


# A file with no scoped exemptions at all.
PLAIN = "packages/cli/src/repl/slash.ts"
# A file that IS exempted, for one specific literal.
EXEMPTED = "packages/api/src/routes/admin.ts"


class CatchesRealResidue(unittest.TestCase):
    def test_new_env_var(self):
        # The IGNORECASE bug: `\.pcp` matched the `.PCP` here and stripped it.
        self.assertTrue(flags(PLAIN, "const u = process.env.PCP_NEW_THING;"))

    def test_identifier(self):
        self.assertTrue(flags(PLAIN, "const pcpSessionId = 1;"))

    def test_header_shape_that_broke_workspace_selection(self):
        self.assertTrue(flags(PLAIN, "config.headers['X-PCP-Workspace-Id'] = id;"))

    def test_stale_prose(self):
        self.assertTrue(flags(PLAIN, "// talks to the PCP server"))

    def test_stale_yarn_script(self):
        self.assertTrue(flags(PLAIN, "// run yarn logs:pcp:raw"))

    def test_stale_npx_invocation(self):
        self.assertTrue(flags(PLAIN, "// npx create-pcp my-project"))

    def test_repl_command(self):
        self.assertTrue(flags(PLAIN, "showInPanel(['Usage: /pcp <tool>']);"))


class ExemptionsAreNarrow(unittest.TestCase):
    """Lumen's review of #659: both of these passed before."""

    def test_exempted_file_does_not_get_a_free_pass(self):
        # admin.ts is exempted for its cookies and the legacy backend value.
        # That must not cover a brand new name in the same file.
        self.assertTrue(flags(EXEMPTED, "const u = process.env.PCP_NEW_THING;"))
        self.assertTrue(flags(EXEMPTED, "const pcpWidgetId = 1;"))

    def test_exempted_literal_does_not_cover_longer_names(self):
        # PCP_PORT_BASE is allowed everywhere; PCP_PORT_BASE_V2 is not.
        self.assertFalse(flags(PLAIN, "process.env.PCP_PORT_BASE"))
        self.assertTrue(flags(PLAIN, "process.env.PCP_PORT_BASE_V2"))

    def test_exemption_is_anchored_on_the_leading_side_too(self):
        # A suffix match is the same hole as a prefix match: without the
        # leading boundary, anything ending in an exempted literal inherits
        # its exemption.
        self.assertTrue(flags(PLAIN, "process.env.LEGACYPCP_PORT_BASE"))
        self.assertTrue(flags(PLAIN, "const x = mypcp_admin;"))

    def test_every_exempted_file_still_rejects_a_brand_new_name(self):
        """No exempted file may hide a new pre-rename name.

        The earlier version listed a bare `pcp` per file, which covered any
        new hyphenated literal in it — `pcp-new-tool` passed in chat.ts. Each
        exemption is a specific literal now, and this walks every exempted
        file to prove none of them grants a general pass.
        """
        probes = [
            "const x = 'pcp-new-tool';",
            "const u = process.env.PCP_NEW_THING;",
            "const pcpWidgetId = 1;",
            "// talks to the PCP server",
        ]
        for path in sorted(guard.FILE_ALLOWED):
            for probe in probes:
                with self.subTest(path=path, probe=probe):
                    self.assertTrue(
                        flags(path, probe),
                        f"{path} let through: {probe}",
                    )

    def test_exemptions_are_still_honoured_in_their_own_file(self):
        # Control for the test above: if the exemptions had simply stopped
        # working, the sweep above would pass for the wrong reason.
        self.assertFalse(
            flags("packages/cli/src/commands/chat.ts", "case 'pcp': {")
        )
        self.assertFalse(
            flags("packages/cli/src/session/runtime.ts", "['pcpSessionId', 'inkSessionId'],")
        )
        self.assertFalse(
            flags("scripts/lib/integration-stack.py", 'if project.startswith("pcp-"):')
        )

    def test_scoped_exemption_does_not_leak_to_other_files(self):
        legacy = "const header = { typ: 'PCP-DELEGATION' };"
        self.assertFalse(flags("packages/shared/src/security/delegation-token.ts", legacy))
        self.assertTrue(flags(PLAIN, legacy))


class LeavesLoadBearingNamesAlone(unittest.TestCase):
    """Names something outside this repo already stores."""

    def test_database_and_token_and_ledger_values(self):
        self.assertFalse(flags(PLAIN, "const t = 'pcp_admin';"))
        self.assertFalse(flags(PLAIN, "from('pcp_config')"))
        self.assertFalse(flags(PLAIN, "case 'pcp_tool':"))

    def test_persisted_metadata_key(self):
        self.assertFalse(flags(PLAIN, "const x = meta.pcp;"))
        self.assertFalse(flags(PLAIN, "const y = rawMeta.pcp.sender;"))

    def test_cookies_and_config_keys(self):
        self.assertFalse(flags(PLAIN, "req.cookies?.['pcp-admin-refresh']"))
        self.assertFalse(flags(PLAIN, "'Set plugins.entries.pcp.config.sbSlug'"))

    def test_checkout_path(self):
        self.assertFalse(flags(PLAIN, "'/Users/you/ws/pcp/personal-context-protocol'"))
        self.assertFalse(
            flags(PLAIN, "'Users-conormclaughlin-ws-pcp-personal-context-protocol'")
        )

    def test_the_protocol_keeps_its_name(self):
        self.assertFalse(flags(PLAIN, "// the Personal Context Protocol spec"))


class GuardActuallyReadsTheTree(unittest.TestCase):
    def test_scan_covers_a_real_population(self):
        # The shell version exited 0 having matched nothing. A guard that
        # scans an empty set is indistinguishable from a clean tree, so assert
        # the population is real and includes files it is supposed to check.
        files = guard.tracked_files()
        self.assertGreater(len(files), 500)
        self.assertIn("packages/api/src/routes/admin.ts", files)
        self.assertNotIn("CHANGELOG.md", files)


if __name__ == "__main__":
    unittest.main(verbosity=2)
