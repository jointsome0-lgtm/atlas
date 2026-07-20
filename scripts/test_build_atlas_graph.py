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

    def test_demo_rename_fixture_resolves_through_formerly(self):
        # §34.4 (#49): the demo instance carries one rename — the stale
        # related_concepts spelling concept:restful-api folds into the
        # survivor with a report line; the retired id never emits, and the
        # merged related_to identity unions both authors' provenance.
        graph, errors, warnings = build_atlas_graph.build(DEMO)
        self.assertEqual([], errors)
        by_id = {node["id"]: node for node in graph["nodes"]}
        self.assertNotIn("concept:restful-api", by_id)
        self.assertEqual(["concept:restful-api"],
                         by_id["concept:rest-api"]["formerly"])
        edge = next(e for e in graph["edges"]
                    if e["type"] == "related_to"
                    and e["source"] == "concept:idempotency"
                    and e["target"] == "concept:rest-api")
        self.assertEqual(["concept:idempotency", "concept:rest-api"],
                         edge["provenance"])
        self.assertTrue(
            any("concept:restful-api" in warning
                and "concept:rest-api" in warning
                and "§34.4" in warning for warning in warnings),
            warnings)
        for e in graph["edges"]:
            self.assertNotIn("concept:restful-api",
                             {e["source"], e["target"], *e["provenance"]})

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
            output = Path(directory) / "graph" / "atlas-graph.json"
            argv = ["build_atlas_graph.py", str(DEMO), str(output)]
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
            output = Path(directory) / "graph" / "atlas-graph.json"
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
            self.assertEqual([], list(output.parent.glob("*.tmp")))


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


class LaneBTests(unittest.TestCase):
    def _run_main(self, curated, output, *options):
        stdout = io.StringIO()
        stderr = io.StringIO()
        argv = ["build_atlas_graph.py", *options,
                str(curated), str(output)]
        with (
            mock.patch.object(build_atlas_graph.sys, "argv", argv),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            code = build_atlas_graph.main()
        return code, stdout.getvalue(), stderr.getvalue()

    def test_explicit_as_of_flag_stamps_generated_at(self):
        # §20.1: --as-of is the explicit fold anchor and emits UTC midnight.
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
        }) as directory:
            output = Path(directory) / "graph" / "atlas-graph.json"
            code, _, stderr = self._run_main(
                directory, output, "--as-of", "2026-01-15")
            self.assertEqual(0, code, stderr)
            graph = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual("2026-01-15T00:00:00Z", graph["generated_at"])

    def test_redacted_emission_is_beside_full_schema_valid_and_deterministic(self):
        # §20 step 12/§32.6: the builder owns both variants. A classed zone,
        # its incident loads edge, and its silhouette projection leave the
        # agent-facing graph whole; the complete graph is unchanged.
        import validate_atlas

        with _materialize({
            "atlas/zones/shoulder.md": (
                "---\nid: zone:shoulder\ntype: zone\n"
                "title: Shoulder (Vera Example)\nfigure_region: shoulder\n"
                "sensitivity: medical\n---\nVera Example care note.\n"),
            "atlas/patterns/press.md": (
                "---\nid: pattern:press\ntype: pattern\n"
                "title: Press (Vera Example)\nconcept_edges:\n"
                "  - to: zone:shoulder\n    role: loads\n---\n"),
        }) as directory:
            root = Path(directory)
            output = root / "graph" / "atlas-graph.json"
            options = ("--as-of", "2026-01-15")
            code, _, stderr = self._run_main(
                root / "atlas", output, *options)
            self.assertEqual(0, code, stderr)
            original_full = output.read_bytes()

            code, _, stderr = self._run_main(
                root / "atlas", output, "--redact", *options)
            self.assertEqual(0, code, stderr)
            redacted_output = output.with_name("atlas-graph.redacted.json")
            first_redacted = redacted_output.read_bytes()
            self.assertEqual(original_full, output.read_bytes())

            full = json.loads(output.read_text(encoding="utf-8"))
            redacted = json.loads(
                redacted_output.read_text(encoding="utf-8"))
            self.assertNotIn("withheld", full)
            self.assertIn("zone:shoulder",
                          {node["id"] for node in full["nodes"]})
            self.assertNotIn("zone:shoulder",
                             {node["id"] for node in redacted["nodes"]})
            self.assertEqual(1, len(full["edges"]))
            self.assertEqual([], redacted["edges"])
            self.assertEqual("shoulder",
                             full["projections"]["zone:shoulder"])
            self.assertNotIn("zone:shoulder", redacted["projections"])
            self.assertEqual({
                "nodes": 1, "edges": 1, "trails": 0, "state": 0,
                "influence": 0, "frontier": 0, "projections": 1,
            }, redacted["withheld"])

            # Mirror test_built_graph_validates_against_schema: validate the
            # two emissions as persisted graph artifacts, independently of
            # the fixture's curated-file schemas.
            validation_root = root / "validation"
            validation_graph = validation_root / "graph"
            validation_graph.mkdir(parents=True)
            (validation_graph / output.name).write_bytes(output.read_bytes())
            (validation_graph / redacted_output.name).write_bytes(
                redacted_output.read_bytes())
            stdout = io.StringIO()
            validation_stderr = io.StringIO()
            with (contextlib.redirect_stdout(stdout),
                  contextlib.redirect_stderr(validation_stderr)):
                validation_code = validate_atlas.main(
                    ["validate", str(validation_root)])
            self.assertEqual(0, validation_code,
                             validation_stderr.getvalue())

            code, _, stderr = self._run_main(
                root / "atlas", output, "--redact", *options)
            self.assertEqual(0, code, stderr)
            self.assertEqual(original_full, output.read_bytes())
            self.assertEqual(first_redacted, redacted_output.read_bytes())
            self.assertEqual([], list(output.parent.glob("*.tmp")))

    def test_redaction_drops_edges_carrying_a_classed_id_in_metadata(self):
        # §32.6: an edge names ids beyond its endpoints — provenance,
        # context (a route id), step (a concept id). A classed concept
        # surviving as material_roles step metadata would leak its id into
        # the agent-facing graph.
        concept = (_CONCEPT % ("c", "C")).replace(
            "title: C (Vera Example)\n",
            "title: C (Vera Example)\nsensitivity: medical\n")
        route = ("---\nid: suggested-route:r\ntype: suggested_route\n"
                 "title: R (Vera Example)\nstatus: available\nsteps:\n"
                 "  - concept:c\nmaterial_roles:\n  - step: concept:c\n"
                 "    primary_materials:\n      - material:m\n---\n")
        with _materialize({
            "concepts/c.md": concept,
            "materials/m.md": _MATERIAL % ("m", "M"),
            "suggested-routes/r.md": route,
        }) as directory:
            graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        redacted = build_atlas_graph._redact_graph(graph)
        for edge in redacted["edges"]:
            self.assertNotIn(
                "concept:c",
                {edge["source"], edge["target"], edge.get("context"),
                 edge.get("step"), *edge["provenance"]})

    def test_redaction_drops_edges_citing_a_classed_id_in_free_text(self):
        # §32.6: edge free-text metadata gets the same taint rule as node
        # payloads — a supports note mentioning a classed id would leak it
        # into the agent-facing graph even though every id the edge carries
        # (endpoints, provenance) is retained.
        classed = (_CONCEPT % ("x", "X")).replace(
            "title: X (Vera Example)\n",
            "title: X (Vera Example)\nsensitivity: medical\n")
        supported = ("---\nid: material:m2\ntype: material\n"
                     "title: M2 (Vera Example)\nkind: docs\nurl: \"\"\n"
                     "status: active\noverall_concepts:\n  - concept:c\n"
                     "supported_by:\n  - id: material:m\n"
                     "    note: pairs well, but see concept:x first\n"
                     "parts: []\n---\n")
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "concepts/x.md": classed,
            "materials/m.md": _MATERIAL % ("m", "M"),
            "materials/m2.md": supported,
        }) as directory:
            graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertTrue(any(edge["type"] == "supports"
                            for edge in graph["edges"]))
        redacted = build_atlas_graph._redact_graph(graph)
        self.assertNotIn("concept:x", json.dumps(redacted))
        self.assertFalse(any(edge["type"] == "supports"
                             for edge in redacted["edges"]))
        # The mentioning nodes themselves are clean and stay.
        self.assertLessEqual(
            {"material:m", "material:m2", "concept:c"},
            {node["id"] for node in redacted["nodes"]})

    def test_redaction_closes_over_payload_citations(self):
        # §32.6: taint unions through citation — an unclassed encounter
        # whose context cites a classed artifact rests on classed data;
        # retaining it would leak the artifact's id through the payload.
        artifact = json.loads(_ARTIFACT_ROW)
        artifact["sensitivity"] = "medical"
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "materials/m.md": _MATERIAL % ("m", "M"),
            "state/artifacts.jsonl": json.dumps(artifact) + "\n",
            "state/encounters.jsonl": _encounter_row(
                context={"artifact": "artifact:2026-07-16-001"}) + "\n",
        }) as directory:
            graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        redacted = build_atlas_graph._redact_graph(graph)
        ids = {node["id"] for node in redacted["nodes"]}
        self.assertNotIn("artifact:2026-07-16-001", ids)
        self.assertNotIn("encounter:2026-07-16-001", ids)
        self.assertEqual(2, redacted["withheld"]["nodes"])
        payload = json.dumps(redacted)
        self.assertNotIn("artifact:2026-07-16-001", payload)

    def test_redaction_taints_free_text_mentions(self):
        # §32.6: a marked id embedded in surviving free text is the same
        # leak as a reference field — the mentioning node leaves whole.
        artifact = json.loads(_ARTIFACT_ROW)
        artifact["sensitivity"] = "medical"
        mentioning = json.loads(_ARTIFACT_ROW)
        mentioning["id"] = "artifact:2026-07-17-001"
        mentioning["observed_at"] = "2026-07-17"
        mentioning["summary"] = ("s (Vera Example), see "
                                 "artifact:2026-07-16-001 for details")
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/artifacts.jsonl": (json.dumps(artifact) + "\n"
                                      + json.dumps(mentioning) + "\n"),
        }) as directory:
            graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        redacted = build_atlas_graph._redact_graph(graph)
        self.assertNotIn("artifact:2026-07-16-001", json.dumps(redacted))
        self.assertNotIn("artifact:2026-07-17-001",
                         {node["id"] for node in redacted["nodes"]})

    def test_non_redact_run_removes_the_stale_redacted_variant(self):
        # §32.6: content classed after the agent-facing variant was emitted
        # must not keep leaking through the old file — a write run without
        # --redact removes the stale variant instead of leaving it beside a
        # fresher full graph.
        with _materialize({
            "atlas/concepts/c.md": _CONCEPT % ("c", "C"),
        }) as directory:
            root = Path(directory)
            output = root / "graph" / "atlas-graph.json"
            code, _, stderr = self._run_main(
                root / "atlas", output, "--redact")
            self.assertEqual(0, code, stderr)
            redacted_output = output.with_name("atlas-graph.redacted.json")
            self.assertTrue(redacted_output.exists())
            code, _, stderr = self._run_main(root / "atlas", output)
            self.assertEqual(0, code, stderr)
            self.assertFalse(redacted_output.exists())

    def test_check_and_redact_are_rejected_together(self):
        with tempfile.TemporaryDirectory() as directory:
            curated = Path(directory) / "atlas"
            curated.mkdir()
            output = Path(directory) / "graph" / "atlas-graph.json"
            code, _, stderr = self._run_main(
                curated, output, "--check", "--redact")
        self.assertEqual(2, code)
        self.assertIn("--check and --redact cannot be combined", stderr)
        self.assertFalse(output.exists())

    def test_explicit_as_of_skips_later_journal_row_with_report_count(self):
        # §20.1: the explicit anchor is an upper bound over every journal —
        # artifacts, encounters, and questions dated after it are skipped
        # and counted; a row on/before it is still read. Ids are dated
        # before the cutoff on purpose: the bound reads the row's dated
        # field, never a date embedded in the id.
        # The kept artifact sits exactly ON the anchor day: §20.1's bound is
        # inclusive (date ≤ as-of), a strict < must fail here.
        kept = json.loads(_ARTIFACT_ROW)
        kept["id"] = "artifact:2026-01-02-001"
        kept["observed_at"] = "2026-01-15"
        late = json.loads(_ARTIFACT_ROW)
        late["id"] = "artifact:2026-01-10-001"
        late["observed_at"] = "2026-01-16"
        # Kept encounter and question also sit ON the anchor day — the
        # inclusive bound holds per journal, not just for artifacts.
        kept_encounter = json.loads(_encounter_row())
        kept_encounter["id"] = "encounter:2026-01-02-001"
        kept_encounter["date"] = "2026-01-15"
        late_encounter = json.loads(_encounter_row())
        late_encounter["id"] = "encounter:2026-01-10-001"
        late_encounter["date"] = "2026-01-16"
        kept_question = json.loads(_QUESTION_ROW)
        kept_question["id"] = "question:kept"
        kept_question["created_at"] = "2026-01-15"
        kept_question["source"] = {"artifact": "artifact:2026-01-02-001"}
        late_question = json.loads(_QUESTION_ROW)
        late_question["id"] = "question:late"
        late_question["created_at"] = "2026-01-16"
        late_question["source"] = {"artifact": "artifact:2026-01-02-001"}
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "materials/m.md": _MATERIAL % ("m", "M"),
            "state/artifacts.jsonl": (json.dumps(kept) + "\n"
                                      + json.dumps(late) + "\n"),
            "state/encounters.jsonl": (json.dumps(kept_encounter) + "\n"
                                       + json.dumps(late_encounter) + "\n"),
            "state/questions.jsonl": (json.dumps(kept_question) + "\n"
                                      + json.dumps(late_question) + "\n"),
        }) as directory:
            output = Path(directory) / "graph" / "atlas-graph.json"
            code, _, stderr = self._run_main(
                directory, output, "--as-of", "2026-01-15")
            self.assertEqual(0, code, stderr)
            graph = json.loads(output.read_text(encoding="utf-8"))
        ids = {node["id"] for node in graph["nodes"]}
        # §20.1: in-window rows of EVERY journal are still read — node and
        # derived edge alike.
        self.assertLessEqual({"artifact:2026-01-02-001",
                              "encounter:2026-01-02-001",
                              "question:kept"}, ids)
        derived = {(edge["type"], edge["source"], edge["target"])
                   for edge in graph["edges"]}
        self.assertIn(("visited", "encounter:2026-01-02-001", "material:m"),
                      derived)
        self.assertIn(("pulled_by", "concept:c", "question:kept"), derived)
        self.assertIn(("influences", "artifact:2026-01-02-001", "concept:c"),
                      derived)
        skipped = {"artifact:2026-01-10-001", "encounter:2026-01-10-001",
                   "question:late"}
        self.assertEqual(set(), ids & skipped)
        # §20.3: journal-derived edges sit under the §20.1 bound too — a
        # skipped row leaves no edge endpoint and no provenance entry.
        for edge in graph["edges"]:
            self.assertEqual(set(), {edge["source"], edge["target"],
                                     *edge["provenance"]} & skipped)
        self.assertEqual("2026-01-15T00:00:00Z", graph["generated_at"])
        # §20.1: the report carries an aggregate count, not merely a
        # per-row note — pin the count phrase.
        self.assertRegex(stderr, r"skipped 3 dated input")
        self.assertIn("as-of 2026-01-15", stderr)

    def test_explicit_as_of_skips_later_trail_segment_with_report_count(self):
        # §20.1: trail segments share the journal's explicit upper bound
        # and skipped segments are counted in the build report.
        with _materialize({
            "concepts/a.md": _CONCEPT % ("a", "A"),
            "concepts/b.md": _CONCEPT % ("b", "B"),
            "directions/d.md": (
                "---\nid: direction:d\ntype: direction\n"
                "title: D (Vera Example)\nattractor: pull\n"
                "status: active\n---\n"),
            # Filename and id are dated before the cutoff on purpose: the
            # bound reads the parsed date field, never the filename or id.
            "trails/2026-01-10-001.md": (
                "---\nid: trail-segment:2026-01-10-001\n"
                "type: trail_segment\ntitle: \"\"\ndate: 2026-01-16\n"
                "direction: direction:d\nfrom: concept:a\nto: concept:b\n"
                "via: []\nreason: momentum (Vera Example)\n---\n"),
            # An in-window segment is still read — dated ON the anchor
            # day: the bound is inclusive for segments too (§20.1).
            "trails/2026-01-05-001.md": (
                "---\nid: trail-segment:2026-01-05-001\n"
                "type: trail_segment\ntitle: \"\"\ndate: 2026-01-15\n"
                "direction: direction:d\nfrom: concept:a\nto: concept:b\n"
                "via: []\nreason: momentum (Vera Example)\n---\n"),
        }) as directory:
            output = Path(directory) / "graph" / "atlas-graph.json"
            code, _, stderr = self._run_main(
                directory, output, "--as-of", "2026-01-15")
            self.assertEqual(0, code, stderr)
            graph = json.loads(output.read_text(encoding="utf-8"))
        ids = {node["id"] for node in graph["nodes"]}
        self.assertNotIn("trail-segment:2026-01-10-001", ids)
        self.assertIn("trail-segment:2026-01-05-001", ids)
        # §20.3: the kept segment still derives its movement edge.
        self.assertIn(
            ("moved_to", "concept:a", "concept:b"),
            {(edge["type"], edge["source"], edge["target"])
             for edge in graph["edges"]})
        # §20.3: a skipped segment derives nothing — no moved_to/via edge
        # endpoint and no provenance entry may cite it.
        for edge in graph["edges"]:
            self.assertNotIn("trail-segment:2026-01-10-001",
                             {edge["source"], edge["target"],
                              *edge["provenance"]})
        self.assertEqual("2026-01-15T00:00:00Z", graph["generated_at"])
        # §20.1: the aggregate skip count covers trail segments too.
        self.assertRegex(stderr, r"skipped 1 dated input")
        self.assertIn("as-of 2026-01-15", stderr)

    def test_explicit_as_of_stamps_empty_undated_input(self):
        # §20.1: an explicit anchor is emitted even when no dated input exists.
        with _materialize({"concepts/.keep": ""}) as directory:
            output = Path(directory) / "graph" / "atlas-graph.json"
            code, _, stderr = self._run_main(
                directory, output, "--as-of", "2026-01-15")
            self.assertEqual(0, code, stderr)
            graph = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual("2026-01-15T00:00:00Z", graph["generated_at"])

    def test_missing_input_root_preserves_previous_output(self):
        # §20.2/#60: input validation precedes output handling, so a missing
        # curated tree fails clearly without clobbering the last good graph.
        with tempfile.TemporaryDirectory() as directory:
            instance = Path(directory) / "instance"
            instance.mkdir()
            curated = instance / "atlas"
            output = instance / "graph" / "atlas-graph.json"
            output.parent.mkdir()
            previous = b'{"previous": "good"}\n'
            output.write_bytes(previous)
            code, _, stderr = self._run_main(curated, output)
            self.assertEqual(1, code)
            self.assertIn("ERROR:", stderr)
            self.assertIn(str(curated), stderr)
            self.assertEqual(previous, output.read_bytes())
            # Validation precedes output handling: no temp or other new
            # artifact may appear beside the previous graph.
            self.assertEqual([output], list(output.parent.iterdir()))

    def test_mis_mounted_input_root_preserves_previous_output(self):
        # §20.2/#60: a directory with none of the curated subdirectories is
        # not a valid input mount and must fail before touching the output.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            curated = root / "mis-mounted"
            (curated / "unexpected").mkdir(parents=True)
            (curated / "unexpected" / "file.md").write_text(
                "Vera Example\n", encoding="utf-8")
            output = root / "instance" / "graph" / "atlas-graph.json"
            output.parent.mkdir(parents=True)
            previous = b'{"previous": "good"}\n'
            output.write_bytes(previous)
            code, _, stderr = self._run_main(curated, output)
            self.assertEqual(1, code)
            self.assertIn("ERROR:", stderr)
            self.assertIn(str(curated), stderr)
            self.assertEqual(previous, output.read_bytes())
            # Validation precedes output handling: no temp or other new
            # artifact may appear beside the previous graph.
            self.assertEqual([output], list(output.parent.iterdir()))

    def test_empty_curated_root_still_builds(self):
        # §20.1: empty inputs still build — a fresh instance whose atlas/
        # exists with no domain subdirectories yet is not a mis-mount.
        with tempfile.TemporaryDirectory() as directory:
            instance = Path(directory) / "instance"
            curated = instance / "atlas"
            curated.mkdir(parents=True)
            output = instance / "graph" / "atlas-graph.json"
            code, _, stderr = self._run_main(curated, output)
            self.assertEqual(0, code, stderr)
            graph = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual([], graph["nodes"])
        self.assertNotIn("generated_at", graph)

    def test_mismatched_instance_roots_are_rejected(self):
        # §25.6: INSTANCE/atlas input with an output deriving a DIFFERENT
        # instance root would lock the wrong root and race a writer of the
        # instance actually being read — refused before the lock.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            curated = root / "instance" / "atlas"
            (curated / "concepts").mkdir(parents=True)
            other = root / "other"
            output = other / "graph" / "atlas-graph.json"
            code, _, stderr = self._run_main(curated, output)
            self.assertEqual(1, code)
            self.assertIn("ERROR:", stderr)
            self.assertIn("instance", stderr)
            self.assertFalse(other.exists())
            self.assertEqual([], list(root.rglob(".atlas-lock")))

    def test_missing_input_root_is_rejected_before_lock_acquisition(self):
        self._assert_invalid_root_rejected_before_lock(mis_mounted=False)

    def test_mis_mounted_input_root_is_rejected_before_lock_acquisition(self):
        self._assert_invalid_root_rejected_before_lock(mis_mounted=True)

    def _assert_invalid_root_rejected_before_lock(self, mis_mounted):
        # #60: validation precedes the output-derived instance lock; the
        # ordering is proven behaviorally — with the lock already held, an
        # invalid root must still be diagnosed as such, never as a lock
        # refusal — for a missing and a mis-mounted (wrong-shape) root alike.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            instance = root / "instance"
            instance.mkdir()
            curated = instance / "atlas"
            if mis_mounted:
                (curated / "unexpected").mkdir(parents=True)
                (curated / "unexpected" / "file.md").write_text(
                    "Vera Example\n", encoding="utf-8")
            output = instance / "graph" / "atlas-graph.json"
            held = b'{"pid": 1, "started_at": "2026-01-01T00:00:00Z"}\n'
            (instance / ".atlas-lock").write_bytes(held)
            real_open = build_atlas_graph.os.open
            with mock.patch.object(
                    build_atlas_graph.os, "open", wraps=real_open) as opened:
                code, _, stderr = self._run_main(curated, output)
            # The invalid-root diagnostic wins over the lock-held refusal,
            # and the holder's lock is left untouched.
            self.assertIn(str(curated), stderr)
            self.assertNotIn(".atlas-lock", stderr)
            self.assertEqual(held, (instance / ".atlas-lock").read_bytes())
            # Validation precedes output handling entirely: the absent
            # graph/ directory must not have been created on the way out.
            self.assertFalse((instance / "graph").exists())
            lock_attempts = [
                call.args[0] for call in opened.call_args_list
                if Path(call.args[0]).name == ".atlas-lock"
            ]
            self.assertEqual([], lock_attempts)
            self.assertEqual([instance / ".atlas-lock"],
                             list(root.rglob(".atlas-lock")))
            self.assertEqual(1, code)
            self.assertIn("ERROR:", stderr)

    def test_two_emitted_graphs_are_byte_identical(self):
        # §20.1: same inputs and same default as-of emit byte-identical JSON;
        # neither the graph nor its serialization leaks wall-clock time.
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/artifacts.jsonl": _ARTIFACT_ROW + "\n",
        }) as directory:
            root = Path(directory)
            first_instance = root / "first"
            second_instance = root / "second"
            first_instance.mkdir()
            second_instance.mkdir()
            first = first_instance / "graph" / "atlas-graph.json"
            second = second_instance / "graph" / "atlas-graph.json"
            first_code, _, first_stderr = self._run_main(
                directory, first)
            second_code, _, second_stderr = self._run_main(
                directory, second)
            self.assertEqual(0, first_code, first_stderr)
            self.assertEqual(0, second_code, second_stderr)
            # §20.1: the artifact's observed_at anchors the default as-of —
            # identical omission or mis-stamping must not pass as identity.
            graph = json.loads(first.read_text(encoding="utf-8"))
            self.assertEqual("2026-07-16T00:00:00Z", graph["generated_at"])
            self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_default_as_of_uses_max_journal_date_in_emitted_graph(self):
        # §20.1: without a flag, the max activity date across journal rows
        # AND trail segments anchors the persisted graph at UTC midnight —
        # the latest-dated input here is a trail segment, not a journal row.
        artifact = json.loads(_ARTIFACT_ROW)
        artifact["observed_at"] = "2026-01-14"
        encounter = json.loads(_encounter_row())
        encounter["date"] = "2026-01-16"
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "concepts/b.md": _CONCEPT % ("b", "B"),
            "materials/m.md": _MATERIAL % ("m", "M"),
            "directions/d.md": (
                "---\nid: direction:d\ntype: direction\n"
                "title: D (Vera Example)\nattractor: pull\n"
                "status: active\n---\n"),
            # Filename and id are dated earlier on purpose: the default
            # anchor reads the parsed date field, never the filename or id.
            "trails/2026-01-12-001.md": (
                "---\nid: trail-segment:2026-01-12-001\n"
                "type: trail_segment\ntitle: \"\"\ndate: 2026-01-18\n"
                "direction: direction:d\nfrom: concept:c\nto: concept:b\n"
                "via: []\nreason: momentum (Vera Example)\n---\n"),
            "state/artifacts.jsonl": json.dumps(artifact) + "\n",
            "state/encounters.jsonl": json.dumps(encounter) + "\n",
        }) as directory:
            output = Path(directory) / "graph" / "atlas-graph.json"
            code, _, stderr = self._run_main(directory, output)
            self.assertEqual(0, code, stderr)
            graph = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual("2026-01-18T00:00:00Z", graph["generated_at"])

    def test_default_as_of_uses_max_encounter_date_in_emitted_graph(self):
        # §20.1: every journal feeds the default anchor — here the latest
        # dated input is an encounter row, not an artifact or a segment.
        artifact = json.loads(_ARTIFACT_ROW)
        artifact["observed_at"] = "2026-01-14"
        encounter = json.loads(_encounter_row())
        encounter["date"] = "2026-01-16"
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "materials/m.md": _MATERIAL % ("m", "M"),
            "state/artifacts.jsonl": json.dumps(artifact) + "\n",
            "state/encounters.jsonl": json.dumps(encounter) + "\n",
        }) as directory:
            output = Path(directory) / "graph" / "atlas-graph.json"
            code, _, stderr = self._run_main(directory, output)
            self.assertEqual(0, code, stderr)
            graph = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual("2026-01-16T00:00:00Z", graph["generated_at"])

    def test_failed_final_rename_preserves_previous_output(self):
        # §20.2: emission uses a same-directory temp plus atomic rename, so
        # a failure at the final rename cannot damage the last good graph —
        # and §25.8 requires the failure be reported as exit 1 with an
        # ERROR: diagnostic, never an uncaught traceback.
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
        }) as directory:
            output = Path(directory) / "graph" / "atlas-graph.json"
            output.parent.mkdir()
            previous = b'{"previous": "good"}\n'
            output.write_bytes(previous)
            # API-neutral failure injection: every stdlib primitive a
            # same-directory atomic handoff can use is patched (pathlib
            # binds its accessor at class creation on some versions, so
            # the Path methods are patched alongside the os ones).
            fail = OSError("rename failed")
            with (
                mock.patch.object(build_atlas_graph.os, "replace",
                                  side_effect=fail),
                mock.patch.object(build_atlas_graph.os, "rename",
                                  side_effect=fail),
                mock.patch.object(Path, "replace", side_effect=fail),
                mock.patch.object(Path, "rename", side_effect=fail),
            ):
                code, _, stderr = self._run_main(directory, output)
            self.assertEqual(1, code)
            self.assertIn("ERROR:", stderr)
            self.assertEqual(previous, output.read_bytes())

    def test_journal_ref_resolves_through_formerly(self):
        # §34.4: stale journal payload refs — an encounter target, artifact
        # touches, question pulls — and their derived edges resolve together
        # to the living id and are reported as stale references.
        material = (_MATERIAL % ("new", "New")).replace(
            "status: active\n",
            "status: active\nformerly:\n  - material:old\n")
        concept = (_CONCEPT % ("c", "C")).replace(
            "title: C (Vera Example)\n",
            "title: C (Vera Example)\nformerly:\n  - concept:old-c\n")
        artifact = json.loads(_ARTIFACT_ROW)
        artifact["touches"] = ["concept:old-c"]
        question = json.loads(_QUESTION_ROW)
        question["pulls"] = ["concept:old-c"]
        with _materialize({
            "concepts/c.md": concept,
            "materials/new.md": material,
            "state/encounters.jsonl": _encounter_row(
                target="material:old") + "\n",
            "state/artifacts.jsonl": json.dumps(artifact) + "\n",
            "state/questions.jsonl": json.dumps(question) + "\n",
        }) as directory:
            graph, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        encounter = next(node for node in graph["nodes"]
                         if node["type"] == "encounter")
        self.assertEqual("material:new", encounter["target"])
        # §10.4: the cached field-derivation refs resolve too — a renamed
        # ref must not silently cost a journal node its field membership.
        self.assertEqual(["knowledge"], encounter["fields"])
        by_id = {node["id"]: node for node in graph["nodes"]}
        self.assertEqual(["knowledge"],
                         by_id["artifact:2026-07-16-001"]["fields"])
        self.assertEqual(["knowledge"], by_id["question:q"]["fields"])
        derived = {(edge["type"], edge["source"], edge["target"])
                   for edge in graph["edges"]}
        self.assertIn(("visited", "encounter:2026-07-16-001",
                       "material:new"), derived)
        self.assertIn(("influences", "artifact:2026-07-16-001",
                       "concept:c"), derived)
        self.assertIn(("pulled_by", "concept:c", "question:q"), derived)
        # No 'curated' pin: the refs live in journal rows — §34.4 requires
        # the stale resolutions to be reported, not a curated-origin label.
        for old, new in (("material:old", "material:new"),
                         ("concept:old-c", "concept:c")):
            self.assertTrue(
                any(old in warning and new in warning
                    and "§34.4" in warning for warning in warnings),
                (old, warnings),
            )


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
            # §9.9: the via artifact co-touches the origin — the movement
            # is evidenced by the segment's own context.
            "state/artifacts.jsonl": _ARTIFACT_ROW.replace(
                '"touches": ["concept:c"]',
                '"touches": ["concept:a", "concept:c"]') + "\n",
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
            any("is not a artifact/material/part id" in e
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

    def test_bare_prefix_payload_ref_fails_the_build(self):
        # §10.1/§25.8: a bare prefix word is not an id — the full
        # canonical shape gates the payload, never just the prefix.
        with _materialize({
            "state/encounters.jsonl": _encounter_row(
                target="material") + "\n",
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("target 'material' is not a material/part id" in e
                for e in errors), errors)

    def test_dangling_question_source_warns(self):
        # §20 step 11/§34.2: a retained question citing a deleted
        # artifact keeps the payload ref, warns, and never fails.
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/questions.jsonl": _QUESTION_ROW.replace(
                "artifact:2026-07-16-001", "artifact:missing") + "\n",
        }) as directory:
            graph, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertTrue(
            any("artifact:missing missing" in w for w in warnings), warnings)
        question = next(n for n in graph["nodes"]
                        if n["type"] == "question")
        self.assertEqual({"artifact": "artifact:missing"},
                         question["source"])

    def test_null_journal_value_fails_the_build(self):
        # §25.7: no journal schema admits null — an explicit null must
        # fail closed, never collapse to an absent optional field.
        row = json.loads(_ARTIFACT_ROW)
        row["intake"] = None
        row["probe"] = None
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/artifacts.jsonl": json.dumps(row) + "\n",
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("null journal value(s) for intake, probe (§25.7)" in e
                for e in errors), errors)

    def test_malformed_intake_key_fails_the_build(self):
        # §25.7/§33.2: a present-but-malformed intake provenance fails
        # closed; a well-formed one projects cleanly.
        bad = json.loads(_ARTIFACT_ROW)
        bad["intake"] = {}
        good = json.loads(_QUESTION_ROW)
        good["intake"] = "batch-1/entry-2#3"
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/artifacts.jsonl": json.dumps(bad) + "\n",
            "state/questions.jsonl": json.dumps(good) + "\n",
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("intake {} is not an intake key (§33.2)" in e
                for e in errors), errors)
        self.assertEqual([], [e for e in errors if "question" in e])

    def test_empty_from_landing_dangling_to_warns(self):
        # §9.9 allows from: [] (a landing) — no moved_to edge carries to,
        # so a deleted destination must still warn (§20 step 11).
        with _materialize({
            "concepts/a.md": _CONCEPT % ("a", "A"),
            "directions/d.md": (
                "---\nid: direction:d\ntype: direction\n"
                "title: D (Vera Example)\nattractor: pull\n"
                "status: active\n---\n"),
            "trails/2026-07-16-001.md": (
                "---\nid: trail-segment:2026-07-16-001\n"
                "type: trail_segment\ntitle: \"\"\ndate: 2026-07-16\n"
                "direction: direction:d\nfrom: []\nto: concept:gone\n"
                "via: []\nreason: momentum (Vera Example)\n---\n"),
        }) as directory:
            _, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertTrue(
            any("concept:gone missing" in w for w in warnings), warnings)

    def test_off_region_journal_ref_fails_the_build(self):
        # §9.6/§9.8: touches and pulls hold region ids (concept/pattern/
        # zone) — an off-kind ref fails closed, never a lenient drop that
        # loses evidence.
        artifact = _ARTIFACT_ROW.replace('"touches": ["concept:c"]',
                                         '"touches": ["material:m"]')
        question = _QUESTION_ROW.replace('"pulls": ["concept:c"]',
                                         '"pulls": ["material:m"]')
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "materials/m.md": _MATERIAL % ("m", "M"),
            "state/artifacts.jsonl": artifact + "\n",
            "state/questions.jsonl": question + "\n",
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("touches 'material:m' is not a concept/pattern/zone id"
                in e for e in errors), errors)
        self.assertTrue(
            any("pulls 'material:m' is not a concept/pattern/zone id"
                in e for e in errors), errors)

    def test_unknown_journal_key_fails_the_build(self):
        # §25.7: the journal schemas close their key sets — a typo like
        # sensitivty must fail, never silently drop a privacy marking.
        row = json.loads(_ARTIFACT_ROW)
        row["sensitivty"] = "medical"
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/artifacts.jsonl": json.dumps(row) + "\n",
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("unknown journal key(s) sensitivty (§25.7)" in e
                for e in errors), errors)

    def test_oversize_journal_row_fails_the_build(self):
        # §25.8: the boundary reader enforces a 16,384-byte row ceiling —
        # the builder discards that row without buffering its remainder,
        # then resumes at the following LF and projects the later row.
        row = json.loads(_ARTIFACT_ROW)
        row["summary"] = "s (Vera Example) " + "x" * 65536
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/artifacts.jsonl": (json.dumps(row) + "\n"
                                      + _ARTIFACT_ROW + "\n"),
        }) as directory:
            graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertEqual(1, sum("journal row exceeds 16384 bytes" in error
                                for error in errors), errors)
        self.assertIn("artifact:2026-07-16-001",
                      {node["id"] for node in graph["nodes"]})

    def test_multichunk_journal_row_projects_unchanged(self):
        # SEC-14: a legal row spanning read chunks is decoded exactly once
        # with its payload unchanged.
        row = json.loads(_ARTIFACT_ROW)
        row["summary"] = "Vera Example " + "x" * 10000
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/artifacts.jsonl": json.dumps(row) + "\n",
        }) as directory:
            graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        artifact = next(node for node in graph["nodes"]
                        if node["id"] == row["id"])
        self.assertEqual(row["summary"], artifact["summary"])

    def test_question_row_requires_question_type(self):
        # §9.8: type: "question" is the schema's fixed discriminant.
        row = json.loads(_QUESTION_ROW)
        row["type"] = "note"
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/questions.jsonl": json.dumps(row) + "\n",
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any('question row requires type "question"' in e
                for e in errors), errors)

    def test_crlf_journal_row_fails_the_build(self):
        # §25.7: the builder reads the journal as strictly as the
        # boundary — CR/CRLF never projects.
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/artifacts.jsonl": _ARTIFACT_ROW + "\r\n",
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("CR/CRLF is unsupported; use LF" in e for e in errors),
            errors)

    def test_duplicate_json_key_journal_row_fails_the_build(self):
        # §25.7/§25.8: duplicate keys silently keep-last under a bare
        # json.loads — they must fail like the boundary reader.
        row = _ARTIFACT_ROW[:-1] + ', "touches": ["concept:c"]}'
        with _materialize({
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "state/artifacts.jsonl": row + "\n",
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("duplicate JSON key 'touches'" in e for e in errors),
            errors)

    def test_dangling_destination_without_from_warns(self):
        # §20 step 11: a segment with no from derives no moved_to, so a
        # deleted destination is payload-only — it warns, never fails.
        with _materialize({
            "concepts/a.md": _CONCEPT % ("a", "A"),
            "directions/d.md": (
                "---\nid: direction:d\ntype: direction\n"
                "title: D (Vera Example)\nattractor: pull\n"
                "status: active\n---\n"),
            "trails/2026-07-16-001.md": (
                "---\nid: trail-segment:2026-07-16-001\n"
                "type: trail_segment\ntitle: \"\"\ndate: 2026-07-16\n"
                "direction: direction:d\nto: concept:gone\nvia: []\n"
                "reason: momentum (Vera Example)\n---\n"),
        }) as directory:
            _, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertTrue(
            any("concept:gone missing" in w for w in warnings), warnings)

    def test_unevidenced_trail_origin_warns(self):
        # §9.9/§13.2 step 9: every listed origin must be evidenced by the
        # segment's own via context — a from with no artifact evidence is
        # a proposed correction (warning), never a build failure (§5.2).
        with _materialize({
            "concepts/a.md": _CONCEPT % ("a", "A"),
            "concepts/b.md": _CONCEPT % ("b", "B"),
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "materials/m.md": _MATERIAL % ("m", "M"),
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
            graph, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertTrue(
            any("from concept:a is not evidenced" in w for w in warnings),
            warnings)
        # The trail stays sacred: the segment and its edges still emit.
        self.assertEqual(1, len(self._edges(graph, "moved_to")))

    def test_question_pull_evidences_trail_origin(self):
        # §9.9's second clause: the origin is the concept whose question
        # the via artifact answers — pulled by a question sourced from it.
        row = _ARTIFACT_ROW.replace('"touches": ["concept:c"]',
                                    '"touches": []')
        question = _QUESTION_ROW.replace('"pulls": ["concept:c"]',
                                         '"pulls": ["concept:a"]')
        with _materialize({
            "concepts/a.md": _CONCEPT % ("a", "A"),
            "concepts/b.md": _CONCEPT % ("b", "B"),
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "directions/d.md": (
                "---\nid: direction:d\ntype: direction\n"
                "title: D (Vera Example)\nattractor: pull\n"
                "status: active\n---\n"),
            "trails/2026-07-16-001.md": (
                "---\nid: trail-segment:2026-07-16-001\n"
                "type: trail_segment\ntitle: \"\"\ndate: 2026-07-16\n"
                "direction: direction:d\nfrom: concept:a\nto: concept:b\n"
                "via:\n  - artifact:2026-07-16-001\n"
                "reason: momentum (Vera Example)\n---\n"),
            "state/artifacts.jsonl": row + "\n",
            "state/questions.jsonl": question + "\n",
        }) as directory:
            _, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertEqual([], [w for w in warnings if "not evidenced" in w])

    def test_deleted_via_evidence_stays_quiet(self):
        # §34.2: when a via artifact was deleted the origin is
        # unverifiable — retained history keeps its dangling warning but
        # never gains an unevidenced-origin complaint.
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
                "via:\n  - artifact:2026-07-15-009\n"
                "reason: momentum (Vera Example)\n---\n"),
        }) as directory:
            _, errors, warnings = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        self.assertEqual([], [w for w in warnings if "not evidenced" in w])

    def test_artifact_row_requires_relation_arrays(self):
        # §9.6: touches and supports_state_updates are required — an
        # absent array is a malformed row, never an artifact silently
        # projected as touching nothing.
        row = json.loads(_ARTIFACT_ROW)
        del row["touches"], row["supports_state_updates"]
        with _materialize({
            "state/artifacts.jsonl": json.dumps(row) + "\n",
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("artifact row requires touches (§9.6)" in e
                for e in errors), errors)
        self.assertTrue(
            any("artifact row requires supports_state_updates (§9.6)" in e
                for e in errors), errors)

    def test_question_row_requires_pulls(self):
        # §9.8: pulls is required — a question that pulls nothing is a
        # malformed row, not an empty-field node.
        row = json.loads(_QUESTION_ROW)
        del row["pulls"]
        with _materialize({
            "state/questions.jsonl": json.dumps(row) + "\n",
        }) as directory:
            _, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertTrue(
            any("question row requires pulls (§9.8)" in e for e in errors),
            errors)

    def test_classed_material_part_taints_via_segment(self):
        # §32.6: taint is union by provenance — a part of a classed
        # material carries the class, and a segment citing it via the
        # part unions it in.
        material = (_MATERIAL % ("m", "M")).replace(
            "status: active\n", "status: active\nsensitivity: medical\n"
        ).replace(
            "parts: []\n",
            "parts:\n  - id: part:m/p\n    title: P (Vera Example)\n")
        with _materialize({
            "concepts/a.md": _CONCEPT % ("a", "A"),
            "concepts/b.md": _CONCEPT % ("b", "B"),
            "concepts/c.md": _CONCEPT % ("c", "C"),
            "materials/m.md": material,
            "directions/d.md": (
                "---\nid: direction:d\ntype: direction\n"
                "title: D (Vera Example)\nattractor: pull\n"
                "status: active\n---\n"),
            "trails/2026-07-16-001.md": (
                "---\nid: trail-segment:2026-07-16-001\n"
                "type: trail_segment\ntitle: \"\"\ndate: 2026-07-16\n"
                "direction: direction:d\nfrom: []\nto: concept:b\n"
                "via:\n  - part:m/p\n"
                "reason: momentum (Vera Example)\n---\n"),
        }) as directory:
            graph, errors, _ = build_atlas_graph.build(Path(directory))
        self.assertEqual([], errors)
        part = next(n for n in graph["nodes"]
                    if n["type"] == "material_part")
        self.assertEqual("medical", part["sensitivity"])
        segment = next(n for n in graph["nodes"]
                       if n["type"] == "trail_segment")
        self.assertEqual("medical", segment["sensitivity"])

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
