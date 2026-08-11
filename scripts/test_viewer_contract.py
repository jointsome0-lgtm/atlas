import json
import re
import unittest
from html.parser import HTMLParser
from pathlib import Path

import build_atlas_graph


ROOT = Path(__file__).resolve().parents[1]
VIEWER = ROOT / "viewer"
# The canon transcriptions live in the TypeScript source, not the generated
# viewer/contract.js: the transpiler reprints object literals with unquoted
# keys, and scripts/build_viewer.ts --check is what binds output to source.
CONTRACT = VIEWER / "src" / "contract.ts"
SCHEMA = ROOT / "spec" / "schemas" / "atlas-graph.schema.json"
NFR = ROOT / "spec" / "25-non-functional-requirements.md"
STATE_RULES = ROOT / "spec" / "14-state-update-rules.md"


def json_constant(source: str, name: str):
    match = re.search(
        rf"export const {re.escape(name)}(?:\s*:[^=]+)? = (\{{.*?\}}|\[.*?\]);",
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

    def test_freshness_boundaries_transcribe_section_14_7(self):
        """§14.7 owns the numbers; the fold and the viewer each transcribe
        them (#108). Neither copy is canon, so checking them against each
        other would let a matched pair drift away from the § together —
        both are read against the prose instead. Tuning is a version bump
        in canon, which starts here and fails both transcriptions at once."""
        block = re.search(
            r"## §14\.7 Freshness Decay.*?```text\n(.*?)```",
            STATE_RULES.read_text(encoding="utf-8"),
            re.DOTALL,
        )
        self.assertIsNotNone(block)
        # Every line is consumed and every class named once: a block that
        # grew a fourth boundary, lost one, or repeated a class must not
        # reach the comparison below with three lucky matches. A regex that
        # merely finds what it expects would agree with a canon that had
        # stopped being a partition.
        lines = [line for line in block.group(1).splitlines() if line.strip()]
        parsed = [
            re.fullmatch(r"(fresh|aging|stale)\s+([≤>]) (\d+) days", line)
            for line in lines
        ]
        self.assertNotIn(None, parsed, lines)
        self.assertEqual(
            [("fresh", "≤"), ("aging", "≤"), ("stale", ">")],
            [(m.group(1), m.group(2)) for m in parsed],
        )
        # Names, not values: pinning the numbers here would be a third copy
        # of what the § is supposed to own. This only proves the prose was
        # actually read, so an unparsed block cannot pass as agreement.
        fresh, aging, stale = (int(m.group(3)) for m in parsed)
        # The three lines are one partition, so `stale` opens where `aging`
        # closes. Nothing outside the § can catch a tuning that moved one
        # line and not the other — both transcriptions would faithfully copy
        # a canon that had stopped covering the days between them.
        self.assertEqual(aging, stale)
        self.assertLess(fresh, aging)
        boundaries = {"fresh": fresh, "aging": aging}
        self.assertEqual(boundaries, json_constant(self.source, "FRESHNESS_DAYS"))
        self.assertEqual(boundaries, build_atlas_graph.FRESHNESS_DAYS)

    def test_closed_keys_and_enums_transcribe_schema(self):
        state_shapes = self.schema["properties"]["state"][
            "additionalProperties"]["oneOf"]
        concept_state = state_shapes[0]["properties"]
        material_state = state_shapes[1]["properties"]
        question_state = state_shapes[2]["properties"]
        # §14.7 (#105): one class vocabulary across both contact shapes, so
        # the single FRESHNESS_VALUES transcription below covers both.
        self.assertEqual(
            concept_state["freshness"]["enum"],
            material_state["freshness"]["enum"],
        )
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
            "CONCEPT_EXPOSURES": concept_state["exposure"]["enum"],
            "CLARITY_VALUES": concept_state["clarity"]["enum"],
            "COVERAGE_VALUES": concept_state["coverage"]["enum"],
            "FRESHNESS_VALUES": concept_state["freshness"]["enum"],
            "QUESTION_STATUSES": question_state["status"]["enum"],
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
        # Recursive: the floor binds the TypeScript sources under viewer/src/
        # as well as the generated files served to the browser.
        for path in sorted(path for path in VIEWER.rglob("*") if path.is_file()):
            source = path.read_text(encoding="utf-8")
            network_source = source.replace(
                'xmlns="http://www.w3.org/2000/svg"', "")
            with self.subTest(path=path.name):
                self.assertNotIn("inner" + "HTML", source)
                self.assertNotIn("http" + "://", network_source)
                self.assertIsNone(external_literal.search(network_source))


if __name__ == "__main__":
    unittest.main()
