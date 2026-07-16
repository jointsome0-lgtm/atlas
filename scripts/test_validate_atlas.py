import contextlib
import io
import tempfile
import unittest
from pathlib import Path

import validate_atlas


ROOT = Path(__file__).resolve().parents[1]

# Instance trees are materialized into temp directories instead of being
# committed: .gitignore deliberately blocks instance-shaped paths (atlas/,
# state/, graph/, intake/, *.jsonl) anywhere in the public git layer.

VALID_CONCEPT = """---
id: concept:example
type: concept
title: Example
updated: 2026-07-16
aliases: []
related_concepts: []
concept_edges: []
---

Synthetic schema fixture authored by Vera Example.
"""

VALID_PLAN_EXTRACT = """id: plan:example
title: Example plan
directions: []
concepts: []
materials: []
material_parts: []
suggested_routes: []
probes: []
notes: []
"""

VALID_ARTIFACT_ROW = (
    '{"id":"artifact:2026-07-16-001","type":"note","path":"notes/example.md",'
    '"observed_at":"2026-07-16","summary":"Synthetic schema fixture.",'
    '"touches":["concept:example"],"supports_state_updates":[],'
    '"evidence_strength":"noticed"}\n'
)

VALID_EMPTY_GRAPH = """{
  "format": "atlas-graph",
  "version": 1,
  "nodes": [],
  "edges": [],
  "trails": [],
  "state": {},
  "influence": {},
  "frontier": [],
  "projections": {}
}
"""

VALID_INTAKE_BATCH = """{
  "format": "atlas-intake",
  "version": 1,
  "source": "watch-sync",
  "batch": "2026-07-16-001",
  "records": [
    {"kind": "question", "date": "2026-07-16", "text": "synthetic Vera Example question?"}
  ]
}
"""

VALID_REDACTED_GRAPH = VALID_EMPTY_GRAPH.replace(
    '"nodes": [],', '"withheld": {"nodes": 1},\n  "nodes": [],'
)

GRAPH_WITH_NODE = VALID_EMPTY_GRAPH.replace(
    '"nodes": [],',
    '"nodes": [{"id": "concept:example", "type": "%s", "title": "Example",'
    ' "fields": ["knowledge"], "aliases": []}],',
)

GRAPH_WITH_EDGE = VALID_EMPTY_GRAPH.replace(
    '"edges": [],',
    '"edges": [{"source": "concept:a", "target": "concept:b", "type": "loads",'
    ' "provenance": ["pattern:p"], "weight": "unassessed"}],',
)

VALID_MATERIAL = """---
id: material:example-docs
type: material
title: Example Docs (Vera Example)
kind: docs
url: ""
status: active
overall_concepts:
  - concept:example
parts:
  - id: part:example-docs/intro
    title: Intro
    formerly:
      - part:example-docs/old-intro
---
"""

VALID_INSTANCE = {
    "atlas/concepts/example.md": VALID_CONCEPT,
    "atlas/materials/example-docs.md": VALID_MATERIAL,
    "state/receipts.jsonl": (
        '{"intake":"watch-sync/2026-07-16-001#0","marker":"opened","date":"2026-07-16"}\n'
        '{"intake":"watch-sync/2026-07-16-001#0","marker":"processed","date":"2026-07-16"}\n'
    ),
    "plans/extracted/example.yaml": VALID_PLAN_EXTRACT,
    "state/artifacts.jsonl": VALID_ARTIFACT_ROW,
    "state/decisions.jsonl": (
        '{"date":"2026-07-16","target":"supports:part:b/y->part:a/x",'
        '"dimension":"weight","to":"high",'
        '"evidence":["artifact:2026-07-16-001"],'
        '"proposed_by":"user","decision":"confirmed"}\n'
    ),
    "intake/watch-sync/2026-07-16-002.json": VALID_INTAKE_BATCH.replace(
        "\n", "\r\n"
    ).replace('"2026-07-16-001"', '"2026-07-16-002"'),
    "graph/atlas-graph.json": GRAPH_WITH_NODE % "concept",
    "graph/atlas-graph.redacted.json": VALID_REDACTED_GRAPH,
    "intake/watch-sync/2026-07-16-001.json": VALID_INTAKE_BATCH,
}

INVALID_INSTANCES = {
    "bad-graph": {
        "graph/atlas-graph.json": VALID_EMPTY_GRAPH.replace('"version": 1', '"version": 2'),
    },
    "bad-journal": {
        "state/artifacts.jsonl": VALID_ARTIFACT_ROW.replace('"noticed"', '"mastered"'),
    },
    "unknown-curated": {
        "atlas/concepts/bad.md": "---\nid: concept:bad\ntype: concept\ntitle: Bad\nstray: rejected\n---\n",
    },
    "bad-id-trailing-newline": {
        "atlas/concepts/bad.md": (
            "---\nid: \"concept:bad\\n\"\ntype: concept\ntitle: Bad (Vera Example)\n"
            "aliases: []\n---\n"
        ),
    },
    "bad-graph-node-kind": {
        "graph/atlas-graph.json": GRAPH_WITH_NODE % "material",
    },
    "bad-graph-edge-endpoints": {
        "graph/atlas-graph.json": GRAPH_WITH_EDGE,
    },
    "bad-graph-withheld-on-full": {
        "graph/atlas-graph.json": VALID_REDACTED_GRAPH,
    },
    "bad-graph-redacted-without-withheld": {
        "graph/atlas-graph.redacted.json": VALID_EMPTY_GRAPH,
    },
    "bad-decision-weight-endpoints": {
        "state/decisions.jsonl": (
            '{"date":"2026-07-16","target":"loads:concept:a->concept:b",'
            '"dimension":"weight","to":"high",'
            '"evidence":["artifact:2026-07-16-001"],'
            '"proposed_by":"user","decision":"confirmed"}\n'
        ),
    },
    "bad-decision-weight-on-derived-edge": {
        "state/decisions.jsonl": (
            '{"date":"2026-07-16","target":"has_part:material:a->part:a/b",'
            '"dimension":"weight","to":"high",'
            '"evidence":["artifact:2026-07-16-001"],'
            '"proposed_by":"user","decision":"confirmed"}\n'
        ),
    },
    "bad-decision-status-target": {
        "state/decisions.jsonl": (
            '{"date":"2026-07-16","target":"concept:example","dimension":"status",'
            '"to":"open","evidence":["artifact:2026-07-16-001"],'
            '"proposed_by":"user","decision":"confirmed"}\n'
        ),
    },
    "bad-pattern-loads-target": {
        "atlas/patterns/bad.md": (
            "---\nid: pattern:bad\ntype: pattern\ntitle: Bad (Vera Example)\n"
            "concept_edges:\n  - to: concept:example\n    role: loads\n---\n"
        ),
    },
    "bad-receipt-intake-key": {
        "state/receipts.jsonl": (
            '{"intake":"-bad/also--bad#1","marker":"opened","date":"2026-07-16"}\n'
        ),
    },
    "bad-intake-path-mismatch": {
        "intake/right/file.json": VALID_INTAKE_BATCH.replace(
            '"watch-sync"', '"wrong"'
        ),
    },
    "bad-intake": {
        "intake/watch-sync/2026-07-16-002.json": VALID_INTAKE_BATCH.replace(
            '"atlas-intake"', '"wrong"'
        ),
    },
}


def materialize(tree: dict[str, str], root: Path) -> None:
    for relative, content in tree.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


class SchemaValidatorTests(unittest.TestCase):
    def run_cli(self, *args):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = validate_atlas.main(list(args))
        return code, stdout.getvalue(), stderr.getvalue()

    def test_registry_is_exact_and_supported(self):
        schemas, errors = validate_atlas._load_registry()
        self.assertEqual([], errors)
        self.assertEqual(validate_atlas.SCHEMA_NAMES, set(schemas))

    def test_unsupported_schema_keyword_fails_closed(self):
        with self.assertRaises(validate_atlas.SchemaSubsetError):
            validate_atlas.SchemaValidator({"type": "string", "format": "date"})

    def test_valid_instance(self):
        with tempfile.TemporaryDirectory() as directory:
            materialize(VALID_INSTANCE, Path(directory))
            code, stdout, stderr = self.run_cli("validate", directory)
        self.assertEqual(0, code, stderr)
        self.assertIn("2 intake batches", stdout)
        self.assertIn("0 errors", stdout)
        self.assertEqual("", stderr)

    def test_demo_instance(self):
        root = ROOT / "fixtures" / "demo-instance"
        code, stdout, stderr = self.run_cli("validate", str(root))
        self.assertEqual(0, code, stderr)
        self.assertIn("11 frontmatter documents", stdout)

    def test_each_negative_instance_emits_error(self):
        for name, tree in sorted(INVALID_INSTANCES.items()):
            with self.subTest(case=name):
                with tempfile.TemporaryDirectory() as directory:
                    materialize(tree, Path(directory))
                    code, stdout, stderr = self.run_cli("validate", directory)
                self.assertEqual(1, code)
                self.assertIn("ERROR:", stderr)
                self.assertIn("errors", stdout)
                self.assertTrue(
                    all(line.startswith("ERROR:") for line in stderr.splitlines())
                )

    def test_intake_schema_positive_and_negative_documents(self):
        schemas, errors = validate_atlas._load_registry()
        self.assertEqual([], errors)
        directory = ROOT / "fixtures" / "schema" / "documents"
        valid = validate_atlas._read_json(directory / "atlas-intake.valid.json")
        invalid = validate_atlas._read_json(directory / "atlas-intake.invalid.json")
        validator = validate_atlas.SchemaValidator(schemas["atlas-intake"])
        self.assertEqual([], validator.validate(valid))
        self.assertTrue(validator.validate(invalid))

    def test_check_constants(self):
        code, stdout, stderr = self.run_cli("check-constants")
        self.assertEqual(0, code, stderr)
        self.assertEqual("checked constants: 0 errors\n", stdout)

    def test_usage_exit_code_and_diagnostic(self):
        code, stdout, stderr = self.run_cli()
        self.assertEqual(2, code)
        self.assertEqual("", stdout)
        self.assertTrue(stderr.startswith("ERROR: usage:"))


if __name__ == "__main__":
    unittest.main()
