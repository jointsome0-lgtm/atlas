import functools
import http.server
import json
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


ROOT = Path(__file__).resolve().parents[1]
DEMO_GRAPH = ROOT / "fixtures" / "demo-graph" / "atlas-graph.json"
VIEWER_ACCEPTANCE = ROOT / "fixtures" / "viewer-acceptance"
UNSUPPORTED_VERSION_FIXTURE = VIEWER_ACCEPTANCE / "unsupported-version.json"
REJECTED_ACCEPTANCE = VIEWER_ACCEPTANCE / "rejected"
EXPECTED_REJECTED_FIXTURES = {
    "dangling-provenance.json",
    "discriminant-on-wrong-edge-type.json",
    "duplicate-edge-identity.json",
    "duplicate-node-id.json",
    "formerly-on-journal-backed-kind.json",
    "kind-changing-formerly-redirect.json",
    "living-formerly-redirect.json",
    "one-to-n-formerly-redirect.json",
    "primary-supporting-role-conflict.json",
    "reversed-related-to-pair.json",
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
                shutil.copyfile(REJECTED_ACCEPTANCE / name, self.graph_path)
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
        def headings():
            return [text.lower() for text in
                    self.page.locator("#details .edge-groups h3").all_inner_texts()]

        self.assertIn("step_of_route", headings())
        self.page.locator("#routes-toggle").click()
        self.page.wait_for_selector('#main[data-state="LIST"]')
        without_routes = headings()
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
            ["routes (hideable)", "trail", "authored (opacity shows weight)", "structure",
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
