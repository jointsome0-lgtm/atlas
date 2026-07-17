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

    def test_built_graph_validates_against_schema(self):
        # The builder's own emission must pass the persisted-format boundary
        # (§25.7): schema plus the validator's graph cross-checks.
        import validate_atlas

        with mock.patch.object(build_atlas_graph, "datetime", FixedDateTime):
            graph, errors, _ = build_atlas_graph.build(DEMO)
        self.assertEqual([], errors)
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "graph" / "atlas-graph.json"
            out.parent.mkdir()
            out.write_text(json.dumps(graph), encoding="utf-8")
            stdout = io.StringIO()
            stderr = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = validate_atlas.main(["validate", directory])
        self.assertEqual(0, code, stderr.getvalue())

    def test_missing_material_payload_fails_the_build(self):
        # §10.4/§25.7: kind/url/status are required on the emitted material
        # node — omitting them must fail the build, not emit an invalid graph.
        with tempfile.TemporaryDirectory() as directory:
            material = Path(directory) / "materials" / "bad.md"
            material.parent.mkdir(parents=True)
            material.write_text(
                "---\nid: material:bad\ntype: material\n"
                "title: Bad (Vera Example)\n---\n",
                encoding="utf-8",
            )
            with mock.patch.object(build_atlas_graph, "datetime", FixedDateTime):
                _, errors, _ = build_atlas_graph.build(Path(directory))
        for field in ("kind", "url", "status"):
            self.assertTrue(
                any(f"material requires {field}" in error for error in errors),
                errors,
            )

    def test_non_string_role_material_fails_the_build(self):
        # A parser-valid mapping item inside a role list must produce a
        # build error, not a TypeError or a malformed edge endpoint.
        with tempfile.TemporaryDirectory() as directory:
            route = Path(directory) / "suggested-routes" / "bad.md"
            route.parent.mkdir(parents=True)
            route.write_text(
                "---\nid: suggested-route:bad\ntype: suggested_route\n"
                "title: Bad (Vera Example)\nstatus: available\n"
                "steps:\n  - concept:a\n"
                "material_roles:\n  - step: concept:a\n"
                "    primary_materials:\n      - id: material:x\n---\n",
                encoding="utf-8",
            )
            with mock.patch.object(build_atlas_graph, "datetime", FixedDateTime):
                _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("is not a material id" in error for error in errors), errors
        )

    def test_part_formerly_reaches_the_emitted_node(self):
        # §10.4/§34.4: a renamed part's redirects must survive into the graph.
        with tempfile.TemporaryDirectory() as directory:
            material = Path(directory) / "materials" / "docs.md"
            material.parent.mkdir(parents=True)
            material.write_text(
                "---\nid: material:docs\ntype: material\n"
                "title: Docs (Vera Example)\nkind: docs\nurl: \"\"\n"
                "status: active\nparts:\n  - id: part:docs/intro\n"
                "    title: Intro\n    formerly:\n"
                "      - part:docs/old-intro\n---\n",
                encoding="utf-8",
            )
            with mock.patch.object(build_atlas_graph, "datetime", FixedDateTime):
                graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        part = next(n for n in graph["nodes"] if n["id"] == "part:docs/intro")
        self.assertEqual(["part:docs/old-intro"], part["formerly"])

    def test_scalar_material_role_entry_fails_the_build(self):
        # §9.4: a role entry is the step plus its lists — a scalar item must
        # be an ERROR, not a silently absent set of role edges.
        with tempfile.TemporaryDirectory() as directory:
            route = Path(directory) / "suggested-routes" / "bad.md"
            route.parent.mkdir(parents=True)
            route.write_text(
                "---\nid: suggested-route:bad\ntype: suggested_route\n"
                "title: Bad (Vera Example)\nstatus: available\n"
                "steps:\n  - concept:a\n"
                "material_roles:\n  - material:m\n---\n",
                encoding="utf-8",
            )
            with mock.patch.object(build_atlas_graph, "datetime", FixedDateTime):
                _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("is not a role mapping" in error for error in errors), errors
        )

    def test_conflicting_formerly_redirects_fail_the_build(self):
        # §34.4: a retired id that is still living, or that redirects to two
        # survivors, is a build error.
        concepts = {
            "a.md": "---\nid: concept:a\ntype: concept\n"
                    "title: A (Vera Example)\nformerly:\n  - concept:b\n"
                    "  - concept:gone\n---\n",
            "b.md": "---\nid: concept:b\ntype: concept\n"
                    "title: B (Vera Example)\n---\n",
            "c.md": "---\nid: concept:c\ntype: concept\n"
                    "title: C (Vera Example)\nformerly:\n  - concept:gone\n"
                    "---\n",
        }
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "concepts"
            base.mkdir(parents=True)
            for name, content in concepts.items():
                (base / name).write_text(content, encoding="utf-8")
            with mock.patch.object(build_atlas_graph, "datetime", FixedDateTime):
                _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("is still a living id" in error for error in errors), errors
        )
        self.assertTrue(
            any("redirects to both" in error for error in errors), errors
        )

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
