import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("docs-context.py")
OWNERS = (
    "# Former owner: @former\n"
    "* @zed-user @org/sdk-team @current-owner\n"
    "packages/@path-user/** @path-owner @zed-user # Former: @comment-owner\n"
)


class DocsContextTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.git("init", "--quiet")
        (self.root / ".github").mkdir()
        (self.root / "bin").mkdir()
        gh = self.root / "bin/gh"
        gh.write_text(
            "#!/usr/bin/env python3\nimport os, pathlib, sys\n"
            "assert sys.argv[1:] == ['api', 'repos/photon-hq/fixture/releases/tags/' + os.environ['RELEASE_TAG']]\n"
            "print(pathlib.Path(os.environ['RELEASE_FIXTURE']).read_text())\n"
        )
        gh.chmod(0o755)

    def git(self, *args, data=None):
        return subprocess.check_output(
            ["git", *args], cwd=self.root, text=True, input=data
        ).strip()

    def tag(self, name, text, owners=OWNERS):
        (self.root / "README.md").write_text(text)
        (self.root / ".github/CODEOWNERS").write_text(owners)
        self.git("add", "README.md", ".github/CODEOWNERS")
        self.git("update-ref", f"refs/tags/{name}", self.git("write-tree"))

    def context(self, tag, previous="", **release_fields):
        release = {
            "tag_name": tag, "prerelease": False, "draft": False,
            "body": "Release notes\nwith two lines", **release_fields,
        }
        fixture = self.root / "release.json"
        fixture.write_text(json.dumps(release))
        output = self.root / "github-output"
        output.unlink(missing_ok=True)
        result = subprocess.run(
            [sys.executable, str(SCRIPT)], cwd=self.root, capture_output=True, text=True,
            env={**os.environ, "RELEASE_TAG": tag, "PREVIOUS_TAG": previous,
                 "RELEASE_NOTES": "", "RELEASE_FIXTURE": str(fixture),
                 "GITHUB_REPOSITORY": "photon-hq/fixture", "GITHUB_OUTPUT": str(output),
                 "PATH": f"{self.root / 'bin'}{os.pathsep}{os.environ['PATH']}"},
        )
        values = {}
        if output.exists():
            lines = iter(output.read_text().splitlines())
            for line in lines:
                key, delimiter = line.split("<<", 1)
                value = []
                for part in lines:
                    if part == delimiter:
                        break
                    value.append(part)
                values[key] = "\n".join(value)
        return result, values

    def test_external_stable_release_uses_numeric_baseline_and_active_owners(self):
        self.tag("v2.10.0", "Numeric baseline\n")
        self.tag("v2.9.0", "Older numeric version created later\n")
        self.tag("spectrum-ts-staging-2.11.0-staging.42.1", "Staging\n")
        self.tag("v2.11.0-rc.1", "Prerelease\n")
        self.tag("v2.11.0", "Released\n")
        self.tag("v3.0.0", "Future release\n", "* @wrong-working-tree-owner\n")
        result, context = self.context("v2.11.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(context["version"], "2.11.0")
        self.assertEqual(context["release-tag"], "v2.11.0")
        self.assertEqual(context["release-notes"], "Release notes\nwith two lines")
        self.assertIn("-Numeric baseline", context["changes-diff"])
        self.assertIn("+Released", context["changes-diff"])
        self.assertNotIn("-Staging", context["changes-diff"])
        self.assertNotIn("-Older numeric", context["changes-diff"])
        self.assertEqual(context["reviewers"], "current-owner,org/sdk-team,path-owner,zed-user")

    def test_first_release_uses_the_empty_tree(self):
        self.tag("spectrum-ts-staging-1.0.0-staging.42.1", "Staging\n")
        self.tag("v1.0.0", "First release\n")
        result, context = self.context("v1.0.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("new file mode 100644", context["changes-diff"])
        self.assertIn("+First release", context["changes-diff"])

    def test_explicit_promotion_baseline_is_preserved(self):
        self.tag("v1.0.0", "Promoted baseline\n")
        self.tag("v1.1.0", "Another stable release\n")
        self.tag("v1.2.0", "Released\n")
        result, context = self.context("v1.2.0", "v1.0.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("-Promoted baseline", context["changes-diff"])

    def test_rejects_drafts_prereleases_and_mismatched_release_metadata(self):
        self.tag("v1.0.0", "First release\n")
        for fields in ({"draft": True}, {"prerelease": True}, {"tag_name": "v1.1.0"}):
            with self.subTest(fields=fields):
                result, context = self.context("v1.0.0", **fields)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(context, {})

    def test_rejects_nonstable_tags_and_invalid_baselines(self):
        self.tag("v1.0.0", "First release\n")
        for tag, previous in (("v1.0.0-rc.1", ""), ("v1.0.0", "v1.0.0"), ("v1.0.0", "v0.9.0-rc.1")):
            with self.subTest(tag=tag, previous=previous):
                result, context = self.context(tag, previous)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(context, {})

    def test_caps_the_diff_from_a_temporary_file(self):
        self.tag("v1.0.0", "Baseline\n")
        self.tag("v1.1.0", "x" * 120_000 + "\n")
        result, context = self.context("v1.1.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        truncated = "\n\n... [diff truncated at 100000 characters]"
        self.assertTrue(context["changes-diff"].endswith(truncated))
        self.assertEqual(len(context["changes-diff"]), 100_000 + len(truncated))


if __name__ == "__main__":
    unittest.main()
