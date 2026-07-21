import json
import re
import unittest
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VIEWER = ROOT / "viewer"
CONTRACT = VIEWER / "contract.js"
SCHEMA = ROOT / "spec" / "schemas" / "atlas-graph.schema.json"
NFR = ROOT / "spec" / "25-non-functional-requirements.md"


def json_constant(source: str, name: str):
    match = re.search(
        rf"export const {re.escape(name)} = (\{{.*?\}}|\[.*?\]);",
        source,
        re.DOTALL,
    )
    if not match:
        raise AssertionError(f"missing canonical JSON constant {name}")
    return json.loads(match.group(1))


class MetaParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.metas = []
        self.scripts = []
        self.styles = []
        self.links = []
        self.event_attributes = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "meta":
            self.metas.append(attributes)
        if tag == "script":
            self.scripts.append(attributes)
        if tag == "style":
            self.styles.append(attributes)
        if tag == "link":
            self.links.append(attributes)
        self.event_attributes.extend(
            name for name, _ in attrs if name.lower().startswith("on"))


class ViewerContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = CONTRACT.read_text(encoding="utf-8")
        cls.schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
        cls.defs = cls.schema["$defs"]

    def test_acceptance_ceilings_transcribe_section_25_8(self):
        text = NFR.read_text(encoding="utf-8")
        block = re.search(
            r"Viewer acceptance ceilings.*?Foreign-input acceptance ceilings",
            text,
            re.DOTALL,
        )
        self.assertIsNotNone(block)
        ceiling_text = block.group(0)

        def number(pattern):
            match = re.search(pattern, ceiling_text)
            self.assertIsNotNone(match, pattern)
            return int(match.group(1).replace(",", ""))

        expected = {
            "graph_file_bytes": number(r"graph file\s*\n?\s*≤\s*([0-9,]+) bytes"),
            "graph_nodes": number(r"bytes,\s*≤\s*([0-9,]+) nodes"),
            "graph_edges": number(r"nodes,\s*≤\s*([0-9,]+) edges"),
            "fragment_raw_bytes": number(r"raw fragment\s*≤\s*([0-9,]+) bytes"),
            "parameter_decoded_bytes": number(r"decoded parameter value\s*\n?\s*≤\s*([0-9,]+) bytes"),
        }
        self.assertEqual(expected, json_constant(self.source, "CEILINGS"))

    def test_closed_keys_and_enums_transcribe_schema(self):
        comparisons = {
            "ENVELOPE_KEYS": list(self.schema["properties"]),
            "NODE_KEYS": list(self.defs["node"]["properties"]),
            "EDGE_KEYS": list(self.defs["edge"]["properties"]),
            "NODE_TYPES": self.defs["nodeType"]["enum"],
            "EDGE_TYPES": self.defs["edgeType"]["enum"],
            "AUTHORED_ROLES": self.defs["authoredRole"]["enum"],
            "FIELDS": self.defs["field"]["enum"],
            "MATERIAL_KINDS": self.defs["materialKind"]["enum"],
            "EVIDENCE_STRENGTHS": self.defs["evidenceStrength"]["enum"],
            "ENCOUNTER_DEPTHS": self.defs["encounterDepth"]["enum"],
            "ENCOUNTER_MODES": self.defs["node"]["properties"]["mode"]["enum"],
            "SENSITIVITY_CLASSES": self.defs["node"]["properties"]["sensitivity"]["enum"],
            "EDGE_WEIGHTS": self.defs["emittedEdgeWeight"]["enum"],
            "CONFIDENCE_VALUES": self.defs["edge"]["properties"]["confidence"]["enum"],
            "LIFECYCLE_STATUSES": self.defs["lifecycleStatus"]["enum"],
            "ROUTE_STATUSES": self.defs["routeStatus"]["enum"],
        }
        for constant, expected in comparisons.items():
            with self.subTest(constant=constant):
                self.assertEqual(expected, json_constant(self.source, constant))

        prefixes = {
            name: definition["const"]
            for name, definition in self.defs["idPrefixes"]["properties"].items()
        }
        self.assertEqual(prefixes, json_constant(self.source, "ID_PREFIXES"))

    def test_endpoint_rules_transcribe_schema(self):
        expected = {}
        properties = self.defs["endpointRules"]["properties"]
        for edge_type, reference in properties.items():
            endpoint_name = reference["$ref"].rsplit("/", 1)[1]
            endpoint = self.defs[endpoint_name]["properties"]
            expected[edge_type] = [
                endpoint["source"]["enum"],
                endpoint["target"]["enum"],
            ]
        self.assertEqual(expected, json_constant(self.source, "ENDPOINT_RULES"))

    def test_index_carries_exact_csp_and_referrer_policy(self):
        parser = MetaParser()
        parser.feed((VIEWER / "index.html").read_text(encoding="utf-8"))
        csp = [
            meta.get("content") for meta in parser.metas
            if meta.get("http-equiv") == "Content-Security-Policy"
        ]
        self.assertEqual([
            "default-src 'none'; script-src 'self'; style-src 'self'; "
            "connect-src 'self'; img-src 'self'; object-src 'none'; "
            "base-uri 'none'; form-action 'none'"
        ], csp)
        referrer = [
            meta.get("content") for meta in parser.metas
            if meta.get("name") == "referrer"
        ]
        self.assertEqual(["no-referrer"], referrer)
        self.assertEqual(
            [{"type": "module", "src": "./viewer.js"}], parser.scripts)
        self.assertEqual([
            {"rel": "icon", "href": "./favicon.svg", "type": "image/svg+xml"},
            {"rel": "stylesheet", "href": "./viewer.css"},
        ], parser.links)
        self.assertEqual([], parser.styles)
        self.assertEqual([], parser.event_attributes)

    def test_viewer_sources_keep_the_render_and_network_floor(self):
        external_literal = re.compile(r"https?://[^\s\"']+")
        for path in sorted(VIEWER.iterdir()):
            if not path.is_file():
                continue
            source = path.read_text(encoding="utf-8")
            network_source = source.replace(
                'xmlns="http://www.w3.org/2000/svg"', "")
            with self.subTest(path=path.name):
                self.assertNotIn("inner" + "HTML", source)
                self.assertNotIn("http" + "://", network_source)
                self.assertIsNone(external_literal.search(network_source))


if __name__ == "__main__":
    unittest.main()
