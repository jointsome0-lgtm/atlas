"""Regression tests for the public Git-layer hygiene checker."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


CHECKER = Path(__file__).with_name("check_public_hygiene.py")
REQUIRED_PATTERNS = {
    "atlas/",
    "data/",
    "state/",
    "intake/",
    "graph/",
    "plans/",
    "runs/",
    "secrets/",
    "*.sqlite*",
    "*.db*",
    "*.jsonl",
    ".env",
    ".env.*",
    "engine.pin",
    "copies-manifest",
    "delivery-registry",
    ".claude/",
    ".codex/",
    ".agents/",
}


class PublicHygieneEndToEndTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary_directory.name)
        (self.root / "scripts").mkdir()
        shutil.copyfile(CHECKER, self.root / "scripts" / CHECKER.name)
        self.git("init", "--quiet")

    def tearDown(self) -> None:
        self._temporary_directory.cleanup()

    def git(self, *args: str) -> None:
        subprocess.run(
            ("git", *args),
            cwd=self.root,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def write_gitignore(self, patterns: set[str]) -> None:
        (self.root / ".gitignore").write_text(
            "\n".join(sorted(patterns)) + "\n", encoding="utf-8"
        )
        self.git("add", ".gitignore")

    def run_checker(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            (sys.executable, "scripts/check_public_hygiene.py"),
            cwd=self.root,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def test_tracked_nested_secrets_path_is_denied(self) -> None:
        self.write_gitignore(REQUIRED_PATTERNS)
        secret = self.root / "nested" / "secrets" / "key.txt"
        secret.parent.mkdir(parents=True)
        secret.write_text("invented test value\n", encoding="utf-8")
        self.git("add", "--force", "nested/secrets/key.txt")

        result = self.run_checker()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "denied path visible to the public Git layer: nested/secrets/key.txt",
            result.stderr,
        )

    def test_missing_secrets_gitignore_pattern_is_reported(self) -> None:
        self.write_gitignore(REQUIRED_PATTERNS - {"secrets/"})

        result = self.run_checker()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            ".gitignore missing required pattern: secrets/", result.stderr
        )

    def test_clean_fixture_passes(self) -> None:
        self.write_gitignore(REQUIRED_PATTERNS)
        (self.root / "README.md").write_text("Clean fixture\n", encoding="utf-8")
        self.git("add", "README.md")

        result = self.run_checker()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("OK: public Git layer", result.stdout)


if __name__ == "__main__":
    unittest.main()
