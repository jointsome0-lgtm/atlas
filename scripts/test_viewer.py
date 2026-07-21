import functools
import http.server
import json
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import quote

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


ROOT = Path(__file__).resolve().parents[1]
DEMO_GRAPH = ROOT / "fixtures" / "demo-graph" / "atlas-graph.json"


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
        return {
            "format": "atlas-graph",
            "version": version,
            "nodes": [] if nodes is None else nodes,
            "edges": [] if edges is None else edges,
            "trails": [],
            "state": {},
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

        self.write_graph(self.graph_envelope(version=7))
        self.open_state("#mode=field", "UNSUPPORTED_VERSION")
        self.assertIn("format version 7", self.page.locator("#main").inner_text())

        self.write_graph(self.graph_envelope())
        self.open_state("#mode=field", "EMPTY")
        self.assertIn("This graph has no nodes yet", self.page.locator("#main").inner_text())

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
        alone = {
            "id": "concept:alone", "type": "concept", "title": "Alone",
            "fields": ["knowledge"], "aliases": [],
        }
        other = {
            "id": "concept:other", "type": "concept", "title": "Other",
            "fields": ["knowledge"], "aliases": [],
        }
        related = {
            "source": "concept:alone", "target": "concept:other",
            "type": "related_to", "provenance": ["concept:alone"],
            "weight": "unassessed",
        }
        variants = {
            "duplicate node id": self.graph_envelope(nodes=[alone, dict(alone)]),
            "dangling provenance": self.graph_envelope(
                nodes=[alone, other],
                edges=[{**related, "provenance": ["concept:absent"]}]),
            "duplicate edge identity": self.graph_envelope(
                nodes=[alone, other], edges=[related, dict(related)]),
            "living formerly redirect": self.graph_envelope(
                nodes=[alone, {**other, "formerly": ["concept:alone"]}]),
            "1-to-n formerly redirect": self.graph_envelope(
                nodes=[{**alone, "formerly": ["concept:old"]},
                       {**other, "formerly": ["concept:old"]}]),
        }
        for name, graph in variants.items():
            with self.subTest(variant=name):
                self.write_graph(graph)
                self.open_state("#mode=field", "REJECTED")

    def test_duplicate_json_keys_reject_whole(self):
        text = (
            '{"format": "atlas-graph", "version": 1, "nodes": [], "nodes": [],'
            ' "edges": [], "trails": [], "state": {}, "influence": {},'
            ' "frontier": [], "projections": {}}'
        )
        self.graph_path.write_text(text, encoding="utf-8")
        self.open_state("#mode=field", "REJECTED")

    def test_node_link_ceiling_uses_fixed_pr2_state(self):
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
        self.open_state("#mode=field", "NODE_LINK_CEILING")
        self.assertEqual(
            "2401 nodes is past the node-link ceiling (2,400). The list view shows them.",
            self.page.locator("#main").inner_text(),
        )

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
        self.assertEqual(len(visible_edges), self.page.locator("svg .edge-line").count())
        self.assertIn(
            f"{len(visible_ids)} nodes · {len(visible_edges)} edges in view",
            self.page.locator("#status-bar").inner_text(),
        )
        self.assertIn("as of 2026-07-10", self.page.locator("#status-bar").inner_text())
        initial_hash = self.page.evaluate("location.hash")
        self.page.locator("#routes-toggle").uncheck()
        self.page.wait_for_selector('#main[data-state="FIELD"]')
        self.assertLess(
            self.page.locator("svg .edge-line").count(), len(visible_edges))
        self.assertEqual(initial_hash, self.page.evaluate("location.hash"))

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
