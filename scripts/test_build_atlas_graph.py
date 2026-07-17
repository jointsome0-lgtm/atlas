import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import build_atlas_graph
from frontmatter import parse_frontmatter


ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "fixtures" / "demo-instance"


class BuilderIntegrationTests(unittest.TestCase):
    def test_builder_uses_shared_parser(self):
        self.assertIs(parse_frontmatter, build_atlas_graph.parse_frontmatter)

    def test_graph_envelope_is_first_and_build_is_deterministic(self):
        first, first_errors, first_warnings = build_atlas_graph.build(DEMO)
        second, second_errors, second_warnings = build_atlas_graph.build(DEMO)
        self.assertEqual([], first_errors)
        self.assertEqual([], second_errors)
        self.assertEqual(first_warnings, second_warnings)
        self.assertEqual(first, second)
        self.assertEqual(["format", "version"], list(first)[:2])
        self.assertEqual("atlas-graph", first["format"])
        self.assertEqual(1, first["version"])
        # §20.1: no dated inputs are read in this phase, so generated_at is
        # absent — never the wall clock.
        self.assertNotIn("generated_at", first)

    def test_built_graph_validates_against_schema(self):
        # The builder's own emission must pass the persisted-format boundary
        # (§25.7): schema plus the validator's graph cross-checks.
        import validate_atlas

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
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("is still a living id" in error for error in errors), errors
        )
        self.assertTrue(
            any("redirects to both" in error for error in errors), errors
        )

    def test_stale_curated_ref_resolves_through_formerly(self):
        # §34.4: curated refs resolve through the retired→living map and are
        # listed in the build report — never failed as broken links.
        materials = {
            "new.md": "---\nid: material:new\ntype: material\n"
                      "title: New (Vera Example)\nkind: docs\nurl: \"\"\n"
                      "status: active\nformerly:\n  - material:old\n---\n",
            "other.md": "---\nid: material:other\ntype: material\n"
                        "title: Other (Vera Example)\nkind: docs\nurl: \"\"\n"
                        "status: active\nsupported_by:\n"
                        "  - material:old\n---\n",
        }
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "materials"
            base.mkdir(parents=True)
            for name, content in materials.items():
                (base / name).write_text(content, encoding="utf-8")
            graph, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertTrue(
            any("stale curated ref material:old" in w for w in warnings),
            warnings,
        )
        supports = [e for e in graph["edges"] if e["type"] == "supports"]
        self.assertEqual(1, len(supports))
        self.assertEqual("material:new", supports[0]["source"])

    def test_role_checks_run_on_resolved_ids(self):
        # §34.4 × §9.4: a stale role step resolves instead of failing
        # membership, and a rename cannot bypass disjointness — primary
        # material:old vs supporting material:new collide after resolution.
        files = {
            "concepts/new.md": "---\nid: concept:new\ntype: concept\n"
                               "title: New (Vera Example)\nformerly:\n"
                               "  - concept:old\n---\n",
            "materials/m-new.md": "---\nid: material:m-new\ntype: material\n"
                                  "title: M (Vera Example)\nkind: docs\n"
                                  "url: \"\"\nstatus: active\nformerly:\n"
                                  "  - material:m-old\n---\n",
            "suggested-routes/r.md": "---\nid: suggested-route:r\n"
                                     "type: suggested_route\n"
                                     "title: R (Vera Example)\n"
                                     "status: available\n"
                                     "steps:\n  - concept:new\n"
                                     "material_roles:\n  - step: concept:old\n"
                                     "    primary_materials:\n"
                                     "      - material:m-old\n"
                                     "    supporting_materials:\n"
                                     "      - material:m-new\n---\n",
        }
        with tempfile.TemporaryDirectory() as directory:
            for relative, content in files.items():
                target = Path(directory) / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
            _, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertFalse(
            any("is not a member of steps" in error for error in errors),
            errors,
        )
        self.assertTrue(
            any("both primary and supporting" in error for error in errors),
            errors,
        )
        self.assertTrue(
            any("stale curated ref concept:old" in w for w in warnings),
            warnings,
        )

    def test_malformed_concept_edges_fail_the_build(self):
        # §25.8: a scalar concept_edges item (or scalar field) must produce
        # an ERROR, not an AttributeError traceback.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "patterns"
            base.mkdir(parents=True)
            (base / "p.md").write_text(
                "---\nid: pattern:p\ntype: pattern\n"
                "title: P (Vera Example)\nconcept_edges:\n"
                "  - concept:a\n---\n",
                encoding="utf-8",
            )
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("is not an edge mapping" in error for error in errors), errors
        )

    def test_non_string_id_and_edge_ref_fail_the_build(self):
        # §25.8: a list-valued id or concept_edges target must be an ERROR,
        # never an unhashable-type traceback.
        files = {
            "concepts/bad-id.md": "---\nid:\n  - concept:a\ntype: concept\n"
                                  "title: Bad (Vera Example)\n---\n",
            "patterns/bad-to.md": "---\nid: pattern:p\ntype: pattern\n"
                                  "title: P (Vera Example)\nconcept_edges:\n"
                                  "  - to:\n      - concept:a\n"
                                  "    role: loads\n---\n",
        }
        with tempfile.TemporaryDirectory() as directory:
            for relative, content in files.items():
                target = Path(directory) / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("is not a string" in error for error in errors), errors
        )
        self.assertTrue(
            any("is not an id" in error for error in errors), errors
        )

    def test_malformed_part_edges_and_role_step_fail_the_build(self):
        # §25.8: a scalar part concept_edges item must not crash the field
        # derivation, and a non-string role step must not reach edge meta.
        files = {
            "materials/m.md": "---\nid: material:m\ntype: material\n"
                              "title: M (Vera Example)\nkind: docs\n"
                              "url: \"\"\nstatus: active\nparts:\n"
                              "  - id: part:m/a\n    title: A\n"
                              "    concept_edges:\n      - concept:x\n---\n",
            "suggested-routes/r.md": "---\nid: suggested-route:r\n"
                                     "type: suggested_route\n"
                                     "title: R (Vera Example)\n"
                                     "status: available\n"
                                     "steps:\n  - concept:a\n"
                                     "material_roles:\n"
                                     "  - step:\n      - concept:a\n"
                                     "    primary_materials:\n"
                                     "      - material:m\n---\n",
        }
        with tempfile.TemporaryDirectory() as directory:
            for relative, content in files.items():
                target = Path(directory) / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("is not an edge mapping" in error for error in errors), errors
        )
        self.assertTrue(
            any("material_roles step" in error and "is not an id" in error
                for error in errors),
            errors,
        )

    def test_non_string_material_id_and_alias_shapes_fail_the_build(self):
        # §25.8: a list-valued material id must not reach field-ref indexing,
        # and malformed aliases must not reach the emitted node.
        files = {
            "materials/bad.md": "---\nid:\n  - material:m\ntype: material\n"
                                "title: M (Vera Example)\nkind: docs\n"
                                "url: \"\"\nstatus: active\n---\n",
            "concepts/a.md": "---\nid: concept:a\ntype: concept\n"
                             "title: A (Vera Example)\naliases: solo\n---\n",
        }
        with tempfile.TemporaryDirectory() as directory:
            for relative, content in files.items():
                target = Path(directory) / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
            graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("is not a string" in error for error in errors), errors
        )
        self.assertTrue(
            any("aliases must be a list of strings" in error
                for error in errors),
            errors,
        )

    def test_round37_shape_guards_fail_the_build(self):
        # §25.8 fail-closed: a non-id formerly entry, a list-valued material
        # kind, and a list-valued part id are ERRORs, never tracebacks or
        # schema-invalid graph payloads.
        files = {
            "concepts/a.md": "---\nid: concept:a\ntype: concept\n"
                             "title: A (Vera Example)\nformerly:\n"
                             "  - garbage\n---\n",
            "materials/m.md": "---\nid: material:m\ntype: material\n"
                              "title: M (Vera Example)\nkind:\n  - docs\n"
                              "url: \"\"\nstatus: active\nparts:\n"
                              "  - id:\n      - part:m/a\n    title: A\n"
                              "---\n",
        }
        with tempfile.TemporaryDirectory() as directory:
            for relative, content in files.items():
                target = Path(directory) / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("is not a canonical §10.1 id" in error for error in errors),
            errors,
        )
        self.assertTrue(
            any("outside the §9.2 vocabulary" in error for error in errors),
            errors,
        )
        self.assertTrue(
            any("is not a string" in error for error in errors), errors
        )

    def test_round38_shape_guards_fail_the_build(self):
        # §25.8: a concept_edges item without a role (schema-required) or
        # with a non-string role, a container status, and a container title
        # are ERRORs — no default role, no traceback, no invalid payload.
        files = {
            "patterns/p.md": "---\nid: pattern:p\ntype: pattern\n"
                             "title: P (Vera Example)\nconcept_edges:\n"
                             "  - to: concept:a\n---\n",
            "materials/m.md": "---\nid: material:m\ntype: material\n"
                              "title: M (Vera Example)\nkind: docs\n"
                              "url: \"\"\nstatus:\n  - active\n---\n",
            "concepts/a.md": "---\nid: concept:a\ntype: concept\n"
                             "title:\n  - A (Vera Example)\n---\n",
        }
        with tempfile.TemporaryDirectory() as directory:
            for relative, content in files.items():
                target = Path(directory) / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("is not an authored relationship role" in error
                for error in errors),
            errors,
        )
        self.assertTrue(
            any("status" in error and "is not a string" in error
                for error in errors),
            errors,
        )
        self.assertTrue(
            any("title" in error and "is not a string" in error
                for error in errors),
            errors,
        )

    def test_round39_string_payload_gates_fail_the_build(self):
        # §10.4/§25.8: container sensitivity/url/attractor/source_plan
        # values are ERRORs, never invalid payloads in the emitted graph.
        files = {
            "concepts/a.md": "---\nid: concept:a\ntype: concept\n"
                             "title: A (Vera Example)\nsensitivity:\n"
                             "  - medical\n---\n",
            "materials/m.md": "---\nid: material:m\ntype: material\n"
                              "title: M (Vera Example)\nkind: docs\n"
                              "url:\n  - x\nstatus: active\n---\n",
            "directions/d.md": "---\nid: direction:d\ntype: direction\n"
                               "title: D (Vera Example)\nstatus: active\n"
                               "attractor:\n  - goal\n---\n",
        }
        with tempfile.TemporaryDirectory() as directory:
            for relative, content in files.items():
                target = Path(directory) / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
            _, errors, _ = build_atlas_graph.build(Path(directory))
        for needle in ("sensitivity", "url", "attractor"):
            self.assertTrue(
                any(needle in error and "is not a string" in error
                    for error in errors),
                (needle, errors),
            )

    def test_round40_gates_fail_the_build(self):
        # §25.8: a non-plan source_plan, a container support note, and a
        # container route status are ERRORs — no traceback, no invalid
        # payload, no silent embed.
        files = {
            "suggested-routes/r.md": "---\nid: suggested-route:r\n"
                                     "type: suggested_route\n"
                                     "title: R (Vera Example)\n"
                                     "status:\n  - available\n"
                                     "steps:\n  - concept:a\n"
                                     "source_plan: garbage\n---\n",
            "materials/m.md": "---\nid: material:m\ntype: material\n"
                              "title: M (Vera Example)\nkind: docs\n"
                              "url: \"\"\nstatus: active\nsupported_by:\n"
                              "  - id: material:x\n    note:\n      - bad\n"
                              "---\n",
        }
        with tempfile.TemporaryDirectory() as directory:
            for relative, content in files.items():
                target = Path(directory) / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("is not a plan id" in error for error in errors), errors
        )
        self.assertTrue(
            any("supported_by note" in error and "is not a string" in error
                for error in errors),
            errors,
        )
        self.assertTrue(
            any("status" in error and "is not a string" in error
                for error in errors),
            errors,
        )

    def test_zone_without_figure_region_fails_the_build(self):
        # §32.1/§20 step 12: every zone authors its figure_region — a zone
        # the silhouette cannot place never leaves the build.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "zones"
            base.mkdir(parents=True)
            (base / "z.md").write_text(
                "---\nid: zone:shoulder\ntype: zone\n"
                "title: Shoulder (Vera Example)\n---\n",
                encoding="utf-8",
            )
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("zone requires figure_region" in error for error in errors),
            errors,
        )

    def test_container_concept_edge_weight_fails_the_build(self):
        # §25.8/§14.9: a nested weight value is an ERROR, never a hash
        # attempt on a container or an invalid emitted weight.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "patterns"
            base.mkdir(parents=True)
            (base / "p.md").write_text(
                "---\nid: pattern:p\ntype: pattern\n"
                "title: P (Vera Example)\nconcept_edges:\n"
                "  - to: zone:z\n    role: loads\n    weight:\n"
                "      - high\n---\n",
                encoding="utf-8",
            )
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("outside the §14.9 scale" in error for error in errors),
            errors,
        )

    def test_cross_kind_formerly_fails_the_build(self):
        # §34.4: identity continuation is per-kind — a material cannot
        # absorb a part id.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "materials"
            base.mkdir(parents=True)
            (base / "m.md").write_text(
                "---\nid: material:m\ntype: material\n"
                "title: M (Vera Example)\nkind: docs\nurl: \"\"\n"
                "status: active\nformerly:\n  - part:old/x\n---\n",
                encoding="utf-8",
            )
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("changes kind" in error for error in errors), errors
        )

    def test_second_writer_refuses_on_the_instance_lock(self):
        # §25.6 (#36): a writing run takes .atlas-lock at the instance root
        # and a second concurrent writer refuses with exit 1.
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / ".atlas-lock").write_text(
                '{"pid": 1, "started_at": "2026-07-17T00:00:00Z"}\n',
                encoding="utf-8",
            )
            output = Path(directory) / "out" / "atlas-graph.json"
            argv = ["build_atlas_graph.py", directory, str(output)]
            stdout = io.StringIO()
            stderr = io.StringIO()
            with (
                mock.patch.object(build_atlas_graph.sys, "argv", argv),
                contextlib.redirect_stdout(stdout),
                contextlib.redirect_stderr(stderr),
            ):
                code = build_atlas_graph.main()
            self.assertEqual(1, code)
            self.assertIn(".atlas-lock", stderr.getvalue())
            self.assertFalse(output.exists())
            # the loser must not have removed the holder's lock
            self.assertTrue((Path(directory) / ".atlas-lock").exists())

    def test_exact_duplicate_edges_collapse_with_unioned_provenance(self):
        # §20.3 (V1 slice): a repeated authored entry collapses into one
        # edge; the emitted graph passes its own boundary validator.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "concepts"
            base.mkdir(parents=True)
            (base / "a.md").write_text(
                "---\nid: concept:a\ntype: concept\n"
                "title: A (Vera Example)\nrelated_concepts:\n"
                "  - concept:b\n  - concept:b\n---\n",
                encoding="utf-8",
            )
            (base / "b.md").write_text(
                "---\nid: concept:b\ntype: concept\n"
                "title: B (Vera Example)\n---\n",
                encoding="utf-8",
            )
            graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        related = [e for e in graph["edges"] if e["type"] == "related_to"]
        self.assertEqual(1, len(related))

    def test_scalar_formerly_fails_the_build(self):
        # A parser-valid scalar formerly must be a build error, never a
        # char-by-char redirect walk or a string payload in the graph.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "concepts"
            base.mkdir(parents=True)
            (base / "a.md").write_text(
                "---\nid: concept:a\ntype: concept\n"
                "title: A (Vera Example)\nformerly: concept:gone\n---\n",
                encoding="utf-8",
            )
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("must be a list of ids" in error for error in errors), errors
        )

    def test_unknown_material_kind_fails_the_build(self):
        # §9.2: kind is a closed vocabulary — the graph schema rejects
        # anything else, so the builder must too.
        with tempfile.TemporaryDirectory() as directory:
            material = Path(directory) / "materials" / "bad.md"
            material.parent.mkdir(parents=True)
            material.write_text(
                "---\nid: material:bad\ntype: material\n"
                "title: Bad (Vera Example)\nkind: blog\nurl: \"\"\n"
                "status: active\n---\n",
                encoding="utf-8",
            )
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("outside the §9.2 vocabulary" in error for error in errors),
            errors,
        )

    def test_main_writes_envelope(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "atlas-graph.json"
            stdout = io.StringIO()
            stderr = io.StringIO()
            argv = ["build_atlas_graph.py", str(DEMO), str(output)]
            with (
                mock.patch.object(build_atlas_graph.sys, "argv", argv),
                contextlib.redirect_stdout(stdout),
                contextlib.redirect_stderr(stderr),
            ):
                code = build_atlas_graph.main()
            self.assertEqual(0, code, stderr.getvalue())
            graph = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual("atlas-graph", graph["format"])
            self.assertEqual(1, graph["version"])
            # §20.2: the write is temp-file + atomic rename — nothing left.
            self.assertEqual([], list(Path(directory).glob("*.tmp")))


if __name__ == "__main__":
    unittest.main()
