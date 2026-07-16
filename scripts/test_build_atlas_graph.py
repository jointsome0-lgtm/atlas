import contextlib
import io
import json
import tempfile
import unittest
from datetime import datetime as RealDateTime
from pathlib import Path
from unittest import mock

import build_atlas_graph
from frontmatter import parse_frontmatter


ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "fixtures" / "demo-instance"


class FixedDateTime:
    @classmethod
    def now(cls, tz=None):
        return RealDateTime(2026, 7, 16, 12, 0, 0, tzinfo=tz)


class BuilderIntegrationTests(unittest.TestCase):
    def test_builder_uses_shared_parser(self):
        self.assertIs(parse_frontmatter, build_atlas_graph.parse_frontmatter)

    def test_graph_envelope_is_first_and_build_is_deterministic(self):
        with mock.patch.object(build_atlas_graph, "datetime", FixedDateTime):
            first, first_errors, first_warnings = build_atlas_graph.build(DEMO)
            second, second_errors, second_warnings = build_atlas_graph.build(DEMO)
        self.assertEqual([], first_errors)
        self.assertEqual([], second_errors)
        self.assertEqual(first_warnings, second_warnings)
        self.assertEqual(first, second)
        self.assertEqual(["format", "version"], list(first)[:2])
        self.assertEqual("atlas-graph", first["format"])
        self.assertEqual(1, first["version"])

    def test_main_writes_envelope(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "atlas-graph.json"
            stdout = io.StringIO()
            stderr = io.StringIO()
            argv = ["build_atlas_graph.py", str(DEMO), str(output)]
            with (
                mock.patch.object(build_atlas_graph, "datetime", FixedDateTime),
                mock.patch.object(build_atlas_graph.sys, "argv", argv),
                contextlib.redirect_stdout(stdout),
                contextlib.redirect_stderr(stderr),
            ):
                code = build_atlas_graph.main()
            self.assertEqual(0, code, stderr.getvalue())
            graph = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual("atlas-graph", graph["format"])
            self.assertEqual(1, graph["version"])


if __name__ == "__main__":
    unittest.main()
