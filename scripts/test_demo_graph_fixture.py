import json
import shutil
import tempfile
import unittest
from pathlib import Path

import validate_atlas


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "fixtures" / "demo-graph" / "atlas-graph.json"
VIEWER_ACCEPTANCE = ROOT / "fixtures" / "viewer-acceptance"


def strict_json(raw: bytes):
    def reject_duplicate_keys(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"duplicate JSON key {key!r}")
            result[key] = value
        return result

    def reject_non_finite(name):
        raise ValueError(f"non-finite JSON number {name!r} is unsupported")

    return json.loads(
        raw.decode("utf-8"),
        object_pairs_hook=reject_duplicate_keys,
        parse_constant=reject_non_finite,
    )


class DemoGraphFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = FIXTURE.read_bytes()
        cls.text = cls.raw.decode("utf-8")
        cls.graph = strict_json(cls.raw)

    def test_real_validation_path_accepts_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "graph" / "atlas-graph.json"
            target.parent.mkdir()
            shutil.copyfile(FIXTURE, target)
            errors, _, _ = validate_atlas.validate_instance(Path(directory))
        self.assertEqual([], errors)

    def test_canonical_order_and_identity(self):
        nodes = self.graph["nodes"]
        node_ids = [node["id"] for node in nodes]
        self.assertEqual(sorted(node_ids), node_ids)
        self.assertEqual(len(node_ids), len(set(node_ids)))

        def edge_key(edge):
            return (
                edge["type"],
                edge["source"],
                edge["target"],
                edge.get("context", ""),
                edge.get("order", 0),
                edge.get("step", ""),
            )

        edges = self.graph["edges"]
        self.assertEqual(sorted(edges, key=edge_key), edges)
        for edge in edges:
            self.assertEqual(sorted(edge["provenance"]), edge["provenance"])

    def test_persisted_json_bytes_are_canonical(self):
        self.assertNotIn(b"\r", self.raw)
        self.assertTrue(self.raw.endswith(b"\n"))
        self.assertFalse(self.raw.endswith(b"\n\n"))
        self.assertIsInstance(self.graph, dict)
        self.assertIn("Vera Example", self.text)


class ViewerAcceptanceFixtureTests(unittest.TestCase):
    def test_persisted_json_bytes_are_canonical(self):
        fixtures = sorted(path for path in VIEWER_ACCEPTANCE.rglob("*")
                          if path.is_file())
        self.assertTrue(fixtures)
        for fixture in fixtures:
            with self.subTest(fixture=fixture.relative_to(VIEWER_ACCEPTANCE)):
                self.assertEqual(".json", fixture.suffix)
                raw = fixture.read_bytes()
                text = raw.decode("utf-8")
                graph = strict_json(raw)
                self.assertNotIn(b"\r", raw)
                self.assertTrue(raw.endswith(b"\n"))
                self.assertFalse(raw.endswith(b"\n\n"))
                self.assertIsInstance(graph, dict)
                self.assertIn("Vera Example", text)


if __name__ == "__main__":
    unittest.main()
