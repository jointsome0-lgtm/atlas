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

    def test_lone_authored_weight_wins_over_unassessed_duplicate(self):
        # §14.9: one entry with a weight plus one without is a single
        # hypothesis, not a conflict; two different authored weights are.
        content = ("---\nid: pattern:p\ntype: pattern\n"
                   "title: P (Vera Example)\nconcept_edges:\n"
                   "  - to: concept:c\n    role: extends\n"
                   "  - to: concept:c\n    role: extends\n"
                   "    weight: high\n---\n")
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "patterns"
            base.mkdir(parents=True)
            (base / "p.md").write_text(content, encoding="utf-8")
            (Path(directory) / "concepts").mkdir()
            (Path(directory) / "concepts" / "c.md").write_text(
                "---\nid: concept:c\ntype: concept\n"
                "title: C (Vera Example)\n---\n",
                encoding="utf-8",
            )
            graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        extends = [e for e in graph["edges"] if e["type"] == "extends"]
        self.assertEqual(1, len(extends))
        self.assertEqual("high", extends[0]["weight"])

    def test_concept_authored_concept_edges_are_emitted(self):
        # §9.1 (#31): concepts are the authored species' third author —
        # a concept_edges block on a concept reaches the graph.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "concepts"
            base.mkdir(parents=True)
            (base / "a.md").write_text(
                "---\nid: concept:a\ntype: concept\n"
                "title: A (Vera Example)\nconcept_edges:\n"
                "  - to: concept:b\n    role: prerequisite_of\n"
                "    weight: high\n---\n",
                encoding="utf-8",
            )
            (base / "b.md").write_text(
                "---\nid: concept:b\ntype: concept\n"
                "title: B (Vera Example)\n---\n",
                encoding="utf-8",
            )
            graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        prereqs = [e for e in graph["edges"]
                   if e["type"] == "prerequisite_of"]
        self.assertEqual(1, len(prereqs))
        self.assertEqual("concept:a", prereqs[0]["source"])
        self.assertEqual("concept:b", prereqs[0]["target"])
        self.assertEqual("high", prereqs[0]["weight"])
        self.assertEqual(["concept:a"], prereqs[0]["provenance"])

    def test_concept_cannot_author_part_voice_roles(self):
        # §10.2: mentions is part-voice — not authorable from a concept.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "concepts"
            base.mkdir(parents=True)
            (base / "a.md").write_text(
                "---\nid: concept:a\ntype: concept\n"
                "title: A (Vera Example)\nconcept_edges:\n"
                "  - to: concept:b\n    role: mentions\n---\n",
                encoding="utf-8",
            )
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("not authorable from a concept source" in error
                for error in errors), errors)

    def test_part_cannot_author_related_to(self):
        # §10.2: related_to sources are concept-kind only.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "materials"
            base.mkdir(parents=True)
            (base / "m.md").write_text(
                "---\nid: material:m\ntype: material\n"
                "title: M (Vera Example)\nkind: docs\nurl: \"\"\n"
                "status: active\nparts:\n  - id: part:m/x\n    title: X\n"
                "    concept_edges:\n      - to: concept:c\n"
                "        role: related_to\n---\n",
                encoding="utf-8",
            )
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("not authorable from a material_part source" in error
                for error in errors), errors)

    def test_two_sided_related_to_collapses_sorted_with_union(self):
        # §20.3: related_to is symmetric — endpoints sort and two-sided
        # authoring becomes one identity with unioned provenance.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "concepts"
            base.mkdir(parents=True)
            (base / "a.md").write_text(
                "---\nid: concept:a\ntype: concept\n"
                "title: A (Vera Example)\nrelated_concepts:\n"
                "  - concept:b\n---\n",
                encoding="utf-8",
            )
            (base / "b.md").write_text(
                "---\nid: concept:b\ntype: concept\n"
                "title: B (Vera Example)\nrelated_concepts:\n"
                "  - concept:a\n---\n",
                encoding="utf-8",
            )
            graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        related = [e for e in graph["edges"] if e["type"] == "related_to"]
        self.assertEqual(1, len(related))
        self.assertEqual("concept:a", related[0]["source"])
        self.assertEqual("concept:b", related[0]["target"])
        self.assertEqual(["concept:a", "concept:b"],
                         related[0]["provenance"])

    def test_two_sided_related_to_weight_conflict_errors(self):
        # §20.3: after canonicalization, two authored hypotheses that
        # disagree on one identity are a build ERROR.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "concepts"
            base.mkdir(parents=True)
            (base / "a.md").write_text(
                "---\nid: concept:a\ntype: concept\n"
                "title: A (Vera Example)\nconcept_edges:\n"
                "  - to: concept:b\n    role: related_to\n"
                "    weight: high\n---\n",
                encoding="utf-8",
            )
            (base / "b.md").write_text(
                "---\nid: concept:b\ntype: concept\n"
                "title: B (Vera Example)\nconcept_edges:\n"
                "  - to: concept:a\n    role: related_to\n"
                "    weight: low\n---\n",
                encoding="utf-8",
            )
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("conflicting weights" in error for error in errors), errors)

    def test_prerequisite_cycle_warns_with_path(self):
        # §20.3: a prerequisite_of cycle is a WARNING carrying the cycle
        # path — never a build failure.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "concepts"
            base.mkdir(parents=True)
            (base / "a.md").write_text(
                "---\nid: concept:a\ntype: concept\n"
                "title: A (Vera Example)\nconcept_edges:\n"
                "  - to: concept:b\n    role: prerequisite_of\n---\n",
                encoding="utf-8",
            )
            (base / "b.md").write_text(
                "---\nid: concept:b\ntype: concept\n"
                "title: B (Vera Example)\nconcept_edges:\n"
                "  - to: concept:a\n    role: prerequisite_of\n---\n",
                encoding="utf-8",
            )
            _, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertTrue(
            any("prerequisite_of cycle" in warning
                and "concept:a -> concept:b -> concept:a" in warning
                for warning in warnings), warnings)

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


def _materialize(tree: dict) -> tempfile.TemporaryDirectory:
    directory = tempfile.TemporaryDirectory()
    for rel, content in tree.items():
        path = Path(directory.name) / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    return directory


_CONCEPT = ("---\nid: concept:%s\ntype: concept\n"
            "title: %s (Vera Example)\n---\n")
_MATERIAL = ("---\nid: material:%s\ntype: material\n"
             "title: %s (Vera Example)\nkind: docs\nurl: \"\"\n"
             "status: active\noverall_concepts:\n  - concept:c\n"
             "parts: []\n---\n")
_ARTIFACT_ROW = json.dumps({
    "id": "artifact:2026-07-16-001", "type": "note", "path": "p",
    "observed_at": "2026-07-16", "summary": "s (Vera Example)",
    "touches": ["concept:c"], "supports_state_updates": [],
    "evidence_strength": "applied",
})
_QUESTION_ROW = json.dumps({
    "id": "question:q", "type": "question", "text": "Vera Example?",
    "created_at": "2026-07-16", "pulls": ["concept:c"],
    "source": {"artifact": "artifact:2026-07-16-001"},
})


def _encounter_row(depth="applied", target="material:m", context=None):
    row = {"id": "encounter:2026-07-16-001", "date": "2026-07-16",
           "target": target, "depth": depth, "mode": "question-driven"}
    if context is not None:
        row["context"] = context
    return json.dumps(row)


class JournalProjectionTests(unittest.TestCase):
    # §20 step 8 (#31): the structural journal projection — rows become
    # nodes plus their §10.2 derived edges and §11.2-§11.3 role edges;
    # state folds stay §29 Phase 3/4.

    def _edges(self, graph, kind):
        return [e for e in graph["edges"] if e["type"] == kind]

    def test_journal_rows_become_nodes_and_derived_edges(self):
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "materials/m.md": _MATERIAL % ("m", "M"),
            "state/artifacts.jsonl": _ARTIFACT_ROW + "\n",
            "state/questions.jsonl": _QUESTION_ROW + "\n",
            "state/encounters.jsonl": _encounter_row(
                context={"question": "question:q"}) + "\n",
        }) as directory:
            graph, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertEqual([], warnings)
        kinds = {n["id"]: n["type"] for n in graph["nodes"]}
        self.assertEqual("artifact", kinds["artifact:2026-07-16-001"])
        self.assertEqual("question", kinds["question:q"])
        self.assertEqual("encounter", kinds["encounter:2026-07-16-001"])
        self.assertEqual(1, len(self._edges(graph, "visited")))
        self.assertEqual(1, len(self._edges(graph, "pulled_by")))
        self.assertEqual(1, len(self._edges(graph, "influences")))
        # §11.2: deep use (applied) folds the encounter target primary
        # for the cited question, provenance = the deriving encounter.
        primary = self._edges(graph, "primary_for")
        self.assertEqual(1, len(primary))
        self.assertEqual("material:m", primary[0]["source"])
        self.assertEqual("question:q", primary[0]["target"])
        self.assertEqual(["encounter:2026-07-16-001"],
                         primary[0]["provenance"])
        # §10.4: an encounter's fields are its target's fields.
        encounter = next(n for n in graph["nodes"]
                         if n["type"] == "encounter")
        self.assertEqual(["knowledge"], encounter["fields"])

    def test_shallow_question_context_folds_supporting(self):
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "materials/m.md": _MATERIAL % ("m", "M"),
            "state/artifacts.jsonl": _ARTIFACT_ROW + "\n",
            "state/questions.jsonl": _QUESTION_ROW + "\n",
            "state/encounters.jsonl": _encounter_row(
                depth="read", context={"question": "question:q"}) + "\n",
        }) as directory:
            graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertEqual([], self._edges(graph, "primary_for"))
        supporting = self._edges(graph, "supporting_for")
        self.assertEqual(1, len(supporting))
        self.assertEqual("material:m", supporting[0]["source"])
        self.assertEqual("question:q", supporting[0]["target"])

    def test_trail_segment_derives_movement_and_roles(self):
        # §9.9/§11.3: via materials are primary; the target of an
        # encounter citing a via artifact, not itself in via, supports —
        # provenance lists segment and encounter (§10.3).
        with _materialize({
            "concepts/a.md": _CONCEPT % ("a", "A"),
            "concepts/b.md": _CONCEPT % ("b", "B"),
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "materials/m.md": _MATERIAL % ("m", "M"),
            "materials/n.md": _MATERIAL % ("n", "N"),
            "directions/d.md": (
                "---\nid: direction:d\ntype: direction\n"
                "title: D (Vera Example)\nattractor: pull\n"
                "status: active\ncore_concepts:\n  - concept:a\n---\n"),
            "trails/2026-07-16-001.md": (
                "---\nid: trail-segment:2026-07-16-001\n"
                "type: trail_segment\ntitle: \"\"\ndate: 2026-07-16\n"
                "direction: direction:d\nfrom: concept:a\nto: concept:b\n"
                "via:\n  - material:m\n  - artifact:2026-07-16-001\n"
                "reason: momentum (Vera Example)\n---\n"),
            "state/artifacts.jsonl": _ARTIFACT_ROW + "\n",
            "state/encounters.jsonl": _encounter_row(
                target="material:n",
                context={"artifact": "artifact:2026-07-16-001"}) + "\n",
        }) as directory:
            graph, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertEqual([], warnings)
        seg = "trail-segment:2026-07-16-001"
        moved = self._edges(graph, "moved_to")
        self.assertEqual([("concept:a", "concept:b", [seg])],
                         [(e["source"], e["target"], e["provenance"])
                          for e in moved])
        self.assertEqual([(seg, "material:m")],
                         [(e["source"], e["target"])
                          for e in self._edges(graph, "via")])
        self.assertEqual([(seg, "artifact:2026-07-16-001")],
                         [(e["source"], e["target"])
                          for e in self._edges(graph, "produced_artifact")])
        primary = self._edges(graph, "primary_for")
        self.assertEqual([("material:m", seg, [seg])],
                         [(e["source"], e["target"], e["provenance"])
                          for e in primary])
        supporting = self._edges(graph, "supporting_for")
        self.assertEqual(
            [("material:n", seg,
              ["encounter:2026-07-16-001", seg])],
            [(e["source"], e["target"], e["provenance"])
             for e in supporting])
        # §10.4: segment fields = from ∪ to.
        segment = next(n for n in graph["nodes"]
                       if n["type"] == "trail_segment")
        self.assertEqual(["knowledge"], segment["fields"])

    def test_dangling_journal_ref_warns_and_skips(self):
        # §20 step 11: a journal-row ref classifies by origin — missing
        # target is a warning and the edge is skipped, never a failure.
        with _materialize({
            "state/encounters.jsonl": _encounter_row(
                target="material:gone") + "\n",
        }) as directory:
            graph, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertTrue(any("material:gone missing" in w for w in warnings),
                        warnings)
        self.assertEqual([], graph["edges"])
        self.assertEqual(1, len(graph["nodes"]))

    def test_byte_identical_row_folds_once_with_warning(self):
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/artifacts.jsonl": _ARTIFACT_ROW + "\n"
                                     + _ARTIFACT_ROW + "\n",
        }) as directory:
            graph, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertTrue(any("folded once (§20.1)" in w for w in warnings),
                        warnings)
        self.assertEqual(1, len([n for n in graph["nodes"]
                                 if n["type"] == "artifact"]))

    def test_duplicate_row_across_rotated_files_folds_once(self):
        # §20.1: the rotated files' lexicographic concatenation is one
        # journal — a byte-identical repeat across files folds once.
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/artifacts/2025.jsonl": _ARTIFACT_ROW + "\n",
            "state/artifacts/2026.jsonl": _ARTIFACT_ROW + "\n",
        }) as directory:
            graph, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertTrue(any("folded once (§20.1)" in w for w in warnings),
                        warnings)
        self.assertEqual(1, len([n for n in graph["nodes"]
                                 if n["type"] == "artifact"]))

    def test_stale_trail_direction_resolves_through_formerly(self):
        # §34.4: direction is a curated ref — a renamed direction resolves
        # in the emitted segment payload, with the stale-ref warning.
        with _materialize({
            "concepts/a.md": _CONCEPT % ("a", "A"),
            "concepts/b.md": _CONCEPT % ("b", "B"),
            "directions/d.md": (
                "---\nid: direction:new\ntype: direction\n"
                "title: D (Vera Example)\nattractor: pull\n"
                "status: active\nformerly:\n  - direction:old\n---\n"),
            "trails/2026-07-16-001.md": (
                "---\nid: trail-segment:2026-07-16-001\n"
                "type: trail_segment\ntitle: \"\"\ndate: 2026-07-16\n"
                "direction: direction:old\nfrom: concept:a\nto: concept:b\n"
                "via: []\nreason: momentum (Vera Example)\n---\n"),
        }) as directory:
            graph, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        segment = next(n for n in graph["nodes"]
                       if n["type"] == "trail_segment")
        self.assertEqual("direction:new", segment["direction"])
        self.assertTrue(
            any("stale curated ref direction:old resolved to direction:new"
                in w for w in warnings), warnings)

    def test_malformed_journal_row_fails_the_build(self):
        with _materialize({
            "state/artifacts.jsonl": "not json\n",
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(any("invalid JSONL row" in e for e in errors), errors)

    def test_edges_emit_in_canonical_identity_order(self):
        # §20.3 determinism: type, source, target, then meta discriminant.
        graph, errors, _ = build_atlas_graph.build(DEMO)
        self.assertEqual([], errors)
        keys = [(e["type"], e["source"], e["target"],
                 e.get("context") or "", e.get("order") or 0,
                 e.get("step") or "") for e in graph["edges"]]
        self.assertEqual(sorted(keys), keys)

    def test_built_journal_instance_passes_the_boundary(self):
        # Roundtrip: the builder's own emission over a journal-bearing
        # instance must satisfy the persisted-format boundary (V1).
        import validate_atlas
        with _materialize({
            "atlas/concepts/c.md": _CONCEPT % ("c", "C"),
            "atlas/materials/m.md": _MATERIAL % ("m", "M"),
            "state/artifacts.jsonl": _ARTIFACT_ROW + "\n",
            "state/questions.jsonl": _QUESTION_ROW + "\n",
            "state/encounters.jsonl": _encounter_row(
                context={"question": "question:q"}) + "\n",
        }) as directory:
            root = Path(directory)
            graph, errors, _ = build_atlas_graph.build(root / "atlas")
            self.assertEqual([], errors)
            (root / "graph").mkdir()
            (root / "graph" / "atlas-graph.json").write_text(
                json.dumps(graph, indent=2) + "\n", encoding="utf-8")
            errors, warnings, _ = validate_atlas.validate_instance(root)
        self.assertEqual([], errors)
        self.assertEqual([], warnings)

    def test_generated_at_anchors_to_max_activity_date(self):
        # §20.1: the default as-of is the max activity date across the
        # dated inputs, emitted as UTC midnight.
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/artifacts.jsonl": _ARTIFACT_ROW.replace(
                '"2026-07-16"', '"2026-07-14"') + "\n",
            "state/questions.jsonl": _QUESTION_ROW + "\n",
        }) as directory:
            graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertEqual("2026-07-16T00:00:00Z", graph["generated_at"])

    def test_trail_segment_formerly_is_rejected(self):
        # §34.4: journal record ids get no redirect machinery — a segment
        # authoring formerly is an error, never an identity continuation.
        with _materialize({
            "concepts/a.md": _CONCEPT % ("a", "A"),
            "concepts/b.md": _CONCEPT % ("b", "B"),
            "directions/d.md": (
                "---\nid: direction:d\ntype: direction\n"
                "title: D (Vera Example)\nattractor: pull\n"
                "status: active\n---\n"),
            "trails/2026-07-16-001.md": (
                "---\nid: trail-segment:2026-07-16-001\n"
                "type: trail_segment\ntitle: \"\"\ndate: 2026-07-16\n"
                "direction: direction:d\nfrom: concept:a\nto: concept:b\n"
                "via: []\nreason: momentum (Vera Example)\n"
                "formerly:\n  - trail-segment:2026-07-15-009\n---\n"),
        }) as directory:
            graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("no formerly redirect (§34.4)" in e for e in errors), errors)
        segment = next(n for n in graph["nodes"]
                       if n["type"] == "trail_segment")
        self.assertNotIn("formerly", segment)

    def test_malformed_activity_date_fails_the_build(self):
        # §9/§10: a malformed observed_at must fail closed, never emit a
        # schema-invalid graph or silently drop the row from the §20.1
        # as-of universe.
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/artifacts.jsonl": _ARTIFACT_ROW.replace(
                '"2026-07-16"', '"bad-date"') + "\n",
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("is not a YYYY-MM-DD date" in e for e in errors), errors)

    def test_dangling_trail_direction_warns(self):
        # §34.2/§20 step 11: direction is payload-only — a deleted or
        # misspelled direction in retained history warns, never fails.
        with _materialize({
            "concepts/a.md": _CONCEPT % ("a", "A"),
            "concepts/b.md": _CONCEPT % ("b", "B"),
            "trails/2026-07-16-001.md": (
                "---\nid: trail-segment:2026-07-16-001\n"
                "type: trail_segment\ntitle: \"\"\ndate: 2026-07-16\n"
                "direction: direction:missing\nfrom: concept:a\n"
                "to: concept:b\nvia: []\n"
                "reason: momentum (Vera Example)\n---\n"),
        }) as directory:
            graph, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertTrue(
            any("direction:missing missing" in w for w in warnings),
            warnings)
        segment = next(n for n in graph["nodes"]
                       if n["type"] == "trail_segment")
        self.assertEqual("direction:missing", segment["direction"])

    def test_malformed_question_source_fails_the_build(self):
        # §25.8/§10.4: a present-but-malformed source object must fail
        # closed, never emit a question node without its provenance.
        row = _QUESTION_ROW.replace(
            '{"artifact": "artifact:2026-07-16-001"}', '{"artifact": 5}')
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/questions.jsonl": row + "\n",
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("is not a §9.8 source object" in e for e in errors), errors)

    def test_malformed_encounter_context_fails_the_build(self):
        # §25.8: a malformed context silently dropped would silently
        # change the §11.2 role derivation.
        with _materialize({
            "state/encounters.jsonl": _encounter_row(
                context={"question": 5}) + "\n",
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("is not a §9.7 context object" in e for e in errors), errors)

    def test_non_via_kind_in_trail_via_fails_the_build(self):
        # §9.9/§10.4: via holds material(part)/artifact ids only — an
        # off-kind id fails before it is embedded in the payload.
        with _materialize({
            "concepts/a.md": _CONCEPT % ("a", "A"),
            "concepts/b.md": _CONCEPT % ("b", "B"),
            "directions/d.md": (
                "---\nid: direction:d\ntype: direction\n"
                "title: D (Vera Example)\nattractor: pull\n"
                "status: active\n---\n"),
            "trails/2026-07-16-001.md": (
                "---\nid: trail-segment:2026-07-16-001\n"
                "type: trail_segment\ntitle: \"\"\ndate: 2026-07-16\n"
                "direction: direction:d\nfrom: concept:a\nto: concept:b\n"
                "via:\n  - concept:a\n"
                "reason: momentum (Vera Example)\n---\n"),
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("is not a material(part) or artifact id" in e
                for e in errors), errors)

    def test_wrong_kind_trail_refs_fail_the_build(self):
        # §9.9/§10.4: direction is a direction id, to/from concept-kind —
        # wrong kinds fail before the payload embeds them.
        with _materialize({
            "concepts/a.md": _CONCEPT % ("a", "A"),
            "materials/m.md": _MATERIAL % ("m", "M"),
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "trails/2026-07-16-001.md": (
                "---\nid: trail-segment:2026-07-16-001\n"
                "type: trail_segment\ntitle: \"\"\ndate: 2026-07-16\n"
                "direction: concept:a\nfrom: concept:a\nto: material:m\n"
                "via: []\nreason: momentum (Vera Example)\n---\n"),
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("direction 'concept:a' is not a direction id" in e
                for e in errors), errors)
        self.assertTrue(
            any("to 'material:m' is not a concept/pattern id" in e
                for e in errors), errors)

    def test_non_material_encounter_target_fails_the_build(self):
        # §9.7/§10.4: an encounter targets a material(part) — a wrong-kind
        # target fails closed, never an invalid emitted payload.
        with _materialize({
            "concepts/a.md": _CONCEPT % ("a", "A"),
            "state/encounters.jsonl": _encounter_row(
                target="concept:a") + "\n",
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("target 'concept:a' is not a material/part id" in e
                for e in errors), errors)

    def test_wrong_prefix_question_source_fails_the_build(self):
        # §9.8/§10.4: source values carry their key's prefix.
        row = _QUESTION_ROW.replace(
            '"artifact:2026-07-16-001"', '"concept:c"')
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/questions.jsonl": row + "\n",
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("is not a §9.8 source object" in e for e in errors), errors)

    def test_trail_with_classed_via_is_emitted_classed(self):
        # §20 step 12/§32.6: a segment whose via cites a classed material
        # carries the class.
        with _materialize({
            "concepts/a.md": _CONCEPT % ("a", "A"),
            "concepts/b.md": _CONCEPT % ("b", "B"),
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "materials/m.md": (_MATERIAL % ("m", "M")).replace(
                "status: active\n", "status: active\nsensitivity: medical\n"),
            "directions/d.md": (
                "---\nid: direction:d\ntype: direction\n"
                "title: D (Vera Example)\nattractor: pull\n"
                "status: active\n---\n"),
            "trails/2026-07-16-001.md": (
                "---\nid: trail-segment:2026-07-16-001\n"
                "type: trail_segment\ntitle: \"\"\ndate: 2026-07-16\n"
                "direction: direction:d\nfrom: concept:a\nto: concept:b\n"
                "via:\n  - material:m\n"
                "reason: momentum (Vera Example)\n---\n"),
        }) as directory:
            graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        segment = next(n for n in graph["nodes"]
                       if n["type"] == "trail_segment")
        self.assertEqual("medical", segment["sensitivity"])


if __name__ == "__main__":
    unittest.main()
