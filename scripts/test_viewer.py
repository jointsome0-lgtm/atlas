import functools
import http.server
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import quote, urlsplit

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

# The general suite may skip the browser tests, but the §27.8 acceptance
# invocation must never pass vacuously: under ATLAS_VIEWER_ACCEPTANCE=1 a
# missing browser driver is a failure, not a skip.
if os.environ.get("ATLAS_VIEWER_ACCEPTANCE") == "1" and sync_playwright is None:
    raise ImportError(
        "ATLAS_VIEWER_ACCEPTANCE=1 requires playwright (pip install"
        " playwright==1.54.0 && playwright install chromium); the §27.8"
        " acceptance proof cannot be skipped")


ROOT = Path(__file__).resolve().parents[1]
DEMO_GRAPH = ROOT / "fixtures" / "demo-graph" / "atlas-graph.json"
VIEWER_ACCEPTANCE = ROOT / "fixtures" / "viewer-acceptance"
UNSUPPORTED_VERSION_FIXTURE = VIEWER_ACCEPTANCE / "unsupported-version.json"
REJECTED_ACCEPTANCE = VIEWER_ACCEPTANCE / "rejected"
EXPECTED_REJECTED_FIXTURES = {
    "dangling-provenance.json": {
        "path": "/edges/0/provenance", "rule": "danglingRef"},
    "discriminant-on-wrong-edge-type.json": {
        "path": "/edges/0/order", "rule": "forbiddenDiscriminant"},
    "duplicate-edge-identity.json": {
        "path": "/edges/1", "rule": "duplicateIdentity"},
    "duplicate-node-id.json": {
        "path": "/nodes/1/id", "rule": "duplicateId"},
    "duplicate-provenance.json": {
        "path": "/edges/0/provenance", "rule": "canonicalSet"},
    "formerly-on-journal-backed-kind.json": {
        "path": "/nodes/1/formerly", "rule": "noRedirectMachinery"},
    "impossible-edge-date.json": {
        "path": "/edges/0/created_at", "rule": "date"},
    "impossible-generated-at-date.json": {
        "path": "/generated_at", "rule": "shape"},
    "impossible-node-date.json": {
        "path": "/nodes/0/observed_at", "rule": "shape"},
    "impossible-state-decision-date.json": {
        "path": "/state", "rule": "date"},
    "impossible-state-last-seen-date.json": {
        "path": "/state", "rule": "contactDates"},
    "kind-changing-formerly-redirect.json": {
        "path": "/nodes/0/formerly", "rule": "kindChange"},
    "living-formerly-redirect.json": {
        "path": "/nodes/1/formerly", "rule": "livingRedirect"},
    "material-part-parent-mismatch.json": {
        "path": "/nodes/2/material", "rule": "partParent"},
    "non-canonical-edge-array-order.json": {
        "path": "/edges/1", "rule": "canonicalOrder"},
    "one-to-n-formerly-redirect.json": {
        "path": "/nodes/1/formerly", "rule": "duplicateRedirect"},
    "payload-on-wrong-node-kind.json": {
        "path": "/nodes/0/url", "rule": "kindProperty"},
    "primary-supporting-role-conflict.json": {
        "path": "/edges/1", "rule": "roleConflict"},
    "projection-key-not-zone-id.json": {
        "path": "/projections", "rule": "zoneKey"},
    "reversed-related-to-pair.json": {
        "path": "/edges/0", "rule": "canonicalOrder"},
    "self-referential-edge.json": {
        "path": "/edges/0/target", "rule": "selfEdge"},
    "state-entry-missing-required.json": {
        "path": "/state", "rule": "required"},
    "state-entry-not-an-object.json": {
        "path": "/state", "rule": "entryShape"},
    "state-entry-unknown-property.json": {
        "path": "/state", "rule": "additionalProperties"},
    "state-entry-wrong-node-kind.json": {
        "path": "/state", "rule": "additionalProperties"},
    "state-key-without-node.json": {
        "path": "/state", "rule": "danglingKey"},
    "state-missing-default-entry.json": {
        "path": "/state", "rule": "missingDefault"},
    "step-on-non-route-material-role.json": {
        "path": "/edges/0/step", "rule": "forbiddenDiscriminant"},
    "unsorted-provenance.json": {
        "path": "/edges/0/provenance", "rule": "canonicalSet"},
    "zone-without-projection.json": {
        "path": "/projections", "rule": "zoneWithoutProjection"},
}
NODE_TYPE_ORDER = [
    "plan", "concept", "material", "material_part", "direction",
    "suggested_route", "personal_trail", "trail_segment", "artifact",
    "encounter", "question", "probe", "zone", "pattern",
]


class QuietViewerHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/graph/atlas-graph.json":
            delay = getattr(self.server, "graph_delay", 0)
            if delay:
                time.sleep(delay)
        super().do_GET()


@unittest.skipUnless(sync_playwright is not None, "playwright is not importable")
class ViewerBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="atlas-viewer-test-")
        cls.root = Path(cls.temporary.name)
        shutil.copytree(ROOT / "viewer", cls.root / "viewer")
        (cls.root / "graph").mkdir()
        handler = functools.partial(QuietViewerHandler, directory=str(cls.root))
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.server.graph_delay = 0
        cls.server_thread = threading.Thread(
            target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.base_url = (
            f"http://127.0.0.1:{cls.server.server_address[1]}"
            "/viewer/index.html"
        )
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join(timeout=5)
        cls.temporary.cleanup()

    def setUp(self):
        self.graph_path = self.root / "graph" / "atlas-graph.json"
        shutil.copyfile(DEMO_GRAPH, self.graph_path)
        self.server.graph_delay = 0
        self.context = self.browser.new_context()
        self.page = self.context.new_page()

    def tearDown(self):
        self.context.close()

    def write_graph(self, value):
        self.graph_path.write_text(
            json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def graph_envelope(self, *, nodes=None, edges=None, version=1):
        emitted_nodes = [] if nodes is None else nodes
        state = {}
        for node in emitted_nodes:
            if node.get("type") == "concept":
                state[node["id"]] = {
                    "exposure": "unseen",
                    "confidence": "unknown",
                    "clarity": "vague",
                    "coverage": "none",
                    "evidence": [],
                    "decisions": [],
                }
            elif node.get("type") == "question":
                state[node["id"]] = {
                    "status": "open",
                    "evidence": [],
                    "decisions": [],
                }
        return {
            "format": "atlas-graph",
            "version": version,
            "nodes": emitted_nodes,
            "edges": [] if edges is None else edges,
            "trails": [],
            "state": state,
            "influence": {},
            "frontier": [],
            "projections": {},
        }

    def open_state(self, fragment, state, timeout=15_000):
        # Force a document navigation even when two state variants use the
        # same fragment but replace graph/atlas-graph.json between loads.
        self.page.goto("about:blank")
        self.page.goto(self.base_url + fragment, wait_until="domcontentloaded")
        self.page.wait_for_selector(
            f'#main[data-state="{state}"]', timeout=timeout)

    def test_all_pr2_screen_states_are_url_reachable(self):
        self.server.graph_delay = 0.6
        self.page.goto(
            self.base_url + "#mode=field", wait_until="domcontentloaded")
        self.assertEqual("LOADING", self.page.locator("#main").get_attribute("data-state"))
        self.assertEqual("Loading the graph…", self.page.locator("#main").inner_text())
        self.page.wait_for_selector('#main[data-state="FIELD"]')
        self.server.graph_delay = 0

        self.graph_path.unlink()
        self.open_state("#mode=field", "MISSING")
        self.assertIn("Couldn't read graph/atlas-graph.json", self.page.locator("#main").inner_text())

        self.graph_path.write_bytes(b"{not json")
        self.open_state("#mode=field", "REJECTED")
        self.assertEqual("alert", self.page.locator(".state-block").get_attribute("role"))
        self.assertIn("This graph file can't be displayed", self.page.locator("#main").inner_text())

        shutil.copyfile(UNSUPPORTED_VERSION_FIXTURE, self.graph_path)
        self.open_state("#mode=field", "UNSUPPORTED_VERSION")
        self.assertIn("format version 2", self.page.locator("#main").inner_text())

        self.write_graph(self.graph_envelope())
        self.open_state("#mode=field", "EMPTY")
        self.assertIn("This graph has no nodes yet", self.page.locator("#main").inner_text())

        # §16.5: address hardening precedes the empty-graph shortcut.
        self.open_state("#mode=%ZZ", "BAD_ADDRESS")

        # §16.4: unknown field/focus still flags visibly on an empty graph.
        self.open_state("#mode=field&field=ocean", "EMPTY")
        self.assertEqual("UNKNOWN_FIELD", self.page.locator(".banner").get_attribute("data-banner"))

        shutil.copyfile(DEMO_GRAPH, self.graph_path)
        self.open_state("#mode=%ZZ", "BAD_ADDRESS")
        self.assertIn("This view address isn't valid", self.page.locator("#main").inner_text())

        self.open_state("#mode=orbit", "UNKNOWN_MODE")
        self.assertIn('Unknown view "orbit".', self.page.locator("#main").inner_text())
        self.assertIn("This viewer knows: field.", self.page.locator("#main").inner_text())

        self.open_state("#mode=route", "NOT_IN_SLICE")
        self.assertIn("isn't part of this viewer slice yet", self.page.locator("#main").inner_text())
        self.assertEqual("#mode=field", self.page.locator("#main a").get_attribute("href"))

        self.open_state("#mode=field&field=body", "UNSUPPORTED_GEOMETRY")
        self.assertIn("silhouette geometry", self.page.locator("#main").inner_text())
        self.assertIn("field=knowledge", self.page.locator("#main a").get_attribute("href"))

        self.open_state("#mode=field&focus=concept:no-such-node", "FIELD")
        self.assertEqual("UNKNOWN_FOCUS", self.page.locator(".banner").get_attribute("data-banner"))
        self.assertIn("Showing the knowledge field", self.page.locator(".banner").inner_text())

        self.open_state("#mode=field&field=ocean", "FIELD")
        self.assertEqual("UNKNOWN_FIELD", self.page.locator(".banner").get_attribute("data-banner"))

        self.open_state("#mode=field&focus=direction:demo-unanchored", "FIELD")
        self.assertEqual("FIELD_UNDEFINED", self.page.locator(".banner").get_attribute("data-banner"))
        self.assertEqual(1, self.page.locator(".node.field-undefined.selected").count())
        self.assertIn("field undefined", self.page.locator("#details").inner_text())

    def test_unknown_fragment_params_of_any_shape_are_ignored(self):
        # §16.4 forward compatibility: unknown keys — underscores, digits,
        # future names — never invalidate the address.
        self.open_state("#mode=field&utm_source=x&foo-bar=1&X9=%20", "FIELD")
        self.assertEqual(0, self.page.locator(".banner").count())

    def test_dangling_edge_endpoint_rejects_the_whole_file(self):
        graph = self.graph_envelope(
            nodes=[{
                "id": "concept:alone", "type": "concept", "title": "Alone",
                "fields": ["knowledge"], "aliases": [],
            }],
            edges=[{
                "source": "concept:alone", "target": "concept:absent",
                "type": "related_to", "provenance": ["concept:alone"],
                "weight": "unassessed",
            }],
        )
        self.write_graph(graph)
        self.open_state("#mode=field", "REJECTED")
        self.assertIn(
            "This graph file can't be displayed",
            self.page.locator("#main").inner_text())

    def test_malformed_builder_impossible_graphs_reject_whole(self):
        fixture_names = sorted(path.name for path in REJECTED_ACCEPTANCE.iterdir())
        self.assertTrue(fixture_names)
        self.assertEqual(sorted(EXPECTED_REJECTED_FIXTURES), fixture_names)
        for name in fixture_names:
            with self.subTest(fixture=name):
                fixture_path = REJECTED_ACCEPTANCE / name
                fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
                shutil.copyfile(fixture_path, self.graph_path)
                self.open_state("#mode=field", "REJECTED")
                diagnostic = self.page.evaluate(
                    """async graph => {
                        const {validateGraph} = await import("./contract.js");
                        return validateGraph(graph);
                    }""",
                    fixture,
                )
                self.assertEqual(
                    EXPECTED_REJECTED_FIXTURES[name], diagnostic)

    def test_state_semantic_gates_reject_builder_impossible_graphs(self):
        concept = {
            "id": "concept:alone", "type": "concept",
            "title": "Alone (Vera Example)",
            "fields": ["knowledge"], "aliases": [],
        }
        artifact = {
            "id": "artifact:notice", "type": "artifact", "title": "",
            "fields": [], "kind": "note", "path": "notes/example.md",
            "observed_at": "2026-07-16",
            "summary": "Synthetic viewer fixture (Vera Example).",
            "evidence_strength": "noticed",
        }
        question = {
            "id": "question:alone", "type": "question", "title": "",
            "fields": ["knowledge"],
            "text": "Is this resolved? (Vera Example)",
            "created_at": "2026-07-16",
            "source": {"artifact": "artifact:missing"},
        }
        reference = {
            "dimension": "confidence",
            "date": "2026-07-16",
            "evidence": ["artifact:first"],
        }
        cases = {}

        graph = self.graph_envelope(nodes=[concept])
        graph["state"][concept["id"]]["confidence"] = "high"
        cases["concept-missing-decision"] = graph

        graph = self.graph_envelope(nodes=[question])
        graph["state"][question["id"]]["status"] = "resolved"
        cases["question-missing-decision"] = graph

        graph = self.graph_envelope(nodes=[concept])
        graph["state"][concept["id"]]["confidence"] = "high"
        graph["state"][concept["id"]]["decisions"] = [
            reference,
            {
                **reference,
                "date": "2026-07-17",
                "evidence": ["artifact:second"],
            },
        ]
        cases["duplicate-decision-dimension"] = graph

        graph = self.graph_envelope(nodes=[concept, artifact])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][concept["id"]].update({
            "confidence": "high",
            "evidence": [],
            "decisions": [{
                "dimension": "confidence",
                "date": "2026-07-16",
                "evidence": [artifact["id"]],
            }],
        })
        cases["concept-omits-decision-evidence"] = graph

        graph = self.graph_envelope(nodes=[concept, artifact])
        graph["state"][concept["id"]].update({
            "exposure": "touched",
            "evidence": [artifact["id"]],
        })
        cases["contact-without-dates"] = graph

        graph = self.graph_envelope(nodes=[concept])
        graph["state"][concept["id"]].update({
            "last_seen": "2026-07-16",
            "freshness": "fresh",
        })
        cases["unseen-with-dates"] = graph

        graph = self.graph_envelope(nodes=[concept, artifact])
        graph["state"][concept["id"]].update({
            "exposure": "touched",
            "last_seen": "2026-07-16",
            "freshness": "fresh",
            "evidence": [artifact["id"]],
        })
        cases["dated-state-without-as-of"] = graph

        graph = self.graph_envelope(nodes=[concept, artifact])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][concept["id"]].update({
            "exposure": "touched",
            "last_seen": "2099-01-01",
            "freshness": "fresh",
            "evidence": [artifact["id"]],
        })
        cases["last-seen-after-as-of"] = graph

        graph = self.graph_envelope(nodes=[concept])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][concept["id"]]["confidence"] = "high"
        graph["state"][concept["id"]]["decisions"] = [{
            **reference,
            "date": "2099-01-01",
        }]
        cases["decision-after-as-of"] = graph

        graph = self.graph_envelope(nodes=[question])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][question["id"]].update({
            "status": "resolved",
            "evidence": [question["id"]],
            "decisions": [{
                "dimension": "status",
                "date": "2026-07-16",
                "evidence": [question["id"]],
            }],
        })
        cases["status-cites-question-creation"] = graph

        graph = self.graph_envelope(nodes=[question])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][question["id"]].update({
            "status": "resolved",
            "evidence": [],
            "decisions": [{
                "dimension": "status",
                "date": "2026-07-16",
                "evidence": [artifact["id"]],
            }],
        })
        cases["status-evidence-diverges-from-decision"] = graph

        graph = json.loads(DEMO_GRAPH.read_text(encoding="utf-8"))
        graph["state"]["question:demo-when-is-retry-safe"] = {
            "status": "stale",
            "evidence": ["artifact:demo-retry-script"],
            "decisions": [{
                "dimension": "status",
                "date": "2026-07-10",
                "evidence": ["artifact:demo-retry-script"],
            }],
        }
        cases["stale-cites-resolved-script"] = graph

        graph = self.graph_envelope(nodes=[concept, artifact])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][concept["id"]].update({
            "exposure": "taught",
            "last_seen": "2026-07-16",
            "freshness": "fresh",
            "evidence": [artifact["id"]],
        })
        cases["taught-cites-noticed-artifact"] = graph

        graph = self.graph_envelope(nodes=[concept, question])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][concept["id"]].update({
            "exposure": "taught",
            "last_seen": "2026-07-16",
            "freshness": "fresh",
            "evidence": [question["id"]],
        })
        cases["taught-cites-question"] = graph

        graph = self.graph_envelope(nodes=[concept, artifact])
        graph["generated_at"] = "2026-07-27T00:00:00Z"
        graph["state"][concept["id"]].update({
            "exposure": "touched",
            "last_seen": "2026-01-01",
            "freshness": "fresh",
            "evidence": [artifact["id"]],
        })
        cases["freshness-not-derived"] = graph

        earlier_artifact = {
            **artifact,
            "id": "artifact:earlier-contact",
            "observed_at": "2026-07-10",
        }
        graph = self.graph_envelope(nodes=[concept, earlier_artifact])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][concept["id"]].update({
            "exposure": "touched",
            "last_seen": "2026-07-16",
            "freshness": "fresh",
            "evidence": [earlier_artifact["id"]],
        })
        cases["concept-last-seen-is-not-cited-date"] = graph

        classed_artifact = {
            **artifact,
            "id": "artifact:classed",
            "sensitivity": "medical",
        }
        graph = self.graph_envelope(nodes=[concept, classed_artifact])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][concept["id"]].update({
            "exposure": "touched",
            "last_seen": "2026-07-16",
            "freshness": "fresh",
            "evidence": [classed_artifact["id"]],
        })
        cases["state-omits-evidence-sensitivity"] = graph

        graph = self.graph_envelope(
            nodes=[{**concept, "sensitivity": "medical"}])
        graph["state"][concept["id"]].pop("sensitivity", None)
        cases["state-omits-target-sensitivity"] = graph

        material = {
            "id": "material:example", "type": "material",
            "title": "Example material (Vera Example)", "fields": [],
            "kind": "docs", "url": "", "status": "active",
        }
        encounter = {
            "id": "encounter:example", "type": "encounter", "title": "",
            "fields": [], "date": "2026-07-16",
            "target": material["id"], "depth": "applied",
            "mode": "background",
        }
        graph = self.graph_envelope(nodes=[material, encounter])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][material["id"]] = {
            "depth_reached": "taught",
            "last_seen": "2026-07-16",
            "evidence": [encounter["id"]],
        }
        cases["depth-exceeds-encounter"] = graph

        graph = self.graph_envelope(nodes=[material, encounter])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][material["id"]] = {
            "depth_reached": "applied",
            "last_seen": "2026-07-15",
            "evidence": [encounter["id"]],
        }
        cases["material-last-seen-predates-cited-encounter"] = graph

        graph = self.graph_envelope(nodes=[material])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][material["id"]] = {
            "depth_reached": "skim",
            "last_seen": "2026-07-16",
            "evidence": ["encounter:missing"],
        }
        cases["material-cites-no-emitted-encounter"] = graph

        graph = self.graph_envelope(nodes=[material, encounter])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][material["id"]] = {
            "depth_reached": "applied",
            "last_seen": "2026-07-16",
            "evidence": [encounter["id"], "encounter:missing"],
        }
        cases["material-cites-partially-dangling-encounters"] = graph

        explained = {
            **artifact,
            "id": "artifact:explained",
            "observed_at": "2026-07-16",
            "evidence_strength": "explained",
        }
        reviewed_before = {
            **artifact,
            "id": "artifact:reviewed",
            "observed_at": "2026-07-15",
            "evidence_strength": "reviewed",
        }
        graph = self.graph_envelope(
            nodes=[concept, explained, reviewed_before])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][concept["id"]].update({
            "exposure": "taught",
            "last_seen": "2026-07-16",
            "freshness": "fresh",
            "evidence": [explained["id"], reviewed_before["id"]],
        })
        cases["taught-review-predates-explanation"] = graph

        for name, impossible in cases.items():
            with self.subTest(case=name):
                self.write_graph(impossible)
                self.open_state("#mode=field", "REJECTED")

        # §20.1 keeps a decision applicable when its cited artifact lies
        # outside the cut or was deleted, so unresolved stale evidence stays
        # acceptable until its non-note kind is actually knowable.
        graph = json.loads(DEMO_GRAPH.read_text(encoding="utf-8"))
        graph["state"]["question:demo-when-is-retry-safe"] = {
            "status": "stale",
            "evidence": ["artifact:missing-note"],
            "decisions": [{
                "dimension": "status",
                "date": "2026-07-10",
                "evidence": ["artifact:missing-note"],
            }],
        }
        self.write_graph(graph)
        self.open_state("#mode=field", "FIELD")

        # The observable §32.6 union is accepted when the class is preserved;
        # the same graph also proves that concept decision evidence may add
        # provenance without being treated as direct contact.
        graph = self.graph_envelope(nodes=[concept, classed_artifact])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][concept["id"]].update({
            "confidence": "high",
            "evidence": [classed_artifact["id"]],
            "decisions": [{
                "dimension": "confidence",
                "date": "2026-07-16",
                "evidence": [classed_artifact["id"]],
            }],
            "sensitivity": "medical",
        })
        self.write_graph(graph)
        self.open_state("#mode=field", "FIELD")

        # Cross-day order is knowable from emitted nodes, but same-day
        # journal position is not; keep the latter as an upper-bound case.
        reviewed_same_day = {
            **reviewed_before,
            "observed_at": "2026-07-16",
        }
        graph = self.graph_envelope(
            nodes=[concept, explained, reviewed_same_day])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][concept["id"]].update({
            "exposure": "taught",
            "last_seen": "2026-07-16",
            "freshness": "fresh",
            "evidence": [explained["id"], reviewed_same_day["id"]],
        })
        self.write_graph(graph)
        self.open_state("#mode=field", "FIELD")

        # The viewer copies the Python boundary's upper bounds, not a partial
        # re-fold: a strong emitted record may justify the rung without
        # re-deriving its target/link relation from omitted journal context.
        applied_artifact = {
            **artifact,
            "id": "artifact:applied",
            "evidence_strength": "applied",
        }
        graph = self.graph_envelope(
            nodes=[concept, applied_artifact, material, encounter])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][concept["id"]].update({
            "exposure": "applied",
            "last_seen": "2026-07-16",
            "freshness": "fresh",
            "evidence": [applied_artifact["id"]],
        })
        graph["state"][material["id"]] = {
            "depth_reached": "applied",
            "last_seen": "2026-07-16",
            "evidence": [encounter["id"]],
        }
        self.write_graph(graph)
        self.open_state("#mode=field", "FIELD")

    def test_dated_nodes_require_and_obey_graph_as_of(self):
        demo = json.loads(DEMO_GRAPH.read_text(encoding="utf-8"))
        dated_fields = {
            "artifact": "observed_at",
            "encounter": "date",
            "question": "created_at",
            "trail_segment": "date",
        }
        for node_type, field in dated_fields.items():
            source = next(
                node for node in demo["nodes"] if node["type"] == node_type)
            for case, generated_at in (
                    ("missing-as-of", None),
                    ("after-as-of", "2026-07-08T00:00:00Z")):
                node = json.loads(json.dumps(source))
                graph = self.graph_envelope(nodes=[node])
                if generated_at is not None:
                    graph["generated_at"] = generated_at
                with self.subTest(
                        node_type=node_type, field=field, case=case):
                    self.write_graph(graph)
                    self.open_state("#mode=field", "REJECTED")

    def test_bom_crlf_and_withheld_reject_whole(self):
        clean = json.dumps(self.graph_envelope(), ensure_ascii=False)
        self.graph_path.write_bytes(b"\xef\xbb\xbf" + clean.encode("utf-8"))
        self.open_state("#mode=field", "REJECTED")

        self.graph_path.write_bytes(
            clean.replace("{", "{\r\n", 1).encode("utf-8"))
        self.open_state("#mode=field", "REJECTED")

        # §20: the full graph never carries withheld — a withheld-bearing
        # file at the viewer's single input path is a partial graph.
        redacted = self.graph_envelope()
        redacted["withheld"] = {
            "nodes": 1, "edges": 0, "trails": 0, "state": 0,
            "influence": 0, "frontier": 0, "projections": 0,
        }
        self.write_graph(redacted)
        self.open_state("#mode=field", "REJECTED")

    def test_duplicate_json_keys_reject_whole(self):
        text = (
            '{"format": "atlas-graph", "version": 1, "nodes": [], "nodes": [],'
            ' "edges": [], "trails": [], "state": {}, "influence": {},'
            ' "frontier": [], "projections": {}}'
        )
        self.graph_path.write_text(text, encoding="utf-8")
        self.open_state("#mode=field", "REJECTED")

    def test_list_auto_engages_past_node_link_ceiling(self):
        nodes = [
            {
                "id": f"concept:n-{index}",
                "type": "concept",
                "title": f"Node {index}",
                "fields": ["knowledge"],
                "aliases": [],
            }
            for index in range(2401)
        ]
        self.write_graph(self.graph_envelope(nodes=nodes))
        self.open_state("#mode=field", "LIST")
        self.assertEqual(
            "2401 nodes is past the node-link ceiling (2,400) — showing the list.",
            self.page.locator('.list-ceiling-note[role="status"]').inner_text(),
        )
        # Sections preview; the tail renders only on explicit request.
        self.assertEqual(500, self.page.locator(".node-list-row").count())
        show_all = self.page.locator(".list-show-all")
        self.assertEqual("Show all 2401 concept rows", show_all.inner_text())
        show_all.click()
        self.page.wait_for_function(
            "document.querySelectorAll('.node-list-row').length === 2401")
        self.assertEqual(0, self.page.locator(".list-show-all").count())
        graph_button = self.page.locator("#graph-view")
        self.assertTrue(graph_button.is_disabled())
        self.assertEqual(
            "Node-link layout caps at 2,400 nodes",
            graph_button.get_attribute("title"),
        )
        self.assertEqual("false", graph_button.get_attribute("aria-pressed"))
        self.assertEqual(
            "true", self.page.locator("#list-view").get_attribute("aria-pressed"))
        self.page.locator(".node-list-row").first.click()
        self.page.wait_for_selector("#details:not([hidden])")
        self.assertEqual(1, self.page.locator(".node-list-row.selected").count())

    def test_keyboard_navigation_focuses_selection_and_pans_graph(self):
        # Without a selection no node sits in the tab order — the list lens is
        # the dense keyboard path; the graph exposes only the selection.
        self.open_state("#mode=field", "FIELD")
        self.assertEqual(0, self.page.locator('g.node[tabindex="0"]').count())

        self.open_state("#mode=field&focus=concept:rest-api", "FIELD")
        self.assertEqual(1, self.page.locator('g.node[tabindex="0"]').count())
        # The deep link lands keyboard focus on the selection itself.
        self.page.wait_for_function(
            "document.activeElement?.getAttribute('data-node-id')"
            " === 'concept:rest-api'")
        # And the selection stays tab-reachable from the graph surface.
        self.page.locator("svg.graph-svg").focus()
        self.page.keyboard.press("Tab")
        focused = self.page.locator("g.node:focus")
        self.assertEqual(1, focused.count())
        self.assertEqual(
            "concept:rest-api", focused.get_attribute("data-node-id"))
        ring_opacity = focused.locator(".focus-ring").evaluate(
            "ring => getComputedStyle(ring).opacity")
        self.assertNotEqual("0", ring_opacity)

        before = self.page.locator("svg .viewport").get_attribute("transform")
        self.page.keyboard.press("ArrowRight")
        after = self.page.locator("svg .viewport").get_attribute("transform")
        self.assertNotEqual(before, after)

    def test_list_lens_orders_sections_and_activates_rows(self):
        graph = json.loads(DEMO_GRAPH.read_text(encoding="utf-8"))
        visible = [
            node for node in graph["nodes"]
            if "knowledge" in node["fields"] or node["fields"] == []
        ]
        expected_types = [
            node_type for node_type in NODE_TYPE_ORDER
            if any(node["type"] == node_type for node in visible)
        ]
        self.open_state("#mode=field", "FIELD")
        self.page.locator("#list-view").click()
        self.page.wait_for_selector('#main[data-state="LIST"]')
        actual_types = self.page.locator(".node-list-section").evaluate_all(
            "sections => sections.map(section => section.dataset.nodeType)")
        self.assertEqual(expected_types, actual_types)
        self.assertEqual(len(visible), self.page.locator(".node-list-row").count())
        self.assertEqual(
            "true", self.page.locator("#list-view").get_attribute("aria-pressed"))
        self.assertFalse(self.page.locator("#graph-view").is_disabled())

        row = self.page.locator(".node-list-row").first
        node_id = row.get_attribute("data-node-id")
        row.click()
        self.page.wait_for_selector("#details:not([hidden])")
        self.assertIn(
            "focus=" + node_id,
            self.page.evaluate("decodeURIComponent(location.hash)"),
        )
        self.assertEqual(
            node_id,
            self.page.locator(".node-list-row.selected").get_attribute("data-node-id"),
        )

    def test_list_panel_respects_routes_lens(self):
        self.open_state("#mode=field&focus=concept:rest-api", "FIELD")
        self.page.locator("#list-view").click()
        self.page.wait_for_selector('#main[data-state="LIST"]')
        self.page.wait_for_selector("#details:not([hidden])")

        def status_edge_count():
            return self.page.locator("#status-bar").evaluate(
                "bar => Number(bar.textContent.match(/· (\\d+) edges/)[1])")

        def headings():
            return [text.lower() for text in
                    self.page.locator("#details .edge-groups h3").all_inner_texts()]

        self.assertIn("step_of_route", headings())
        all_edge_count = status_edge_count()
        self.page.locator("#routes-toggle").click()
        self.page.wait_for_selector('#main[data-state="LIST"]')
        self.page.wait_for_function(
            "before => Number(document.querySelector('#status-bar')"
            ".textContent.match(/· (\\d+) edges/)[1]) < before",
            arg=all_edge_count,
        )
        without_routes = headings()
        self.assertLess(status_edge_count(), all_edge_count)
        self.assertNotIn("step_of_route", without_routes)
        self.assertNotIn("suggested_next", without_routes)

    def test_redraw_restores_focus_only_when_orphaned(self):
        self.open_state("#mode=field", "FIELD")
        self.page.locator("#list-view").click()
        self.page.wait_for_selector('#main[data-state="LIST"]')
        row = self.page.locator(".node-list-row").first
        node_id = row.get_attribute("data-node-id")
        row.click()
        self.page.wait_for_selector("#details:not([hidden])")
        # The activated row was destroyed by the rebuild; focus lands on its
        # replacement so Tab continues from the selection.
        self.page.wait_for_function(
            "id => document.activeElement?.getAttribute('data-node-id') === id",
            arg=node_id,
        )
        # A live control keeps focus across the redraw it triggers.
        toggle = self.page.locator("#routes-toggle")
        toggle.focus()
        toggle.press(" ")
        self.page.wait_for_selector('#main[data-state="LIST"]')
        self.page.evaluate(
            "new Promise(done => requestAnimationFrame("
            "() => requestAnimationFrame(done)))")
        self.assertTrue(self.page.evaluate(
            "document.activeElement?.id === 'routes-toggle'"))

    def test_focus_ring_sits_outside_selection_ring(self):
        self.open_state("#mode=field&focus=concept:rest-api", "FIELD")
        selected = self.page.locator(".node.selected")
        focus_radius = float(
            selected.locator(".focus-ring").get_attribute("r"))
        selection_radius = float(
            selected.locator(".selection-ring").get_attribute("r"))
        self.assertGreater(focus_radius, selection_radius)

    def test_header_controls_reachable_in_narrow_embed(self):
        self.page.set_viewport_size({"width": 360, "height": 640})
        self.open_state("#mode=field", "FIELD")
        box = self.page.locator("#legend-toggle").bounding_box()
        self.assertIsNotNone(box)
        self.assertLessEqual(box["x"] + box["width"], 360)
        self.page.locator("#legend-toggle").click()
        self.assertTrue(self.page.locator("#legend").is_visible())

    def test_legend_receives_focus_for_keyboard_scrolling(self):
        self.open_state("#mode=field", "FIELD")
        self.page.locator("#legend-toggle").click()
        self.assertTrue(self.page.evaluate(
            "document.activeElement?.id === 'legend'"))
        self.page.keyboard.press("Escape")
        self.assertTrue(self.page.evaluate(
            "document.activeElement?.id === 'legend-toggle'"))

    def test_glyphs_carry_kind_marks_beyond_color(self):
        self.open_state("#mode=field", "FIELD")
        self.page.locator("#list-view").click()
        self.page.wait_for_selector('#main[data-state="LIST"]')
        question_glyph = self.page.locator(
            '.node-list-section[data-node-type="question"] .node-glyph')
        self.assertEqual(1, question_glyph.locator(".question-ring").count())
        trail_glyph = self.page.locator(
            '.node-list-section[data-node-type="personal_trail"] .node-glyph')
        self.assertEqual(2, trail_glyph.locator("circle.node-shape").count())
        self.page.locator("#legend-toggle").click()
        self.assertEqual(
            1,
            self.page.locator(".legend .node-question .question-ring").count())

    def test_escape_dismisses_layers_topmost_first(self):
        self.open_state("#mode=field&focus=concept:rest-api", "FIELD")
        self.page.wait_for_selector("#details:not([hidden])")
        self.page.locator("#legend-toggle").click()
        self.page.keyboard.press("Escape")
        self.assertTrue(self.page.locator("#legend").is_hidden())
        self.assertTrue(self.page.locator("#details").is_visible())
        self.page.keyboard.press("Escape")
        self.page.wait_for_selector("#details[hidden]", state="attached")

    def test_legend_omits_frozen_body_kinds(self):
        self.open_state("#mode=field", "FIELD")
        self.page.locator("#legend-toggle").click()
        labels = self.page.locator(".legend-nodes .legend-row span").all_inner_texts()
        self.assertNotIn("zone", labels)
        self.assertNotIn("pattern", labels)
        self.assertIn("concept", labels)

    def test_legend_disclosure_lists_five_edge_families(self):
        self.open_state("#mode=field", "FIELD")
        button = self.page.locator("#legend-toggle")
        self.assertEqual("false", button.get_attribute("aria-expanded"))
        button.click()
        self.assertEqual("true", button.get_attribute("aria-expanded"))
        self.assertTrue(self.page.locator('.legend[role="note"]').is_visible())
        self.assertEqual(
            ["routes (hideable)", "trail", "authored (tick length = weight)", "structure",
             "journal-derived"],
            self.page.locator(".legend-edges .legend-row span").all_inner_texts(),
        )
        self.page.keyboard.press("Escape")
        self.assertEqual("false", button.get_attribute("aria-expanded"))
        self.assertTrue(self.page.locator("#legend").is_hidden())

    def test_reduced_motion_disables_question_animation(self):
        self.context.close()
        self.context = self.browser.new_context(reduced_motion="reduce")
        self.page = self.context.new_page()
        self.open_state("#mode=field", "FIELD")
        animation_name = self.page.locator(".question-ring").first.evaluate(
            "ring => getComputedStyle(ring).animationName")
        self.assertEqual("none", animation_name)

    def test_demo_render_and_panel_interactions_stay_offline_and_csp_clean(self):
        origin = self.base_url[:self.base_url.index("/viewer/")]
        requests = []
        self.page.on("request", lambda request: requests.append(request.url))
        self.page.add_init_script("""
            window.__cspViolations = [];
            document.addEventListener("securitypolicyviolation", event => {
              window.__cspViolations.push({
                blockedURI: event.blockedURI,
                violatedDirective: event.violatedDirective
              });
            });
        """)
        self.open_state("#mode=field", "FIELD")
        self.page.locator("g.node").first.focus()
        self.page.keyboard.press("Enter")
        self.page.wait_for_selector("#details:not([hidden])")
        self.page.locator("#close-details").click()
        self.page.wait_for_selector("#details", state="hidden")

        self.assertTrue(requests)
        self.assertTrue(all(url.startswith(origin) for url in requests), requests)
        paths = {urlsplit(url).path for url in requests}
        expected = {
            "/viewer/index.html",
            "/viewer/viewer.css",
            "/viewer/viewer.js",
            "/viewer/contract.js",
            "/viewer/favicon.svg",
            "/graph/atlas-graph.json",
        }
        self.assertTrue(paths.issubset(expected), paths)
        self.assertEqual(
            expected - {"/viewer/favicon.svg"},
            paths - {"/viewer/favicon.svg"},
        )
        self.assertEqual([], self.page.evaluate("window.__cspViolations"))

    def test_demo_graph_renders_expected_svg_counts_and_route_lens(self):
        graph = json.loads(DEMO_GRAPH.read_text(encoding="utf-8"))
        visible_ids = {
            node["id"] for node in graph["nodes"]
            if "knowledge" in node["fields"] or node["fields"] == []
        }
        visible_edges = [
            edge for edge in graph["edges"]
            if edge["source"] in visible_ids and edge["target"] in visible_ids
        ]
        self.open_state("#mode=field", "FIELD")
        self.assertEqual(len(visible_ids), self.page.locator("svg .node").count())
        self.assertEqual(len(visible_edges), self.page.locator("svg .edge-group").count())
        self.assertIn(
            f"{len(visible_ids)} nodes · {len(visible_edges)} edges in view",
            self.page.locator("#status-bar").inner_text(),
        )
        self.assertIn("as of 2026-07-10", self.page.locator("#status-bar").inner_text())
        initial_hash = self.page.evaluate("location.hash")
        self.page.locator("#routes-toggle").uncheck()
        self.page.wait_for_selector('#main[data-state="FIELD"]')
        rendered_edge_count = self.page.locator("svg .edge-group").count()
        self.assertLess(rendered_edge_count, len(visible_edges))
        self.assertIn(
            f"{len(visible_ids)} nodes · {rendered_edge_count} edges in view",
            self.page.locator("#status-bar").inner_text(),
        )
        self.assertEqual(initial_hash, self.page.evaluate("location.hash"))

    def test_edge_weight_marks_never_ride_the_stroke(self):
        # §16.2 A2/A3: an asserted weight is a midpoint tick whose extent
        # carries the level; unassessed opens the stroke and draws no tick, so
        # silence cannot read as an asserted medium; a type that admits no
        # weight keeps one unbroken stroke.
        graph = json.loads(DEMO_GRAPH.read_text(encoding="utf-8"))
        visible_ids = {
            node["id"] for node in graph["nodes"]
            if "knowledge" in node["fields"] or node["fields"] == []
        }
        visible_edges = [
            edge for edge in graph["edges"]
            if edge["source"] in visible_ids and edge["target"] in visible_ids
        ]
        asserted = [edge for edge in visible_edges if edge.get("weight") in {"low", "medium", "high"}]
        unassessed = [edge for edge in visible_edges if edge.get("weight") == "unassessed"]
        self.assertTrue(asserted and unassessed, "fixture must exercise both readings")
        self.open_state("#mode=field", "FIELD")
        self.assertEqual(0, self.page.locator("svg .edge-line[stroke-opacity]").count())
        drawn = self.page.evaluate(
            """() => {
                const token = (name) => parseFloat(
                    getComputedStyle(document.documentElement).getPropertyValue(name));
                const ends = (el) => ["x1", "y1", "x2", "y2"].map((a) => parseFloat(el.getAttribute(a)));
                const marked = [];
                const opened = [];
                for (const group of document.querySelectorAll("svg .edge-group")) {
                    const tick = group.querySelector(".edge-weight");
                    const detail = [...group.querySelectorAll(".weight-detail")];
                    if (tick) {
                        const [x1, y1, x2, y2] = ends(group.querySelector(".edge-line"));
                        const [tx1, ty1, tx2, ty2] = ends(tick);
                        const ex = x2 - x1, ey = y2 - y1;
                        const dx = tx2 - tx1, dy = ty2 - ty1;
                        const extent = Math.hypot(dx, dy);
                        marked.push({
                            extent,
                            alignment: Math.abs((ex * dx + ey * dy) / (Math.hypot(ex, ey) * extent)),
                            offCentre: Math.hypot(
                                (tx1 + tx2) / 2 - (x1 + x2) / 2, (ty1 + ty2) / 2 - (y1 + y2) / 2)
                        });
                    }
                    if (detail.length) {
                        const [, , ax2, ay2] = ends(detail[0]);
                        const [bx1, by1] = ends(detail[1]);
                        opened.push({
                            segments: detail.length,
                            gap: Math.hypot(bx1 - ax2, by1 - ay2),
                            tick: Boolean(tick),
                            dropped: group.querySelectorAll(".weight-dropped").length
                        });
                    }
                }
                return {marked, opened, tokens: {
                    low: token("--w-tick-low"),
                    medium: token("--w-tick-medium"),
                    high: token("--w-tick-high"),
                    gap: token("--w-gap")
                }};
            }"""
        )
        tokens = drawn["tokens"]
        # extent is the channel, so the three levels must stay ordered and apart
        self.assertLess(tokens["low"], tokens["medium"])
        self.assertLess(tokens["medium"], tokens["high"])
        self.assertGreater(tokens["gap"], 0)
        self.assertEqual(len(asserted), len(drawn["marked"]))
        # Coordinates are emitted at three decimals, so extents recovered from
        # them are exact only to two.
        self.assertEqual(
            sorted(round(tokens[edge["weight"]], 2) for edge in asserted),
            sorted(round(mark["extent"], 2) for mark in drawn["marked"]),
        )
        for mark in drawn["marked"]:
            # a tick that lay along its edge would vanish into the stroke
            # (coordinates are emitted at three decimals, hence the tolerance)
            self.assertAlmostEqual(0, mark["alignment"], places=3)
            self.assertAlmostEqual(0, mark["offCentre"], places=2)
        self.assertEqual(len(unassessed), len(drawn["opened"]))
        for opening in drawn["opened"]:
            self.assertEqual(2, opening["segments"])
            self.assertFalse(opening["tick"])
            self.assertEqual(1, opening["dropped"])
            self.assertGreater(opening["gap"], 0)
            self.assertLessEqual(round(opening["gap"], 2), tokens["gap"])

    def zoom_out_until(self, viewport, minus, class_name, limit=14):
        for _ in range(limit):
            if class_name in (viewport.get_attribute("class") or ""):
                return
            minus.click()
        self.fail(f"{class_name} never engaged within the zoom range")

    def test_density_drops_channels_whole_and_in_fixed_order(self):
        # §16.2 A11: as density rises the channels drop whole and in the
        # fixed order — decision rails and weight marks together, then
        # labels, then interior texture and boundary continuity — and the
        # status line names what is not drawn, so the omission is never
        # silent. Density is spacing-driven, so the sparse demo at zoom 1
        # shows the full language. A selection is open so the label tier can
        # prove it drops the channel whole, selection included.
        self.open_state("#mode=field&focus=concept%3Ahttp-methods", "FIELD")
        minus = self.page.get_by_role("button", name="Zoom out")
        viewport = self.page.locator("svg .viewport")
        self.assertTrue(self.page.locator("svg .edge-weight").first.is_visible())
        self.assertTrue(self.page.locator("svg .rail").first.is_visible())
        self.assertFalse(self.page.locator("svg .weight-dropped").first.is_visible())
        self.assertNotIn("not drawn at this density", self.page.locator("#status-bar").inner_text())

        self.zoom_out_until(viewport, minus, "drop-decision")
        self.assertNotIn("drop-labels", viewport.get_attribute("class"))
        self.assertFalse(self.page.locator("svg .edge-weight").first.is_visible())
        self.assertFalse(self.page.locator("svg .weight-detail").first.is_visible())
        self.assertFalse(self.page.locator("svg .rail").first.is_visible())
        self.assertTrue(self.page.locator("svg .weight-dropped").first.is_visible())
        self.assertTrue(self.page.locator("svg .node-label").first.is_visible())
        self.assertIn(
            "not drawn at this density: decision rails, edge weight",
            self.page.locator("#status-bar").inner_text(),
        )

        self.zoom_out_until(viewport, minus, "drop-labels")
        self.assertNotIn("drop-state", viewport.get_attribute("class"))
        # The channel drops whole: no label survives, the selection's included.
        self.assertEqual(0, self.page.locator("svg .node-label:visible").count())
        self.assertIn(
            "not drawn at this density: decision rails, edge weight, labels",
            self.page.locator("#status-bar").inner_text(),
        )
        # The texture channel still draws between the label and state tiers.
        hatched_fill = self.page.evaluate(
            "getComputedStyle(document.querySelector("
            "'g.node[data-node-id=\"concept:http-methods\"] .node-shape')).fill")
        self.assertIn("url", hatched_fill)

        self.zoom_out_until(viewport, minus, "drop-state")
        self.assertIn(
            "not drawn at this density: decision rails, edge weight, labels,"
            " state texture, freshness boundary",
            self.page.locator("#status-bar").inner_text(),
        )
        # A node drawn without a boundary is drawn without state: the plate
        # falls back to its plain kind reading, never a cluster or heat.
        dropped_fill = self.page.evaluate(
            "getComputedStyle(document.querySelector("
            "'g.node[data-node-id=\"concept:http-methods\"] .node-shape')).fill")
        self.assertNotIn("url", dropped_fill)

    def artifact_node(self, slug, strength, observed_at):
        return {
            "id": f"artifact:{slug}", "type": "artifact", "title": "",
            "fields": [], "kind": "note", "path": f"notes/{slug}.md",
            "observed_at": observed_at,
            "summary": f"Synthetic viewer fixture (Vera Example): {slug}.",
            "evidence_strength": strength,
        }

    def concept_node(self, slug):
        return {
            "id": f"concept:{slug}", "type": "concept",
            "title": f"{slug} (Vera Example)",
            "fields": ["knowledge"], "aliases": [],
        }

    def node_class(self, node_id):
        return self.page.locator(f'g.node[data-node-id="{node_id}"]').get_attribute("class")

    def test_plate_texture_follows_each_contact_ladder(self):
        # §16.2 A1: interior texture is the monotone contact ladder — the
        # concept exposure rungs and the material depth rungs each keyed to
        # the node's own state key, never a child's (A12).
        self.open_state("#mode=field", "FIELD")
        self.assertIn("tx-plain", self.node_class("concept:redis"))
        self.assertIn("tx-hatch", self.node_class("concept:http-methods"))
        self.assertIn("tx-solid", self.node_class("concept:idempotency"))
        self.assertIn("tx-solid", self.node_class("part:mdn-http-methods/idempotency"))
        # The parent material has no entry of its own: no contact, however
        # much its part carries (A12).
        self.assertIn("tx-plain", self.node_class("material:mdn-http-methods"))

        touched = self.concept_node("touched-example")
        summarized = self.concept_node("summarized-example")
        taught = self.concept_node("taught-example")
        noticed = self.artifact_node("noticed", "noticed", "2026-07-16")
        summed = self.artifact_node("summarized", "summarized", "2026-07-16")
        explained = self.artifact_node("explained", "explained", "2026-07-15")
        reviewed = self.artifact_node("reviewed", "reviewed", "2026-07-16")
        material = {
            "id": "material:skimmed", "type": "material",
            "title": "Skimmed material (Vera Example)", "fields": [],
            "kind": "docs", "url": "", "status": "active",
        }
        encounter = {
            "id": "encounter:skim", "type": "encounter", "title": "",
            "fields": [], "date": "2026-07-16",
            "target": material["id"], "depth": "skim", "mode": "background",
        }
        graph = self.graph_envelope(nodes=[
            touched, summarized, taught, noticed, summed, explained,
            reviewed, material, encounter])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][touched["id"]].update({
            "exposure": "touched", "last_seen": "2026-07-16",
            "freshness": "fresh", "evidence": [noticed["id"]],
        })
        graph["state"][summarized["id"]].update({
            "exposure": "summarized", "last_seen": "2026-07-16",
            "freshness": "fresh", "evidence": [summed["id"]],
        })
        graph["state"][taught["id"]].update({
            "exposure": "taught", "last_seen": "2026-07-16",
            "freshness": "fresh",
            "evidence": [explained["id"], reviewed["id"]],
        })
        graph["state"][material["id"]] = {
            "depth_reached": "skim", "last_seen": "2026-07-16",
            "evidence": [encounter["id"]],
        }
        self.write_graph(graph)
        self.open_state("#mode=field", "FIELD")
        self.assertIn("tx-dot", self.node_class(touched["id"]))
        self.assertIn("tx-cross", self.node_class(summarized["id"]))
        self.assertIn("tx-keyline", self.node_class(taught["id"]))
        self.assertIn("tx-dot", self.node_class(material["id"]))
        touched_node = self.page.locator(f'g.node[data-node-id="{touched["id"]}"]')
        self.assertEqual(1, touched_node.locator(".plate-dot").count())
        taught_node = self.page.locator(f'g.node[data-node-id="{taught["id"]}"]')
        self.assertEqual(1, taught_node.locator(".plate-keyline").count())

    def freshness_graph(self):
        fresh = self.concept_node("fresh-example")
        aging = self.concept_node("aging-example")
        stale = self.concept_node("stale-example")
        contacts = {
            fresh["id"]: ("2026-07-10", "fresh"),
            aging["id"]: ("2026-05-20", "aging"),
            stale["id"]: ("2026-04-01", "stale"),
        }
        artifacts = []
        graph = self.graph_envelope(nodes=[fresh, aging, stale])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        for index, (concept_id, (seen, freshness)) in enumerate(contacts.items()):
            artifact = self.artifact_node(f"contact-{index}", "read", seen)
            artifacts.append(artifact)
            graph["state"][concept_id].update({
                "exposure": "read", "last_seen": seen,
                "freshness": freshness, "evidence": [artifact["id"]],
            })
        graph["nodes"].extend(artifacts)
        return graph, contacts

    def boundary_dashes(self, contacts):
        dashes = {}
        labels = {}
        for concept_id, (_seen, freshness) in contacts.items():
            dashes[freshness], labels[freshness] = self.page.evaluate(
                """id => {
                    const group = document.querySelector(`g.node[data-node-id="${id}"]`);
                    return [
                        getComputedStyle(group.querySelector(".node-shape")).strokeDasharray,
                        getComputedStyle(group.querySelector(".node-label")).fill,
                    ];
                }""",
                concept_id,
            )
        return dashes, labels

    def test_boundary_continuity_is_freshness_and_stale_recedes(self):
        # §16.2 A4: the three §14.7 classes are three discrete boundary
        # continuities — no badge, count, or ring — and A6: stale only mutes.
        graph, contacts = self.freshness_graph()
        self.write_graph(graph)
        self.open_state("#mode=field", "FIELD")
        for concept_id, (_seen, freshness) in contacts.items():
            self.assertIn(f"fresh-{freshness}", self.node_class(concept_id))
        dashes, labels = self.boundary_dashes(contacts)
        self.assertEqual(3, len(set(dashes.values())))
        self.assertEqual("none", dashes["fresh"])
        # A6: the stale label recedes; nothing else changes register.
        self.assertNotEqual(labels["fresh"], labels["stale"])
        self.assertEqual(labels["fresh"], labels["aging"])

    def test_rail_carries_gated_dimensions_only(self):
        # §16.2 A2: a drawn open slot for silence, a struck mark whose extent
        # carries the decided level, the fork for disputed — and no rail at
        # all on kinds that admit no gated dimension.
        concept = self.concept_node("decided-example")
        artifact = self.artifact_node("decision-basis", "read", "2026-07-16")
        graph = self.graph_envelope(nodes=[concept, artifact])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][concept["id"]].update({
            "exposure": "read", "last_seen": "2026-07-16",
            "freshness": "fresh", "confidence": "high",
            "clarity": "disputed", "evidence": [artifact["id"]],
            "decisions": [
                {"dimension": "confidence", "date": "2026-07-16",
                 "evidence": [artifact["id"]]},
                {"dimension": "clarity", "date": "2026-07-16",
                 "evidence": [artifact["id"]]},
            ],
        })
        self.write_graph(graph)
        self.open_state("#mode=field", "FIELD")
        node = self.page.locator(f'g.node[data-node-id="{concept["id"]}"]')
        self.assertEqual(1, node.locator(".rail").count())
        slots = node.locator(".rail-slot")
        self.assertEqual(
            ["confidence", "clarity", "coverage"],
            slots.evaluate_all("slots => slots.map(slot => slot.dataset.dimension)"),
        )
        drawn = self.page.evaluate(
            """id => {
                const token = (name) => parseFloat(
                    getComputedStyle(document.documentElement).getPropertyValue(name));
                const rail = document.querySelector(`g.node[data-node-id="${id}"] .rail`);
                const slots = [...rail.querySelectorAll(".rail-slot")];
                const marks = [...rail.querySelectorAll(".rail-mark")];
                const within = (slot) => marks.filter((mark) => {
                    const y = parseFloat(mark.getAttribute("y"));
                    const top = parseFloat(slot.getAttribute("y"));
                    return y >= top - 0.01
                        && y <= top + parseFloat(slot.getAttribute("height")) + 0.01;
                });
                return {
                    confidence: within(slots[0]).map((mark) => parseFloat(mark.getAttribute("height"))),
                    clarity: within(slots[1]).length,
                    coverage: within(slots[2]).length,
                    tokens: {high: token("--rail-mark-3")},
                };
            }""",
            concept["id"],
        )
        # confidence high: one struck mark at the top extent.
        self.assertEqual([drawn["tokens"]["high"]], drawn["confidence"])
        # clarity disputed: the fork — a base and two tines, not a rung.
        self.assertEqual(3, drawn["clarity"])
        # coverage undecided: the slot stays drawn and unstruck.
        self.assertEqual(0, drawn["coverage"])
        # Kinds that admit no gated dimension draw no rail: the artifact, and
        # a question (its gated status is words in the panel and the list).
        self.assertEqual(0, self.page.locator(
            f'g.node[data-node-id="{artifact["id"]}"] .rail').count())
        self.open_state(
            "#mode=field&focus=" + quote(concept["id"], safe=""), "FIELD")
        self.page.wait_for_selector("#details:not([hidden])")
        panel = self.page.locator("#details").inner_text()
        self.assertIn("high", panel)
        self.assertIn("disputed", panel)
        self.assertIn("no decision", panel)

    def test_state_words_share_one_vocabulary_across_surfaces(self):
        # §16.2 A8: field marks, panel words, and list columns speak one
        # vocabulary; silence is "no decision" / "no contact" everywhere.
        self.open_state("#mode=field&focus=material%3Amdn-http-methods", "FIELD")
        panel = self.page.locator("#details").inner_text()
        self.assertIn("depth reached", panel.lower())
        self.assertIn("no contact", panel)
        self.page.locator("#list-view").click()
        self.page.wait_for_selector('#main[data-state="LIST"]')
        row = self.page.locator('.node-list-row[data-node-id="material:mdn-http-methods"]')
        self.assertIn("depth reached: no contact", row.inner_text())
        concept_row = self.page.locator('.node-list-row[data-node-id="concept:http-methods"]')
        words = concept_row.inner_text()
        self.assertIn("exposure: read", words)
        self.assertIn("confidence: no decision", words)
        self.assertIn("freshness: fresh — last seen 2026-07-09", words)
        # Question status is gated (§14.6): the demo question has no
        # confirmed decision, so its words are the unstruck form — never a
        # value indistinguishable from a decided "open".
        question_row = self.page.locator('.node-list-row[data-node-id="question:demo-when-is-retry-safe"]')
        self.assertIn("status: no decision", question_row.inner_text())
        # The legend speaks the same words for the drawn silence.
        self.page.locator("#legend-toggle").click()
        legend = self.page.locator("#legend").inner_text()
        self.assertIn("no decision recorded", legend)
        self.assertIn("no contact", legend)

    def test_field_undefined_is_a_cartouche_never_a_boundary_dash(self):
        # §16.2 A4: a dash on a node boundary is always freshness, so the
        # field-undefined flag is a hairline cartouche plus words.
        self.open_state("#mode=field&focus=direction:demo-unanchored", "FIELD")
        flagged = self.page.locator(".node.field-undefined.selected")
        self.assertEqual(1, flagged.locator(".cartouche").count())
        self.assertEqual(
            "none",
            flagged.locator(".node-shape").evaluate(
                "shape => getComputedStyle(shape).strokeDasharray"),
        )
        # The frame encloses the whole drawn glyph rather than cutting it.
        self.assertTrue(flagged.evaluate(
            """group => {
                const frame = group.querySelector(".cartouche").getBBox();
                const shape = group.querySelector(".node-shape").getBBox();
                return frame.x < shape.x && frame.y < shape.y
                    && frame.x + frame.width > shape.x + shape.width
                    && frame.y + frame.height > shape.y + shape.height;
            }"""))

    def test_directed_edges_stop_short_of_their_endpoints(self):
        # An untrimmed stroke would bury its arrowhead under the target
        # plate; every demo edge is long enough to trim, so no rendered line
        # may end at a node centre.
        self.open_state("#mode=field", "FIELD")
        untrimmed = self.page.evaluate(
            """() => {
                const centres = [];
                for (const node of document.querySelectorAll("g.node")) {
                    const match = node.getAttribute("transform")
                        .match(/translate\\(([-\\d.]+) ([-\\d.]+)\\)/);
                    centres.push({x: parseFloat(match[1]), y: parseFloat(match[2])});
                }
                let count = 0;
                for (const line of document.querySelectorAll("svg .edge-line")) {
                    if (line.classList.contains("weight-dropped")) continue;
                    for (const [x, y] of [["x1", "y1"], ["x2", "y2"]]) {
                        const px = parseFloat(line.getAttribute(x));
                        const py = parseFloat(line.getAttribute(y));
                        if (centres.some((centre) =>
                                Math.hypot(centre.x - px, centre.y - py) < 0.01)) {
                            count += 1;
                        }
                    }
                }
                return count;
            }""")
        self.assertEqual(0, untrimmed)

    def test_forced_colors_keeps_state_structural(self):
        # §27.8: every state distinction survives forced colours because the
        # channels are texture, continuity, and mark extent — not hue.
        self.context.close()
        self.context = self.browser.new_context(forced_colors="active")
        self.page = self.context.new_page()
        self.open_state("#mode=field", "FIELD")
        hatched_fill = self.page.evaluate(
            "getComputedStyle(document.querySelector("
            "'g.node[data-node-id=\"concept:http-methods\"] .node-shape')).fill")
        self.assertIn("url", hatched_fill)
        self.assertGreater(self.page.locator("svg .rail-slot").count(), 0)
        plain_fill, solid_fill = self.page.evaluate(
            """() => ["concept:redis", "concept:idempotency"].map(id =>
                getComputedStyle(document.querySelector(
                    `g.node[data-node-id="${id}"] .node-shape`)).fill)""")
        self.assertNotEqual(plain_fill, solid_fill)
        # The three boundary continuities stay three under the forced palette.
        graph, contacts = self.freshness_graph()
        self.write_graph(graph)
        self.open_state("#mode=field", "FIELD")
        dashes, _labels = self.boundary_dashes(contacts)
        self.assertEqual(3, len(set(dashes.values())))

    def test_focus_opens_panel_for_each_rendered_kind(self):
        graph = json.loads(DEMO_GRAPH.read_text(encoding="utf-8"))
        examples = {}
        for node in graph["nodes"]:
            if "knowledge" in node["fields"] or node["fields"] == []:
                examples.setdefault(node["type"], node)
        for node_type, node in examples.items():
            with self.subTest(node_type=node_type):
                focus = quote(node["id"], safe="")
                self.open_state(f"#mode=field&focus={focus}", "FIELD")
                self.page.wait_for_selector("#details:not([hidden])")
                expected_heading = node["title"] or node["id"]
                self.assertEqual(expected_heading, self.page.locator("#details h2").inner_text())
                self.assertEqual(
                    node_type.replace("_", " "),
                    self.page.locator("#details .type-chip").inner_text(),
                )
                self.assertEqual(1, self.page.locator("svg .node.selected").count())

    def test_url_field_is_link_only_after_https_reparse(self):
        nodes = [
            {
                "id": "material:linked",
                "type": "material",
                "title": "Linked material",
                "fields": ["knowledge"],
                "kind": "docs",
                "url": "https://example.test/Guide",
                "status": "active",
            },
            {
                "id": "material:inert",
                "type": "material",
                "title": "Inert material",
                "fields": ["knowledge"],
                "kind": "docs",
                "url": "https://a%",
                "status": "active",
            },
        ]
        self.write_graph(self.graph_envelope(nodes=nodes))
        self.open_state("#mode=field&focus=material%3Alinked", "FIELD")
        link = self.page.locator("#details .detail-row a")
        self.assertEqual(1, link.count())
        self.assertEqual("https://example.test/Guide", link.inner_text())
        self.assertEqual("noopener noreferrer", link.get_attribute("rel"))
        # No target="_blank": the §16.5 sandbox grants no popups, so an
        # auxiliary context would leave embedded links inert.
        self.assertIsNone(link.get_attribute("target"))

        self.open_state("#mode=field&focus=material%3Ainert", "FIELD")
        self.assertEqual(0, self.page.locator("#details .detail-row a").count())
        self.assertIn("https://a%", self.page.locator("#details").inner_text())

    def test_layout_is_deterministic_and_focus_survives_reload(self):
        self.open_state("#mode=field", "FIELD")
        first = self.page.locator("svg .node").evaluate_all(
            "nodes => nodes.map(node => node.getAttribute('transform'))")
        self.page.reload(wait_until="domcontentloaded")
        self.page.wait_for_selector('#main[data-state="FIELD"]')
        second = self.page.locator("svg .node").evaluate_all(
            "nodes => nodes.map(node => node.getAttribute('transform'))")
        self.assertEqual(first, second)

        self.open_state("#mode=field&focus=concept%3Aidempotency", "FIELD")
        self.page.wait_for_selector("#details:not([hidden])")
        selected_before = self.page.locator("svg .node.selected").get_attribute("transform")
        viewport_before = self.page.locator("svg .viewport").get_attribute("transform")
        self.page.reload(wait_until="domcontentloaded")
        self.page.wait_for_selector('#main[data-state="FIELD"]')
        self.page.wait_for_selector("#details:not([hidden])")
        self.assertEqual(1, self.page.locator("svg .node.selected").count())
        self.assertEqual(
            selected_before,
            self.page.locator("svg .node.selected").get_attribute("transform"),
        )
        self.assertEqual(
            viewport_before,
            self.page.locator("svg .viewport").get_attribute("transform"),
        )


if __name__ == "__main__":
    unittest.main()
