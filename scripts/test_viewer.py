import datetime
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

import build_atlas_graph

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
    # §14.7/#108: last_seen equals the as-of, so the derivation says fresh and
    # the file says stale. Everything else about the entry is valid, which is
    # the point — the class is the only defect, and an exact recompute is the
    # only check that can see it (a monotonicity rule has one entry to compare).
    "state-freshness-not-derived.json": {
        "path": "/state/freshness", "rule": "derivedFreshness"},
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

    def chain_graph(self):
        # a — b — c — d, plus one node joined to a by a suggested step alone
        # and one joined to nothing at all. The route and its plan carry the
        # step's context and are themselves unjoined.
        nodes = [
            {"id": f"concept:{name}", "type": "concept", "title": name.title(),
             "fields": ["knowledge"], "aliases": []}
            for name in ("a", "b", "c", "d", "far", "island")
        ]
        nodes.append({
            "id": "suggested-route:chain", "type": "suggested_route",
            "title": "Chain route", "status": "available",
            "source_plan": "plan:chain", "fields": ["knowledge"],
        })
        nodes.append({
            "id": "plan:chain", "type": "plan", "title": "Chain plan",
            "fields": ["knowledge"],
        })
        edges = [
            {"source": f"concept:{left}", "target": f"concept:{right}",
             "type": "related_to", "provenance": [f"concept:{left}"],
             "weight": "unassessed"}
            for left, right in (("a", "b"), ("b", "c"), ("c", "d"))
        ]
        edges.append({
            "source": "concept:a", "target": "concept:far",
            "type": "suggested_next", "provenance": ["suggested-route:chain"],
            "context": "suggested-route:chain",
        })
        return self.graph_envelope(nodes=nodes, edges=edges)

    def drawn_ids(self):
        return sorted(self.page.locator("svg .node").evaluate_all(
            "nodes => nodes.map(node => node.dataset.nodeId)"))

    def test_focus_horizon_draws_the_named_hops_and_says_the_field_goes_on(self):
        # Fog of war: past the horizon nothing is drawn, and nothing stands in
        # for it (A5, A11). The status line says the field continues, so the
        # dark never reads as the edge of the field — and says it without a
        # number: a running count of what lies ahead is a backlog reading, and
        # this system refuses those (§3, §4). Where the field continues is the
        # stubs' job, not the status line's.
        self.write_graph(self.chain_graph())
        self.open_state("#mode=field&focus=concept:a", "FIELD")
        horizon = self.page.locator("#horizon-select")
        self.assertEqual("all", horizon.input_value())
        self.assertEqual(8, len(self.drawn_ids()))
        self.assertNotIn("past the focus horizon",
                         self.page.locator("#status-bar").inner_text())

        horizon.select_option("1")
        self.page.wait_for_function(
            "() => document.querySelectorAll('svg .node').length === 3")
        self.assertEqual(
            ["concept:a", "concept:b", "concept:far"], self.drawn_ids())
        status = self.page.locator("#status-bar").inner_text()
        self.assertIn("the field continues past the focus horizon", status)
        # No count of what is being kept out, in any wording.
        self.assertNotRegex(status.split("continues past")[1], r"\d")

        horizon.select_option("2")
        self.page.wait_for_function(
            "() => document.querySelectorAll('svg .node').length === 4")
        self.assertEqual(
            ["concept:a", "concept:b", "concept:c", "concept:far"],
            self.drawn_ids())

        # An unjoined node is never inside any horizon, however wide.
        horizon.select_option("3")
        self.page.wait_for_function(
            "() => document.querySelectorAll('svg .node').length === 5")
        self.assertNotIn("concept:island", self.drawn_ids())

    def test_the_list_carries_the_whole_field_past_a_horizon(self):
        # §16.3 bounds the node-link view alone. The list is A11's fallback and
        # carries the field's channels as columns, so a hop radius must not
        # thin it: a cut relation has a stub in the picture and would have
        # nothing at all here.
        self.write_graph(self.chain_graph())
        self.open_state("#mode=field&focus=concept:a", "FIELD")
        self.page.locator("#horizon-select").select_option("1")
        self.page.wait_for_function(
            "() => document.querySelectorAll('svg .node').length === 3")
        self.page.locator("#list-view").click()
        self.page.wait_for_selector(".node-list-row")
        self.assertEqual(8, self.page.locator(".node-list-row").count())
        # A control that cannot act must not read as though it could.
        self.assertTrue(self.page.locator("#horizon-select").is_disabled())
        self.assertNotIn("past the focus horizon",
                         self.page.locator("#status-bar").inner_text())

    def oversized_focused_field(self):
        nodes = [
            {"id": f"concept:n-{index}", "type": "concept",
             "title": f"Node {index}", "fields": ["knowledge"], "aliases": []}
            for index in range(2401)
        ]
        edges = [
            {"source": "concept:n-0", "target": f"concept:n-{index}",
             "type": "related_to", "provenance": ["concept:n-0"],
             "weight": "unassessed"}
            for index in range(1, 4)
        ]
        self.write_graph(self.graph_envelope(nodes=nodes, edges=edges))
        self.open_state("#mode=field&focus=concept:n-0", "LIST")

    def test_a_horizon_holding_a_hub_back_still_meets_the_ceiling(self):
        # A hop radius can leave two plates in view and the whole rest of the
        # field cut at the rim — and every cut relation is drawn: a group, a
        # stroke, a hit band and a label apiece. Counting plates alone lets a
        # hub slip under §25.8's line and hand the frame a hundred thousand
        # marks it never agreed to.
        nodes = [
            {"id": f"concept:h-{index}", "type": "concept",
             "title": f"Node {index}", "fields": ["knowledge"], "aliases": []}
            for index in range(3000)
        ]
        edges = [{"source": "concept:h-0", "target": "concept:h-1",
                  "type": "related_to", "provenance": ["concept:h-0"],
                  "weight": "unassessed"}]
        edges += [
            {"source": "concept:h-1", "target": f"concept:h-{index}",
             "type": "related_to", "provenance": ["concept:h-1"],
             "weight": "unassessed"}
            for index in range(2, 3000)
        ]
        # §20.3: the builder emits relations in canonical identity order, and
        # the viewer rejects a shuffle rather than lay one out input-driven.
        edges.sort(key=lambda edge: (edge["type"], edge["source"], edge["target"]))
        self.write_graph(self.graph_envelope(nodes=nodes, edges=edges))
        self.open_state("#mode=field&focus=concept:h-0", "LIST")
        self.page.locator("#horizon-select").select_option("1")
        # Two plates in view, and the fallback still holds: the rim is the
        # rest of the field.
        self.page.wait_for_selector('#main[data-state="LIST"]')
        self.assertTrue(self.page.locator("#graph-view").is_disabled())

    def test_a_horizon_can_bring_an_oversized_field_back_into_the_picture(self):
        # Past the ceiling the list is forced, and the radius is the one
        # control that can bring the field back under it. Standing it down
        # there would shut the reader out of the node-link view for exactly
        # the fields a bounded one serves best.
        self.oversized_focused_field()
        horizon = self.page.locator("#horizon-select")
        self.assertFalse(horizon.is_disabled())
        horizon.select_option("1")
        self.page.wait_for_selector("#main[data-state='FIELD']")
        self.assertEqual(4, len(self.drawn_ids()))
        self.assertFalse(self.page.locator("#graph-view").is_disabled())

    def test_asking_for_the_list_the_ceiling_forced_is_not_a_locked_door(self):
        # The forced fallback already reads as the list, so the reader may well
        # press the list again — and that press is a lens the reader chose,
        # which is the state the radius stands down for. With the graph shut by
        # the ceiling and the radius shut by the press, there would be no way
        # back to the picture at all.
        self.oversized_focused_field()
        self.page.locator("#list-view").click()
        self.page.wait_for_selector("#main[data-state='LIST']")
        horizon = self.page.locator("#horizon-select")
        self.assertFalse(horizon.is_disabled())
        horizon.select_option("1")
        # The reader is still in the list they asked for, but the field under
        # the radius fits the picture again and the way back is open.
        self.page.wait_for_selector("#graph-view:not([disabled])")
        self.page.locator("#graph-view").click()
        self.page.wait_for_selector("#main[data-state='FIELD']")
        self.assertEqual(4, len(self.drawn_ids()))

    def test_focus_horizon_walks_only_the_edges_in_view(self):
        # Hops are counted over what the reader can see: with routes hidden a
        # node joined only by a route step is not one hop away, because the
        # step that would make it one is not on the screen.
        self.write_graph(self.chain_graph())
        self.open_state("#mode=field&focus=concept:a", "FIELD")
        self.page.locator("#horizon-select").select_option("1")
        self.page.wait_for_function(
            "() => document.querySelectorAll('svg .node').length === 3")
        self.assertIn("concept:far", self.drawn_ids())

        self.page.locator("#routes-toggle").click()
        self.page.wait_for_function(
            "() => document.querySelectorAll('svg .node').length === 2")
        self.assertEqual(["concept:a", "concept:b"], self.drawn_ids())

    def test_an_edge_leaving_the_horizon_is_drawn_as_far_as_the_view_reaches(self):
        # #99: a shown boundary is a drawn boundary. The edge b — c leaves the
        # one-hop view, so b keeps a stub pointing outward instead of looking
        # like a node with no further relations. The stub carries family and
        # nothing else — no arrowhead at an absent target, no weight tick at a
        # midpoint that is off screen (A3, A5).
        self.write_graph(self.chain_graph())
        self.open_state("#mode=field&focus=concept:a", "FIELD")
        self.assertEqual(0, self.page.locator("svg .edge-stub").count())

        self.page.locator("#horizon-select").select_option("1")
        self.page.wait_for_function(
            "() => document.querySelectorAll('svg .node').length === 3")
        stubs = self.page.locator("svg .edge-stub")
        self.assertEqual(1, stubs.count())
        self.assertIn("edge-authored", stubs.first.get_attribute("class"))
        self.assertIsNone(stubs.first.get_attribute("marker-end"))
        self.assertEqual(
            0, self.page.locator("svg .edge-stub-group .edge-weight").count())

        # The stub starts outside its own plate and runs away from the focus,
        # so it never doubles back over the picture it came from.
        reach = self.page.evaluate(
            """() => {
                const focus = document.querySelector(
                    "svg .node[data-node-id='concept:a']");
                const at = (el) => el.getAttribute("transform")
                    .match(/translate\\(([-\\d.]+) ([-\\d.]+)\\)/).slice(1).map(Number);
                const [fx, fy] = at(focus);
                const stub = document.querySelector("svg .edge-stub");
                const x1 = Number(stub.getAttribute("x1"));
                const y1 = Number(stub.getAttribute("y1"));
                const x2 = Number(stub.getAttribute("x2"));
                const y2 = Number(stub.getAttribute("y2"));
                return {near: Math.hypot(x1 - fx, y1 - fy),
                        far: Math.hypot(x2 - fx, y2 - fy)};
            }""")
        self.assertGreater(reach["far"], reach["near"])

        # A relation the reader cannot see leaves no stub behind: with routes
        # hidden the step a — far is not cut, it is simply not a relation on
        # the screen, so only the authored b — c still reaches outward.
        self.page.locator("#routes-toggle").click()
        self.page.wait_for_function(
            "() => document.querySelectorAll('svg .node').length === 2")
        self.assertEqual(1, self.page.locator("svg .edge-stub").count())
        self.assertEqual(
            0, self.page.locator("svg .edge-stub.edge-route").count())

    # Colours are authored in oklch and getComputedStyle hands that back
    # verbatim, so contrast has to be measured through a canvas, which is the
    # one place the browser will resolve a colour to the bytes it paints.
    # Each family recedes to the same quiet level, so each is measured with
    # its own token: colour, its recession, and the floor they all answer to.
    RECEDING_FAMILIES = [
        ("--e-authored", "--recede-authored"),
        ("--e-derived", "--recede-derived"),
        ("--e-route", "--recede-route"),
    ]

    CONTRAST_JS = """(names) => {
      const ctx = document.createElement("canvas")
        .getContext("2d", {willReadFrequently: true});
      const rgb = (value) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = "#000";
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      const lin = (c) => {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
      const ratio = (a, b) => {
        const pair = [lum(a), lum(b)].sort((x, y) => y - x);
        return (pair[0] + 0.05) / (pair[1] + 0.05);
      };
      const root = getComputedStyle(document.documentElement);
      const token = (name) => rgb(root.getPropertyValue(name).trim());
      const ground = token("--ground");
      // The threshold is what a rule carries on the surface a rule is drawn
      // on; the recession is measured on the surface an edge is drawn on,
      // read off the graph itself rather than named, so moving the field's
      // background moves the measurement with it.
      const surface = rgb(getComputedStyle(
        document.querySelector("svg.graph-svg")).backgroundColor);
      const out = {
        rule: ratio(token("--rule"), ground), receded: {}, alphas: {},
        surface: surface.join(","), ground: ground.join(","),
      };
      for (const pair of names) {
        const fg = token(pair[0]);
        const alpha = Number(root.getPropertyValue(pair[1]));
        out.alphas[pair[0]] = alpha;
        out.receded[pair[0]] = ratio(
          fg.map((c, at) => alpha * c + (1 - alpha) * surface[at]), surface);
      }
      return out;
    }"""

    def edge_strokes(self):
        return self.page.evaluate(
            """() => [...document.querySelectorAll("svg .edge-line")].map((line) => {
                const s = getComputedStyle(line);
                return [s.stroke, s.strokeWidth, s.strokeDasharray,
                        line.getAttribute("marker-end") || ""].join("|");
            })""")

    def incident_pairs(self):
        return sorted(self.page.locator("svg .edge-group.incident").evaluate_all(
            """groups => groups.map(
                (g) => g.dataset.source + " " + (g.dataset.target || ""))"""))

    def test_a_selection_answers_with_the_relations_that_touch_it(self):
        # §16.2 A9's focus feedback: picking a node lights the relations it
        # stands in by quieting the ones it does not, so the reader sees what
        # they picked joined to something rather than a ring on one plate.
        self.open_state("#mode=field", "FIELD")
        self.assertEqual(0, self.page.locator("svg .viewport.has-selection").count())
        self.assertEqual(0, self.page.locator("svg .edge-group.incident").count())

        self.open_state("#mode=field&focus=concept:http-methods", "FIELD")
        self.assertEqual(1, self.page.locator("svg .viewport.has-selection").count())
        self.assertEqual(
            ["concept:http-methods concept:rest-api",
             "concept:http-methods question:demo-when-is-retry-safe",
             "material:mdn-http-methods concept:http-methods",
             "part:fastapi-tutorial/path-operations concept:http-methods",
             "part:mdn-http-methods/idempotency concept:http-methods"],
            self.incident_pairs())

        # The quiet is a floor, not a disappearance: a receded relation still
        # answers the hand, and the panel names every one of them in words (A8).
        # Read once the quiet has settled — A9 gives focus feedback the one
        # transition there is, so the opacity is on its way for a moment.
        self.page.wait_for_timeout(300)
        receded = self.page.evaluate(
            """() => {
                const root = getComputedStyle(document.documentElement);
                const viewport = document.querySelector(".viewport");
                const screen = Number(getComputedStyle(viewport)
                    .getPropertyValue("--screen-scale"));
                const out = {};
                for (const group of viewport.querySelectorAll(
                        ".edge-group:not(.incident)")) {
                    const family = group.dataset.family;
                    if (family === "trail") continue;
                    const token = family === "authored" ? "--recede-authored"
                        : family === "route" ? "--recede-route"
                        : "--recede-derived";
                    // The amount as it lands, not as it is written: a stroke
                    // under a pixel paints its width, and the sheet divides
                    // the amount by that before spending it.
                    const style = getComputedStyle(group.querySelector(".edge-line"));
                    const laid = Math.min(1, Number.parseFloat(style.strokeWidth) * screen)
                        * Number(style.opacity);
                    out[family] = [laid, Number(root.getPropertyValue(token))];
                }
                return out;
            }""")
        self.assertGreater(len(receded), 1)
        for family, (drawn, authored) in receded.items():
            self.assertAlmostEqual(
                authored, drawn, 2,
                f"{family} does not recede to its own token")
        panel = self.page.locator("#details").inner_text()
        for named in ("concept:rest-api", "part:mdn-http-methods/idempotency"):
            self.assertIn(named, panel)

        # Moving the selection moves the lit set with it, and clearing it
        # returns the field whole.
        self.page.locator("#close-details").click()
        self.page.wait_for_selector("svg .viewport:not(.has-selection)")
        self.assertEqual(0, self.page.locator("svg .edge-group.incident").count())

    def test_the_emphasis_spends_no_family_channel(self):
        # A3 tripwire: stroke colour, dash and width carry edge family and
        # nothing else. Whatever a selection does to the picture, it may not
        # touch them — element for element. The emphasis is switched on the
        # standing picture rather than by opening a second address, so the
        # camera is identical and only the emphasis differs.
        self.open_state("#mode=field&focus=concept:http-methods", "FIELD")
        lit = self.edge_strokes()
        self.page.evaluate(
            """() => document.querySelector("svg .viewport")
                .classList.remove("has-selection")""")
        self.assertEqual(lit, self.edge_strokes())

    def test_the_trail_never_recedes_behind_a_selection(self):
        # A7: a suggested route never renders brighter than the trail it
        # parallels. A route touching the selection beside a trail edge that
        # does not is exactly that inversion, so the trail is exempt — the
        # reader's real path is the one thing the looking never dims.
        self.open_state("#mode=field&focus=concept:http-methods", "FIELD")
        trails = self.page.locator(
            'svg .edge-group[data-family="trail"]:not(.incident)')
        self.assertGreater(trails.count(), 0)
        self.assertEqual(
            ["1"] * trails.count(),
            trails.evaluate_all(
                """groups => groups.map((g) => getComputedStyle(
                    g.querySelector(".edge-line")).opacity)"""))

    def test_a_receded_relation_is_still_a_drawn_relation(self):
        # The recession is bounded by the sheet's own hairline: no family may
        # fall below the presence --rule already carries, that being the
        # faintest line this design draws on purpose. Below it the channel has
        # not receded, it has dropped — and dropping belongs to A11's fixed
        # order and to the focus horizon, never to a selection.
        # Both palettes: the two surfaces sit on opposite sides of the ground
        # in light and in dark, so an amount calibrated on one is calibrated on
        # neither.
        for scheme in ("light", "dark"):
            with self.subTest(scheme=scheme):
                self.context.close()
                self.context = self.browser.new_context(color_scheme=scheme)
                self.page = self.context.new_page()
                self.open_state("#mode=field&focus=concept:http-methods", "FIELD")
                self.assert_recession_clears_the_rule()

    def assert_recession_clears_the_rule(self):
        measured = self.page.evaluate(self.CONTRAST_JS, self.RECEDING_FAMILIES)
        # The field is not the panel: an edge paints on --page and the plates
        # are the --ground above it, so a recession calibrated on --ground is
        # calibrated on a surface no relation touches.
        self.assertNotEqual(measured["ground"], measured["surface"])
        for name, ratio in measured["receded"].items():
            self.assertGreater(measured["alphas"][name], 0)
            self.assertGreaterEqual(
                ratio, measured["rule"],
                f"{name} recedes below --rule: {ratio:.2f} < {measured['rule']:.2f}")
        # And they recede TO that level, not merely above it: one shared
        # amount would leave the darkest family darker than an undimmed faint
        # one, which is the reading failing to carry.
        quiet = list(measured["receded"].values())
        self.assertLess(max(quiet) - min(quiet), 0.25 * measured["rule"])

    LABEL_INK_JS = """() => {
      const svg = document.querySelector("svg.graph-svg");
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return {left: r.left, right: r.right, top: r.top, bottom: r.bottom};
      };
      const hits = (a, b) => a.left < b.right && b.left < a.right
        && a.top < b.bottom && b.top < a.bottom;
      const drawn = [...svg.querySelectorAll(".node")].map((group) => ({
        id: group.dataset.nodeId,
        plate: rect(group.querySelector(".node-shape")),
        label: rect(group.querySelector(".node-label")),
      }));
      const overlaps = [];
      for (const label of drawn) {
        for (const plate of drawn) {
          if (label.id === plate.id) continue;
          if (hits(label.label, plate.plate)) overlaps.push(label.id);
        }
      }
      return {count: drawn.length, overlaps};
    }"""

    def wide_titled_field(self, title, count=11):
        # A chain of eleven, which the seeded layout spreads far enough that
        # every one of these labels has a free slot to be put in. So a label
        # sitting on a plate here is the estimate being wrong and not the
        # field being full — the sweep never drops a label, it falls back.
        nodes = [
            {"id": f"concept:w{index:02d}", "type": "concept",
             "title": title, "fields": ["knowledge"], "aliases": []}
            for index in range(count)
        ]
        edges = [
            {"source": f"concept:w{index:02d}",
             "target": f"concept:w{index + 1:02d}",
             "type": "related_to", "provenance": [f"concept:w{index:02d}"],
             "weight": "unassessed"}
            for index in range(len(nodes) - 1)
        ]
        self.write_graph(self.graph_envelope(nodes=nodes, edges=edges))
        self.open_state("#mode=field", "FIELD")

    def test_a_title_of_wide_glyphs_reserves_the_room_it_takes(self):
        # The label box is estimated, never measured — the picture is seeded
        # (§27.8) and a measured string would follow whichever font the reader
        # resolves. But one mean advance per glyph is an estimate that only
        # holds for mixed-case Latin: a title of full-width script, or of the
        # widest Latin capitals, takes about twice it, and the sweep then
        # accepts a slot the text runs straight out of and onto a plate.
        for title in ("知识图谱与检索增强生成模型学习", "W" * 15):
            with self.subTest(title=title):
                self.wide_titled_field(title)
                drawn = self.page.evaluate(self.LABEL_INK_JS)
                self.assertEqual(11, drawn["count"])
                self.assertEqual([], drawn["overlaps"])

    def test_a_title_at_the_boundary_is_inside_the_opening_frame(self):
        # The opening fit is what the reader is handed before touching
        # anything. A label is drawn beside its plate and reaches further out
        # than the plate does, so a fit taken from the radii alone hands a
        # boundary node's title to the edge of the frame and cuts it there —
        # with no tier having dropped it and nothing said (A11).
        self.page.set_viewport_size({"width": 700, "height": 900})
        self.wide_titled_field("W" * 15, count=40)
        outside = self.page.evaluate(
            """() => {
                const svg = document.querySelector("svg.graph-svg")
                    .getBoundingClientRect();
                return [...document.querySelectorAll("svg .node-label")]
                    // A tier that dropped a label leaves nothing drawn, and an
                    // undrawn box is not a clipped one (A11).
                    .map((label) => label.getBoundingClientRect())
                    .filter((box) => box.width > 0)
                    .map((box) => Math.max(
                        svg.left - box.left, box.right - svg.right,
                        svg.top - box.top, box.bottom - svg.bottom))
                    .filter((over) => over > 0.5);
            }""")
        self.assertEqual([], outside)

    def test_the_emphasis_stands_down_under_forced_colours(self):
        # The system palette has no rank below its own text, so there is no
        # quieter level left that still clears the rule. Rather than break the
        # floor the emphasis stops being drawn; the selection still answers
        # through the ring and through the panel's words (A8).
        self.context.close()
        self.context = self.browser.new_context(forced_colors="active")
        self.page = self.context.new_page()
        self.open_state("#mode=field&focus=concept:http-methods", "FIELD")
        self.assertEqual(1, self.page.locator("svg .node.selected").count())
        self.assertEqual(
            ["1"] * 3,
            self.page.evaluate(
                """() => {
                    const root = getComputedStyle(document.documentElement);
                    return ["--recede-authored", "--recede-derived",
                            "--recede-route"].map(
                        (name) => String(Number(root.getPropertyValue(name))));
                }"""))
        opacities = self.page.locator("svg .edge-group .edge-line").evaluate_all(
            "lines => [...new Set(lines.map("
            "(l) => getComputedStyle(l).opacity))]")
        self.assertEqual(["1"], opacities)

    LANE_TRIM_JS = """() => {
      const centre = (id) => {
        const [x, y] = document
          .querySelector(`svg .node[data-node-id="${id}"]`)
          .getAttribute("transform").match(/-?[\\d.]+/g).map(Number);
        return {x, y};
      };
      const a = centre("concept:alpha"), b = centre("concept:beta");
      const span = Math.hypot(b.x - a.x, b.y - a.y);
      const unit = {x: (b.x - a.x) / span, y: (b.y - a.y) / span};
      const along = (x, y) => (x - a.x) * unit.x + (y - a.y) * unit.y;
      // How far along the pair's own axis each stroke starts, alpha's side,
      // whichever way the relation points.
      return [...document.querySelectorAll(".edge-group")].map((group) => {
        const hit = group.querySelector(".edge-hit");
        return Math.min(along(hit.x1.baseVal.value, hit.y1.baseVal.value),
                        along(hit.x2.baseVal.value, hit.y2.baseVal.value));
      });
    }"""

    def test_a_lane_is_trimmed_for_the_ray_it_actually_draws(self):
        # The trim clears everything the plate draws along the ray. A lane has
        # moved that ray off the centre, where it leaves the plate sooner and
        # can meet a mark the centre ray passed by — so the marks move under
        # the offset ray rather than the centre extent being reused.
        nodes = [
            {"id": "concept:alpha", "type": "concept", "title": "Alpha",
             "fields": ["knowledge"], "aliases": []},
            {"id": "concept:beta", "type": "concept", "title": "Beta",
             "fields": ["knowledge"], "aliases": []},
        ]
        forward = {"type": "prerequisite_of", "source": "concept:alpha",
                   "target": "concept:beta", "provenance": ["concept:alpha"],
                   "weight": "unassessed"}
        back = {"type": "prerequisite_of", "source": "concept:beta",
                "target": "concept:alpha", "provenance": ["concept:beta"],
                "weight": "unassessed"}

        self.write_graph(self.graph_envelope(nodes=nodes, edges=[forward]))
        self.open_state("#mode=field", "FIELD")
        centred = self.page.evaluate(self.LANE_TRIM_JS)
        self.assertEqual(1, len(centred))

        self.write_graph(self.graph_envelope(nodes=nodes, edges=[forward, back]))
        self.open_state("#mode=field", "FIELD")
        laned = self.page.evaluate(self.LANE_TRIM_JS)
        self.assertEqual(2, len(laned))
        # A parallel offset cuts a chord, so an offset ray leaves the plate
        # sooner than the centre one — reusing the centre extent would trim
        # both the same and let the stroke run under whatever it passed.
        for trim in laned:
            self.assertGreater(centred[0] - trim, 0.2)

    def test_a_reciprocal_pair_of_relations_takes_two_lanes(self):
        # a→b and b→a are both allowed, and each says its own thing. Drawn on
        # the one axis they stack exactly and the field shows one claim where
        # the graph holds two, so the lane offset is taken along the pair's own
        # axis rather than along each edge's direction.
        nodes = [
            {"id": "concept:alpha", "type": "concept", "title": "Alpha",
             "fields": ["knowledge"], "aliases": []},
            {"id": "concept:beta", "type": "concept", "title": "Beta",
             "fields": ["knowledge"], "aliases": []},
        ]
        edges = [
            {"type": "prerequisite_of", "source": "concept:alpha",
             "target": "concept:beta", "provenance": ["concept:alpha"],
             "weight": "unassessed"},
            {"type": "prerequisite_of", "source": "concept:beta",
             "target": "concept:alpha", "provenance": ["concept:beta"],
             "weight": "unassessed"},
        ]
        self.write_graph(self.graph_envelope(nodes=nodes, edges=edges))
        self.open_state("#mode=field", "FIELD")
        # Measured across the axis, not along it: differing end trims already
        # move the two strokes lengthwise, and that is not a lane.
        apart = self.page.evaluate(
            """() => {
                const centre = (id) => {
                    const node = document.querySelector(
                        `svg .node[data-node-id="${id}"]`);
                    const [x, y] = node.getAttribute("transform")
                        .match(/-?[\\d.]+/g).map(Number);
                    return {x, y};
                };
                const a = centre("concept:alpha"), b = centre("concept:beta");
                const span = Math.hypot(b.x - a.x, b.y - a.y);
                const unit = {x: (b.x - a.x) / span, y: (b.y - a.y) / span};
                const mids = [...document.querySelectorAll("svg .edge-group")]
                    .map((group) => group.querySelector(".edge-line"))
                    .map((line) => ({
                        x: (line.x1.baseVal.value + line.x2.baseVal.value) / 2,
                        y: (line.y1.baseVal.value + line.y2.baseVal.value) / 2
                    }));
                if (mids.length !== 2) return null;
                const gap = {x: mids[1].x - mids[0].x, y: mids[1].y - mids[0].y};
                const along = gap.x * unit.x + gap.y * unit.y;
                return Math.hypot(gap.x - along * unit.x, gap.y - along * unit.y);
            }""")
        self.assertIsNotNone(apart, "expected exactly two drawn relations")
        self.assertGreater(apart, 5)

    def test_a_pan_over_bare_ground_keeps_the_selection(self):
        # Taking hold of the picture is not letting go of the node: dragging
        # the ground moves the camera and nothing else.
        self.open_state("#mode=field&focus=concept:http-methods", "FIELD")
        self.assertEqual(1, self.page.locator("svg .node.selected").count())
        moved = self.drag_ground(120, 60)
        self.assertGreater(moved, 50)
        self.page.wait_for_timeout(250)
        self.assertEqual(1, self.page.locator("svg .node.selected").count())
        self.assertEqual(1, self.page.locator("svg .viewport.has-selection").count())
        self.assertFalse(self.page.locator("#details").is_hidden())

    def test_a_press_that_shakes_leaves_the_camera_where_it_was(self):
        # A hand wobbles a pixel or two on the way to a click. That is a press,
        # so the picture holds still; otherwise every click nudges the field
        # and the nudges accumulate.
        self.open_state("#mode=field", "FIELD")
        self.assertEqual(0.0, self.drag_ground(1, 1))
        self.assertEqual(0.0, self.drag_ground(-2, 1))

    def test_a_press_that_shakes_in_place_still_opens_the_node(self):
        # A shake is not a journey. Six wobbles inside one pixel add up past
        # the slop only if the path is summed, and then the press becomes a
        # pan: the plate under the hand never opens and the camera drifts.
        # The real mouse, because the point is the click the browser would
        # have synthesised.
        self.open_state("#mode=field", "FIELD")
        spot = self.hit_point(".node-shape")
        self.assertIsNotNone(spot, "no reachable plate")
        before = self.viewport_transform()
        x, y = spot
        self.page.mouse.move(x, y)
        self.page.mouse.down()
        for dx, dy in ((1, 0), (0, 0), (1, 1), (0, 1), (1, 0), (0, 0)):
            self.page.mouse.move(x + dx, y + dy)
        self.page.mouse.up()
        self.page.wait_for_timeout(250)
        self.assertEqual(1, self.page.locator("svg .node.selected").count())
        self.assertIn("focus=", urlsplit(self.page.url).fragment)
        self.assertEqual(before, self.viewport_transform())

    DRAG_JS = """([dx, dy]) => {
      const svg = document.querySelector("svg.graph-svg");
      const before = document.querySelector(".viewport").getAttribute("transform");
      const box = svg.getBoundingClientRect();
      const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
      const send = (kind, x, y) => svg.dispatchEvent(new PointerEvent(kind, {
        pointerId: 1, clientX: x, clientY: y, bubbles: true, buttons: 1}));
      send("pointerdown", cx, cy);
      for (let step = 1; step <= 4; step += 1) {
        send("pointermove", cx + dx * step / 4, cy + dy * step / 4);
      }
      send("pointerup", cx + dx, cy + dy);
      svg.dispatchEvent(new MouseEvent("click", {
        clientX: cx + dx, clientY: cy + dy, bubbles: true}));
      const after = document.querySelector(".viewport").getAttribute("transform");
      const read = (value) => value.match(/-?[\\d.]+/g).map(Number);
      const [ax, ay] = read(after), [bx, by] = read(before);
      return Math.abs(ax - bx) + Math.abs(ay - by);
    }"""

    def drag_ground(self, dx, dy):
        """Drag from the middle of the canvas; answer how far the camera went."""
        return self.page.evaluate(self.DRAG_JS, [dx, dy])

    def test_a_relation_recedes_arrowhead_and_all(self):
        # An arrowhead is a marker filled with context-stroke, which copies the
        # stroke's paint but not its opacity, so a recession spent on
        # stroke-opacity leaves bright heads scattered through the quiet.
        self.open_state("#mode=field&focus=concept:http-methods", "FIELD")
        # Read once A9's transition has settled.
        self.page.wait_for_timeout(300)
        marked = self.page.evaluate(
            """() => {
                const group = [...document.querySelectorAll(
                    "svg .edge-group:not(.incident)")].find(
                    (g) => g.dataset.family !== "trail"
                        && g.querySelector(".edge-line").getAttribute("marker-end"));
                if (!group) return null;
                const style = getComputedStyle(group.querySelector(".edge-line"));
                return {opacity: Number(style.opacity),
                        strokeOpacity: Number(style.strokeOpacity)};
            }""")
        self.assertIsNotNone(marked, "no receding directed relation to measure")
        self.assertLess(marked["opacity"], 1)
        self.assertEqual(1, marked["strokeOpacity"])

    def test_a_field_fitted_by_zoom_keeps_a_reachable_hit_band(self):
        # Opening a field larger than the frame drops the zoom floor to the fit
        # (#99/§16.3), and a hit band that scaled with it would be a fraction of
        # a pixel wide — a drawn relation that no hand can reach.
        nodes = [
            {"id": f"concept:n{index:03d}", "type": "concept",
             "title": f"N{index:03d}", "fields": ["knowledge"], "aliases": []}
            for index in range(140)
        ]
        edges = [
            {"source": f"concept:n{index:03d}",
             "target": f"concept:n{index + 1:03d}",
             "type": "related_to", "provenance": [f"concept:n{index:03d}"],
             "weight": "unassessed"}
            for index in range(len(nodes) - 1)
        ]
        self.write_graph(self.graph_envelope(nodes=nodes, edges=edges))
        self.open_state("#mode=field", "FIELD")
        reach = self.page.evaluate(
            """() => {
                const viewport = document.querySelector(".viewport");
                const zoom = Number(viewport.getAttribute("transform")
                    .match(/scale\\(([-\\d.]+)\\)/)[1]);
                const hit = document.querySelector("svg .edge-hit");
                const group = hit.closest(".edge-group");
                const ctm = hit.getScreenCTM();
                const at = (ux, uy) => new DOMPoint(ux, uy).matrixTransform(ctm);
                const a = at(hit.x1.baseVal.value, hit.y1.baseVal.value);
                const b = at(hit.x2.baseVal.value, hit.y2.baseVal.value);
                const mid = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
                const span = Math.hypot(b.x - a.x, b.y - a.y);
                const normal = {x: -(b.y - a.y) / span, y: (b.x - a.x) / span};
                // Walk out along the normal: the last offset that still answers
                // for this relation is the half-band the hand actually has.
                const lands = (offset) => document
                    .elementsFromPoint(mid.x + normal.x * offset,
                                       mid.y + normal.y * offset)
                    .some((el) => el.closest && el.closest(".edge-group") === group);
                const half = () => {
                    let out = 0;
                    while (out < 40 && lands(out + 1)) out += 1;
                    return out;
                };
                const withFloor = half();
                // Neutralise the compensation and measure the same relation
                // again: what a stroke that scaled with the picture would leave.
                const written = viewport.style.getPropertyValue("--screen-scale");
                viewport.style.setProperty("--screen-scale", "1");
                const scaled = half();
                viewport.style.setProperty("--screen-scale", written);
                return {zoom, withFloor, scaled, onEdge: lands(0)};
            }""")
        self.assertLess(reach["zoom"], 1, "expected a field fitted by zoom")
        self.assertTrue(reach["onEdge"], "the middle of a drawn relation is not on it")
        self.assertGreaterEqual(reach["withFloor"], 4)
        self.assertGreater(reach["withFloor"], reach["scaled"])

    # On-screen size of a stroke authored in viewBox units, and the family
    # widths beside it: the picture's own scale times the camera's.
    DRAWN_JS = """() => {
      const svg = document.querySelector("svg.graph-svg");
      const box = svg.getBoundingClientRect();
      const rendered = Math.min(box.width / svg.viewBox.baseVal.width,
                                box.height / svg.viewBox.baseVal.height);
      const zoom = Number(document.querySelector(".viewport")
          .getAttribute("transform").match(/scale\\(([-\\d.]+)\\)/)[1]);
      const probe = document.createElementNS("http://www.w3.org/2000/svg", "line");
      const widths = {};
      for (const family of ["edge-route", "edge-structural", "edge-journal",
                            "edge-authored", "edge-trail"]) {
        probe.setAttribute("class", "edge-line " + family);
        document.querySelector(".viewport").append(probe);
        widths[family] = Number.parseFloat(getComputedStyle(probe).strokeWidth);
      }
      probe.remove();
      const marker = document.getElementById("arrow");
      const head = Number(marker.getAttribute("markerWidth"));
      return {zoom, rendered, widths,
              plate: 2 * Number.parseFloat(getComputedStyle(document.documentElement)
                  .getPropertyValue("--plate-r")),
              head};
    }"""

    def big_field(self, count):
        nodes = [
            {"id": f"concept:n{index:04d}", "type": "concept",
             "title": f"N{index:04d}", "fields": ["knowledge"], "aliases": []}
            for index in range(count)
        ]
        edges = [
            {"source": f"concept:n{index:04d}",
             "target": f"concept:n{index + 1:04d}",
             "type": "related_to", "provenance": [f"concept:n{index:04d}"],
             "weight": "unassessed"}
            for index in range(len(nodes) - 1)
        ]
        self.write_graph(self.graph_envelope(nodes=nodes, edges=edges))
        self.open_state("#mode=field", "FIELD")

    def test_a_field_fitted_by_zoom_still_draws_its_relations(self):
        # A stroke that scales all the way down does not thin, it goes: at the
        # opening fit of a field this size it paints a fortieth of a pixel and
        # no family reaches the contrast a rule carries against the ground.
        # That is omission, and omission belongs to A11's order (§16.3).
        self.big_field(700)
        drawn = self.page.evaluate(self.DRAWN_JS)
        self.assertLess(drawn["zoom"], 0.1, "expected a field far past the fit")
        thinnest = min(drawn["widths"].values())
        # The coverage --e-route needs to carry --rule's contrast on --ground,
        # measured; without the lift this family paints about 0.05.
        self.assertGreaterEqual(thinnest * drawn["zoom"] * drawn["rendered"], 0.5)
        # The lift multiplies each family's own width, so width still carries
        # family alone (A3) — a shared floor would merge these.
        base = drawn["widths"]["edge-route"]
        self.assertAlmostEqual(1.0, drawn["widths"]["edge-structural"] / base, 3)
        self.assertAlmostEqual(1.25, drawn["widths"]["edge-journal"] / base, 3)
        self.assertAlmostEqual(1.5, drawn["widths"]["edge-authored"] / base, 3)
        self.assertAlmostEqual(2.5, drawn["widths"]["edge-trail"] / base, 3)

    def test_a_narrow_embed_keeps_the_floor_and_the_hit_band(self):
        # The frame scales the picture as surely as the camera does (§16.4), so
        # a floor measured in screen pixels has to see both: at half the frame
        # a floor blind to it lands at half the presence it promised.
        self.page.set_viewport_size({"width": 450, "height": 325})
        self.open_state("#mode=field", "FIELD")
        embed = self.page.evaluate(self.DRAWN_JS)
        self.assertLess(embed["rendered"], 0.6, "expected a narrow frame")
        thinnest = min(embed["widths"].values())
        self.assertGreaterEqual(
            thinnest * embed["zoom"] * embed["rendered"], 0.5)
        band = self.page.evaluate(
            """() => {
                const hit = document.querySelector("svg .edge-hit");
                const svg = document.querySelector("svg.graph-svg");
                const rendered = Math.min(
                    svg.getBoundingClientRect().width / svg.viewBox.baseVal.width,
                    svg.getBoundingClientRect().height / svg.viewBox.baseVal.height);
                const zoom = Number(document.querySelector(".viewport")
                    .getAttribute("transform").match(/scale\\(([-\\d.]+)\\)/)[1]);
                return Number.parseFloat(getComputedStyle(hit).strokeWidth)
                    * zoom * rendered;
            }""")
        self.assertGreaterEqual(band, 11.5)

    # What a quieted relation actually lays down: the painted width capped at a
    # pixel is the coverage, and the opacity is spent on top of it.
    QUIET_COVERAGE_JS = """() => {
      const viewport = document.querySelector(".viewport");
      const screen = Number(
        getComputedStyle(viewport).getPropertyValue("--screen-scale"));
      const root = getComputedStyle(document.documentElement);
      // structural and journal are the two derived families; the sheet quiets
      // them by the one derived amount.
      const wanted = {
        authored: Number(root.getPropertyValue("--recede-authored")),
        structural: Number(root.getPropertyValue("--recede-derived")),
        journal: Number(root.getPropertyValue("--recede-derived")),
        route: Number(root.getPropertyValue("--recede-route")),
        trail: 1,
      };
      const out = {screen, families: {}, floored: viewport.classList.contains("floored")};
      for (const group of viewport.querySelectorAll(".edge-group:not(.incident)")) {
        const line = group.querySelector(".edge-line");
        const style = getComputedStyle(line);
        const drawn = Number.parseFloat(style.strokeWidth) * screen;
        const laid = Math.min(1, drawn) * Number(style.opacity);
        const family = group.dataset.family;
        out.families[family] = Math.min(
          out.families[family] === undefined ? Infinity : out.families[family], laid);
      }
      return {...out, wanted};
    }"""

    def test_the_quiet_is_spent_out_of_what_the_stroke_actually_lays_down(self):
        # A stroke narrower than a pixel does not paint a thin line, it paints
        # a pale one — the width is the coverage. So a family already spending
        # part of its presence on being drawn has that much less to spend on
        # being quiet, and the amount measured at full width would take it
        # under §16.3's floor. Three frames: the lift working, the stretch
        # above the hairline where it has not started but the one-unit families
        # are already under a pixel, and the field at its own size.
        for width, height in ((450, 325), (1000, 720), (1280, 900)):
            with self.subTest(frame=f"{width}x{height}"):
                self.page.set_viewport_size({"width": width, "height": height})
                self.open_state("#mode=field&focus=concept:http-methods", "FIELD")
                # Read once A9's transition has settled.
                self.page.wait_for_timeout(300)
                measured = self.page.evaluate(self.QUIET_COVERAGE_JS)
                self.assertGreater(len(measured["families"]), 0)
                for family, laid in measured["families"].items():
                    self.assertGreaterEqual(
                        laid, measured["wanted"][family] - 0.005,
                        f"{family} lays down {laid:.3f} of the "
                        f"{measured['wanted'][family]} the floor asks, "
                        f"at screen scale {measured['screen']}")
        # And the quiet is still a quiet: at its own size the field recedes by
        # exactly the sheet's amounts, the division being the identity there.
        self.assertGreaterEqual(measured["screen"], 1)
        self.assertFalse(measured["floored"])
        for family, laid in measured["families"].items():
            self.assertAlmostEqual(measured["wanted"][family], laid, 2)

    def test_a_lifted_stroke_does_not_cap_back_over_the_plate(self):
        # The endpoints were trimmed to clear the glyph at the width the field
        # was solved at. A round cap runs half the stroke past its endpoint, so
        # once the floor lifts the stroke the cap reaches back over the plate.
        self.big_field(1400)
        capped = self.page.evaluate(self.DRAWN_JS)
        self.assertEqual(
            "butt",
            self.page.evaluate(
                """() => getComputedStyle(
                    document.querySelector("svg .edge-line")).strokeLinecap"""))
        # And the reach a round cap would have had is real, not hypothetical:
        # half the widest lifted stroke against the trim that cleared the plate.
        self.assertGreater(max(capped["widths"].values()) / 2,
                           capped["plate"] / 2 + 2)

    def test_a_field_at_its_own_scale_keeps_its_round_caps(self):
        # The squaring off belongs to the floor alone: a field that opens whole
        # is drawn exactly as authored.
        self.open_state("#mode=field", "FIELD")
        self.assertEqual(
            "round",
            self.page.evaluate(
                """() => getComputedStyle(
                    document.querySelector("svg .edge-line")).strokeLinecap"""))

    def test_a_direction_mark_never_outgrows_the_plate_it_points_at(self):
        # The head is sized in stroke-width units, so the stroke's own lift
        # would multiply it too and the arrow would swallow its target.
        self.big_field(700)
        drawn = self.page.evaluate(self.DRAWN_JS)
        widest = max(drawn["widths"].values())
        self.assertLess(drawn["head"] * widest, drawn["plate"])

    def test_the_family_widths_survive_a_palette_that_drops_the_hairline(self):
        # A variant is a token swap, and one that redeclares the root without
        # this token must not collapse every family onto one width (A3).
        self.open_state("#mode=field", "FIELD")
        self.page.evaluate(
            """() => document.documentElement.style
                .setProperty("--edge-hairline", "initial")""")
        drawn = self.page.evaluate(self.DRAWN_JS)
        base = drawn["widths"]["edge-route"]
        self.assertAlmostEqual(1.25, drawn["widths"]["edge-journal"] / base, 3)
        self.assertAlmostEqual(2.5, drawn["widths"]["edge-trail"] / base, 3)

    def test_a_cancelled_drag_does_not_eat_the_next_click(self):
        # A cancelled pointer sequence synthesises no click, so the suppression
        # a completed pan arms has nothing to clear it — and the reader's next
        # ordinary click is swallowed instead.
        self.open_state("#mode=field", "FIELD")
        self.page.evaluate(
            """() => {
                const svg = document.querySelector("svg.graph-svg");
                const box = svg.getBoundingClientRect();
                const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
                const send = (kind, x, y, extra) => svg.dispatchEvent(
                    new PointerEvent(kind, Object.assign({
                        pointerId: 1, clientX: x, clientY: y,
                        bubbles: true, buttons: 1}, extra || {})));
                send("pointerdown", cx, cy);
                for (let step = 1; step <= 4; step += 1) {
                    send("pointermove", cx + step * 20, cy + step * 10);
                }
                send("pointercancel", cx + 80, cy + 40, {buttons: 0});
            }""")
        self.page.locator(
            'svg .node[data-node-id="concept:idempotency"]').click()
        self.page.wait_for_selector("svg .node.selected")
        self.assertEqual(1, self.page.locator("svg .node.selected").count())

    def test_a_press_released_off_the_canvas_does_not_follow_the_hand_back(self):
        # Below the slop the gesture is not yet captured, so a press that
        # leaves the element never gets its pointerup — and the drag would
        # still be standing when the pointer wanders back with no button held.
        self.open_state("#mode=field", "FIELD")
        box = self.page.locator("svg.graph-svg").bounding_box()
        middle = box["y"] + box["height"] / 2
        before = self.viewport_transform()
        self.page.mouse.move(box["x"] + 6, middle)
        self.page.mouse.down()
        self.page.mouse.move(box["x"] - 40, middle)
        self.page.mouse.up()
        self.page.mouse.move(box["x"] + 200, middle)
        self.page.mouse.move(box["x"] + 400, middle)
        self.page.wait_for_timeout(150)
        self.assertEqual(before, self.viewport_transform())

    def viewport_transform(self):
        return self.page.evaluate(
            """() => document.querySelector(".viewport").getAttribute("transform")""")

    # A layout is the one thing on this screen that costs real time, so the
    # tests below watch for it directly: every LAYOUT the viewer enters is
    # recorded, and the picture is compared plate by plate.
    WATCH_JS = """() => {
      window.__states = [];
      window.__svg = document.querySelector("svg.graph-svg");
      new MutationObserver((records) => {
        for (const record of records) {
          window.__states.push(document.querySelector("#main").dataset.state);
        }
      }).observe(document.querySelector("#main"),
                 {attributes: true, attributeFilter: ["data-state"]});
    }"""
    PLATES_JS = """() => [...document.querySelectorAll("svg .node")].map(
      (g) => g.dataset.nodeId + "@" + g.getAttribute("transform"))"""

    def test_changing_focus_repaints_the_field_instead_of_solving_it_again(self):
        # The same drawn set settles into the same picture every time (§27.8),
        # so solving it again on a click is a reader waiting to be shown what
        # they were already looking at. The picture is repainted: same tree,
        # same coordinates, no LAYOUT, no blank stage.
        self.open_state("#mode=field", "FIELD")
        before = self.page.evaluate(self.PLATES_JS)
        self.page.evaluate(self.WATCH_JS)
        self.page.locator('svg .node[data-node-id="concept:idempotency"]').click()
        self.page.wait_for_selector(
            'svg .node.selected[data-node-id="concept:idempotency"]')
        self.assertNotIn("LAYOUT", self.page.evaluate("() => window.__states"))
        self.assertTrue(self.page.evaluate(
            "() => window.__svg === document.querySelector('svg.graph-svg')"))
        self.assertEqual(before, self.page.evaluate(self.PLATES_JS))
        self.assertEqual(1, self.page.locator("svg .node.selected").count())
        self.assertEqual(
            "0",
            self.page.locator("svg .node.selected").get_attribute("tabindex"))

        # And again, onto a second node, from the panel's own relation list.
        self.page.evaluate("() => { window.__states.length = 0; }")
        self.page.locator("#details button", has_text="concept:redis").first.click()
        self.page.wait_for_selector(
            'svg .node.selected[data-node-id="concept:redis"]')
        self.assertNotIn("LAYOUT", self.page.evaluate("() => window.__states"))
        self.assertEqual(before, self.page.evaluate(self.PLATES_JS))
        self.assertEqual(1, self.page.locator("svg .node.selected").count())

    def test_each_drawn_set_is_solved_once_and_then_remembered(self):
        # The memo is keyed on what is drawn: a new drawn set is an honest
        # miss and is solved, and every return to one already solved gives
        # back the identical picture without solving it again — which is only
        # ever the picture §27.8 would have produced anyway.
        self.write_graph(self.chain_graph())
        self.open_state("#mode=field&focus=concept:a", "FIELD")
        horizon = self.page.locator("#horizon-select")
        whole = self.page.evaluate(self.PLATES_JS)
        self.page.evaluate(self.WATCH_JS)

        # A narrower horizon is a drawn set nothing has solved yet.
        horizon.select_option("1")
        self.page.wait_for_function(
            "() => document.querySelectorAll('svg .node').length === 3")
        narrow = self.page.evaluate(self.PLATES_JS)
        self.assertIn("LAYOUT", self.page.evaluate("() => window.__states"))

        # Both directions now come back from the memo, unchanged.
        for option, count, expected in (("all", 8, whole), ("1", 3, narrow)):
            self.page.evaluate("() => { window.__states.length = 0; }")
            horizon.select_option(option)
            self.page.wait_for_function(
                "() => document.querySelectorAll('svg .node').length === "
                + str(count))
            self.assertNotIn("LAYOUT", self.page.evaluate("() => window.__states"))
            self.assertEqual(expected, self.page.evaluate(self.PLATES_JS))

    def test_the_routes_lens_redraws_from_the_remembered_layout(self):
        # The Routes lens keeps the layout and changes the drawn edges, so an
        # equal memo key is not an equal picture across it. Without that guard
        # a hidden route would stay on the screen.
        self.open_state("#mode=field&focus=concept:idempotency", "FIELD")
        before = self.page.evaluate(self.PLATES_JS)
        drawn = self.page.locator("svg .edge-group").count()
        self.page.evaluate(self.WATCH_JS)

        self.page.locator("#routes-toggle").click()
        self.page.wait_for_selector("#main[data-state='FIELD']")
        self.assertLess(self.page.locator("svg .edge-group").count(), drawn)
        self.assertEqual(0, self.page.locator("svg .edge-line.edge-route").count())
        self.assertNotIn("LAYOUT", self.page.evaluate("() => window.__states"))
        self.assertEqual(before, self.page.evaluate(self.PLATES_JS))

        self.page.locator("#routes-toggle").click()
        self.page.wait_for_selector("#main[data-state='FIELD']")
        self.assertEqual(drawn, self.page.locator("svg .edge-group").count())
        self.assertEqual(before, self.page.evaluate(self.PLATES_JS))

    def test_the_emphasis_is_reachable_without_a_pointer(self):
        # §27.8: every interaction is keyboard-reachable. The selection is the
        # field's one tab stop, and stepping it from the panel moves the lit
        # set with it — the same picture the mouse draws.
        self.open_state("#mode=field&focus=concept:idempotency", "FIELD")
        first = self.incident_pairs()
        self.assertGreater(len(first), 0)
        button = self.page.locator("#details button", has_text="concept:redis").first
        button.focus()
        self.page.keyboard.press("Enter")
        self.page.wait_for_selector('svg .node.selected[data-node-id="concept:redis"]')
        second = self.incident_pairs()
        self.assertNotEqual(first, second)
        self.assertTrue(any("concept:redis" in pair for pair in second))
        self.assertEqual(
            "0", self.page.locator("svg .node.selected").get_attribute("tabindex"))
        self.assertEqual(
            1, self.page.locator('svg .node[tabindex="0"]').count())

    def hit_point(self, selector):
        # The centre of an element is only a usable press target if it is what
        # the pointer would actually land on — edges carry a wide invisible
        # hit stroke that sits over its neighbours.
        return self.page.evaluate(
            """(want) => {
                for (const el of document.querySelectorAll("svg " + want)) {
                    const box = el.getBoundingClientRect();
                    const x = Math.round(box.left + box.width / 2);
                    const y = Math.round(box.top + box.height / 2);
                    const hit = document.elementFromPoint(x, y);
                    if (hit && hit.matches(want)) return [x, y];
                }
                return null;
            }""",
            selector,
        )

    def drag_from(self, x, y):
        transform = "() => document.querySelector('svg .viewport')" \
                    ".getAttribute('transform')"
        before = self.page.evaluate(transform)
        self.page.mouse.move(x, y)
        self.page.mouse.down()
        for step in range(1, 13):
            self.page.mouse.move(x + step * 18, y + step * 5)
        self.page.mouse.up()
        return self.page.evaluate(transform) != before

    def test_the_picture_is_grabbable_anywhere_and_a_drag_is_not_a_click(self):
        # Nothing in the field moves relative to anything else, so the whole
        # picture is the only thing to take hold of — and every press takes
        # hold of it. Requiring bare background made the gesture fail wherever
        # an edge's invisible 12px hit stroke lay, which on a dense field is
        # most of the canvas.
        nodes = [
            {"id": f"concept:n{index:02d}", "type": "concept",
             "title": f"N{index:02d}", "fields": ["knowledge"], "aliases": []}
            for index in range(24)
        ]
        edges = [
            {"source": f"concept:n{index:02d}",
             "target": f"concept:n{index + 1:02d}",
             "type": "related_to", "provenance": [f"concept:n{index:02d}"],
             "weight": "unassessed"}
            for index in range(len(nodes) - 1)
        ]
        graph = self.graph_envelope(nodes=nodes, edges=edges)
        for target in ("svg-background", ".edge-hit", ".node-shape"):
            with self.subTest(grabbed=target):
                self.write_graph(graph)
                self.open_state("#mode=field", "FIELD")
                spot = ((8, 8) if target == "svg-background"
                        else self.hit_point(target))
                self.assertIsNotNone(spot, f"no reachable {target}")
                if target == "svg-background":
                    box = self.page.locator("svg").bounding_box()
                    spot = (int(box["x"] + 12), int(box["y"] + 12))
                self.assertTrue(self.drag_from(*spot))
                # The drag moved the picture, so it did not also open a node.
                self.assertTrue(self.page.locator("#details").is_hidden())
                self.assertEqual("mode=field", urlsplit(self.page.url).fragment)

        # A press that does not travel is still a press: it selects.
        self.write_graph(graph)
        self.open_state("#mode=field", "FIELD")
        spot = self.hit_point(".node-shape")
        self.page.mouse.click(*spot)
        self.page.wait_for_selector("#details:not([hidden])")
        self.assertIn("focus=", urlsplit(self.page.url).fragment)

    def test_a_field_wider_than_the_frame_opens_whole_and_unsqueezed(self):
        # A field too big for the frame is fitted by zooming the view out, not
        # by pulling the positions together: the plate keeps its fixed size
        # per kind class (A10), so shrinking the gaps under it was the one way
        # to make plates overlap that no A11 tier could undo. Everything is on
        # screen, and nothing is on top of anything.
        nodes = [
            {"id": f"concept:n{index:03d}", "type": "concept",
             "title": f"N{index:03d}", "fields": ["knowledge"], "aliases": []}
            for index in range(140)
        ]
        edges = [
            {"source": f"concept:n{index:03d}",
             "target": f"concept:n{index + 1:03d}",
             "type": "related_to", "provenance": [f"concept:n{index:03d}"],
             "weight": "unassessed"}
            for index in range(len(nodes) - 1)
        ]
        self.write_graph(self.graph_envelope(nodes=nodes, edges=edges))
        self.open_state("#mode=field", "FIELD")
        geometry = self.page.evaluate(
            """() => {
                const viewport = document.querySelector("svg .viewport");
                const frame = document.querySelector("svg").getBoundingClientRect();
                const plates = [...document.querySelectorAll("svg .node-shape")]
                    .map((shape) => shape.getBoundingClientRect());
                const outside = plates.filter((box) =>
                    box.left < frame.left - 0.5 || box.right > frame.right + 0.5
                    || box.top < frame.top - 0.5 || box.bottom > frame.bottom + 0.5);
                const overlaps = [];
                for (let i = 0; i < plates.length; i += 1) {
                    for (let j = i + 1; j < plates.length; j += 1) {
                        const a = plates[i], b = plates[j];
                        if (a.left < b.right && b.left < a.right
                            && a.top < b.bottom && b.top < a.bottom) overlaps.push([i, j]);
                    }
                }
                return {
                    scale: Number(viewport.getAttribute("transform")
                        .match(/scale\\(([\\d.]+)\\)/)[1]),
                    plates: plates.length,
                    outside: outside.length,
                    overlaps: overlaps.length,
                };
            }"""
        )
        self.assertEqual(140, geometry["plates"])
        self.assertLess(geometry["scale"], 1)
        self.assertEqual(0, geometry["outside"])
        self.assertEqual(0, geometry["overlaps"])

    def wide_route_field(self):
        # A path long enough to open wider than the frame, carrying one route
        # edge so a dashed family is on screen. §20.3 canonical order sorts by
        # type first, so every related_to precedes the suggested_next.
        nodes = [
            {"id": f"concept:n{index:03d}", "type": "concept",
             "title": f"N{index:03d}", "fields": ["knowledge"], "aliases": []}
            for index in range(140)
        ]
        nodes.append({
            "id": "suggested-route:wide", "type": "suggested_route",
            "title": "Wide route", "status": "available",
            "source_plan": "plan:wide", "fields": ["knowledge"],
        })
        nodes.append({
            "id": "plan:wide", "type": "plan", "title": "Wide plan",
            "fields": ["knowledge"],
        })
        edges = [
            {"source": f"concept:n{index:03d}",
             "target": f"concept:n{index + 1:03d}",
             "type": "related_to", "provenance": [f"concept:n{index:03d}"],
             "weight": "unassessed"}
            for index in range(140 - 1)
        ]
        edges.append({
            "source": "concept:n000", "target": "concept:n139",
            "type": "suggested_next", "provenance": ["suggested-route:wide"],
            "context": "suggested-route:wide",
        })
        return self.graph_envelope(nodes=nodes, edges=edges)

    def measured_dash(self):
        return self.page.evaluate(
            """() => {
                const viewport = document.querySelector("svg .viewport");
                const route = document.querySelector("svg .edge-route");
                return {
                    zoom: Number(viewport.getAttribute("transform")
                        .match(/scale\\(([\\d.]+)\\)/)[1]),
                    scale: Number(getComputedStyle(viewport)
                        .getPropertyValue("--dash-scale")),
                    screen: Number(getComputedStyle(viewport)
                        .getPropertyValue("--screen-scale")),
                    dash: getComputedStyle(route).strokeDasharray
                        .match(/[\\d.]+/g).map(Number),
                };
            }"""
        )

    def test_a_field_at_its_own_scale_draws_the_authored_dash(self):
        # §16.2 A3 sets the route period at 4 on, 3 off. A field drawn at least
        # at its own size draws exactly that — the screen floor only ever grows
        # a dash, so nothing the frame shows whole is touched by it. Its own
        # size is the whole trip, camera and frame: a frame shorter than the
        # field was authored for is already drawing it smaller.
        self.page.set_viewport_size({"width": 1280, "height": 900})
        self.write_graph(self.chain_graph())
        self.open_state("#mode=field", "FIELD")
        measured = self.measured_dash()
        self.assertEqual(1, measured["zoom"])
        self.assertGreaterEqual(measured["screen"], 1)
        self.assertEqual(1, measured["scale"])
        self.assertEqual([4, 3], measured["dash"])

    def test_a_narrow_frame_holds_the_dash_up_on_its_own(self):
        # The camera is not the only thing that draws the field smaller than
        # itself: an embed narrower than the field was authored for shrinks the
        # period with everything else, and a route dash blurred into a
        # continuous stroke has stopped carrying family (A3, §16.4).
        self.page.set_viewport_size({"width": 420, "height": 300})
        self.write_graph(self.chain_graph())
        self.open_state("#mode=field", "FIELD")
        measured = self.measured_dash()
        self.assertLess(measured["screen"], 0.6, "expected a narrow frame")
        self.assertAlmostEqual(
            1 / measured["screen"], measured["scale"], places=3)
        # On screen the period is the authored one, whatever the frame does.
        self.assertGreater(measured["dash"][0] * measured["screen"], 3.5)

    def test_a_dash_stops_shrinking_once_the_picture_is_drawn_smaller(self):
        # A dash carries edge family, and its period is in layout units: a
        # field held whole at a fiftieth of its own size asks for fifty times
        # the dashes it can show, on every edge at once. The family mark
        # dissolves into a hairline, and the browser spends a quarter-second a
        # frame drawing what cannot be seen — the picture stops answering the
        # hand dragging it. Drawn smaller than itself the dash holds its own
        # size instead, the same floor of screen presence the plate outline
        # keeps.
        self.write_graph(self.wide_route_field())
        self.open_state("#mode=field", "FIELD")
        measured = self.measured_dash()
        self.assertLess(measured["zoom"], 1)
        self.assertAlmostEqual(
            1 / measured["screen"], measured["scale"], places=3)
        # The authored period, grown by that scale and nothing else.
        self.assertAlmostEqual(
            4 * measured["scale"], measured["dash"][0], places=2)
        self.assertAlmostEqual(
            3 * measured["scale"], measured["dash"][1], places=2)

    def test_focus_horizon_control_needs_a_focus(self):
        # The horizon is a reader control over a focused node, so it stays
        # inert — and says why — until there is one. It is not an address key:
        # §16.4's fragment is unchanged by moving it.
        self.write_graph(self.chain_graph())
        self.open_state("#mode=field", "FIELD")
        horizon = self.page.locator("#horizon-select")
        self.assertTrue(horizon.is_disabled())
        self.assertEqual(
            "Open a node to look around it", horizon.get_attribute("title"))

        self.open_state("#mode=field&focus=concept:a", "FIELD")
        horizon = self.page.locator("#horizon-select")
        self.assertFalse(horizon.is_disabled())
        self.assertIsNone(horizon.get_attribute("title"))
        horizon.select_option("1")
        self.page.wait_for_function(
            "() => document.querySelectorAll('svg .node').length === 3")
        self.assertEqual("mode=field&focus=concept:a",
                         urlsplit(self.page.url).fragment)

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
            "freshness": "fresh",
            "evidence": [encounter["id"]],
        }
        cases["depth-exceeds-encounter"] = graph

        graph = self.graph_envelope(nodes=[material, encounter])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][material["id"]] = {
            "depth_reached": "applied",
            "last_seen": "2026-07-15",
            "freshness": "fresh",
            "evidence": [encounter["id"]],
        }
        cases["material-last-seen-predates-cited-encounter"] = graph

        graph = self.graph_envelope(nodes=[material])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][material["id"]] = {
            "depth_reached": "skim",
            "last_seen": "2026-07-16",
            "freshness": "fresh",
            "evidence": ["encounter:missing"],
        }
        cases["material-cites-no-emitted-encounter"] = graph

        graph = self.graph_envelope(nodes=[material, encounter])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][material["id"]] = {
            "depth_reached": "applied",
            "last_seen": "2026-07-16",
            "freshness": "fresh",
            "evidence": [encounter["id"], "encounter:missing"],
        }
        cases["material-cites-partially-dangling-encounters"] = graph

        # #105: the material contact pair is emitted, so the viewer holds it
        # to the same §14.7 derivation as the concept pair — an absent class
        # is not a licensed omission, and a supplied one is not proof.
        graph = self.graph_envelope(nodes=[material, encounter])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][material["id"]] = {
            "depth_reached": "applied",
            "last_seen": "2026-07-16",
            "evidence": [encounter["id"]],
        }
        cases["material-freshness-missing"] = graph

        stale_encounter = {
            **encounter,
            "id": "encounter:stale-example",
            "date": "2026-01-01",
        }
        graph = self.graph_envelope(nodes=[material, stale_encounter])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][material["id"]] = {
            "depth_reached": "applied",
            "last_seen": "2026-01-01",
            "freshness": "fresh",
            "evidence": [stale_encounter["id"]],
        }
        cases["material-freshness-not-derived"] = graph

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
            "freshness": "fresh",
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
        visible_ids = {node["id"] for node in visible}
        visible_edges = [
            edge for edge in graph["edges"]
            if edge["source"] in visible_ids and edge["target"] in visible_ids
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
            len(visible_edges), self.page.locator(".edge-list-row").count())
        weighted = [
            edge for edge in visible_edges if "weight" in edge
        ]
        self.assertEqual(
            sorted("weight: " + edge["weight"] for edge in weighted),
            sorted(self.page.locator(
                ".edge-list-weight").all_inner_texts()),
        )
        self.assertIn(
            "weight: unassessed",
            self.page.locator(".edge-list-weight").all_inner_texts(),
        )
        no_weight = next(edge for edge in visible_edges if "weight" not in edge)
        no_weight_row = self.page.locator(
            f'.edge-list-row[data-source="{no_weight["source"]}"]'
            f'[data-target="{no_weight["target"]}"]'
            f'[data-edge-type="{no_weight["type"]}"]'
        )
        self.assertEqual(1, no_weight_row.count())
        self.assertEqual(0, no_weight_row.locator(".edge-list-weight").count())
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

    def test_the_quiet_settles_in_and_stands_still_under_reduced_motion(self):
        # A9 gives focus feedback the one transition there is, so the relations
        # that do not touch a selection settle rather than snap — and reduced
        # motion collapses it to zero, where they are simply already quiet.
        settle = """() => getComputedStyle(
            document.querySelector("svg .edge-line")).transitionDuration"""
        self.open_state("#mode=field", "FIELD")
        self.assertNotEqual("0s", self.page.evaluate(settle))

        self.context.close()
        self.context = self.browser.new_context(reduced_motion="reduce")
        self.page = self.context.new_page()
        self.open_state("#mode=field", "FIELD")
        self.assertEqual("0s", self.page.evaluate(settle))

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
        edge_label = self.page.locator("svg .edge-label").first
        edge_label.evaluate("label => label.classList.add('visible')")
        self.assertTrue(edge_label.is_visible())
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
        self.assertFalse(edge_label.is_visible())
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

    def test_hub_and_spoke_density_uses_nearest_neighbours(self):
        # Long incident spokes are not spacing: the leaves can overlap while
        # every hub edge remains long. A11 therefore keys the initial tier to
        # the cached median nearest-neighbour distance.
        hub = self.concept_node("hub")
        leaves = [self.concept_node(f"leaf-{index:02d}") for index in range(48)]
        edges = [
            {
                "source": hub["id"], "target": leaf["id"],
                "type": "related_to",
                "provenance": [hub["id"], leaf["id"]],
                "weight": "unassessed",
            }
            for leaf in leaves
        ]
        self.write_graph(self.graph_envelope(nodes=[hub, *leaves], edges=edges))
        self.open_state("#mode=field", "FIELD", timeout=30_000)
        viewport = self.page.locator("svg .viewport")
        self.assertIn("drop-decision", viewport.get_attribute("class"))
        self.assertIn(
            "not drawn at this density: decision rails, edge weight",
            self.page.locator("#status-bar").inner_text(),
        )

    def test_density_recomputes_when_panel_rescales_the_svg(self):
        # A11 consumes actual on-screen spacing. At this embed width the field
        # has room for the full language until the 320px detail panel opens;
        # the SVG ResizeObserver must then engage the omission tiers.
        self.page.set_viewport_size({"width": 800, "height": 800})
        self.open_state("#mode=field", "FIELD")
        viewport = self.page.locator("svg .viewport")
        self.assertNotIn(
            "drop-decision", viewport.get_attribute("class") or "")
        self.page.locator(
            'g.node[data-node-id="concept:http-methods"]').dispatch_event("click")
        self.page.wait_for_selector("#details:not([hidden])")
        self.page.wait_for_function(
            "() => document.querySelector('svg .viewport')"
            ".classList.contains('drop-decision')")
        self.assertIn(
            "not drawn at this density: decision rails, edge weight",
            self.page.locator("#status-bar").inner_text(),
        )

    def test_density_token_overrides_cannot_invert_drop_order(self):
        # Tier values are tunable, but A11's order is not. A later threshold
        # that engages first must carry every preceding omission with it.
        self.open_state("#mode=field", "FIELD")
        self.page.evaluate(
            """() => {
                const sheet = [...document.styleSheets].find(
                    item => item.href?.endsWith("/viewer/viewer.css"));
                sheet.insertRule(
                    ":root { --tier-decision-x: 0.01; "
                    + "--tier-label-x: 100; --tier-state-x: 0.01; }",
                    sheet.cssRules.length);
            }""")
        self.page.locator("#list-view").click()
        self.page.wait_for_selector('#main[data-state="LIST"]')
        self.page.locator("#graph-view").click()
        self.page.wait_for_selector('#main[data-state="FIELD"]')
        classes = self.page.locator("svg .viewport").get_attribute("class")
        self.assertIn("drop-decision", classes)
        self.assertIn("drop-labels", classes)
        self.assertNotIn("drop-state", classes)

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
            "freshness": "fresh", "evidence": [encounter["id"]],
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

        def texture_geometry():
            return self.page.evaluate(
                """({touchedId, taughtId}) => {
                    const touched = document.querySelector(
                        `g.node[data-node-id="${touchedId}"]`);
                    const taught = document.querySelector(
                        `g.node[data-node-id="${taughtId}"]`);
                    const taughtShape = taught.querySelector(".node-shape");
                    const keyline = taught.querySelector(".plate-keyline");
                    const pattern = document.querySelector("#tx-hatch-concept");
                    return {
                        dotRadius: parseFloat(
                            touched.querySelector(".plate-dot").getAttribute("r")),
                        keylineInset: parseFloat(taughtShape.getAttribute("r"))
                            - parseFloat(keyline.getAttribute("r")),
                        hatchPitch: parseFloat(pattern.getAttribute("width")),
                        hatchWeight: parseFloat(
                            pattern.querySelector("line")
                                .getAttribute("stroke-width")),
                    };
                }""",
                {"touchedId": touched["id"], "taughtId": taught["id"]},
            )

        native = texture_geometry()
        self.page.evaluate(
            """() => {
                const sheet = [...document.styleSheets].find(
                    item => item.href?.endsWith("/viewer/viewer.css"));
                sheet.insertRule(
                    ":root { --plate-r: 9px; }", sheet.cssRules.length);
            }""")
        self.page.locator("#list-view").click()
        self.page.wait_for_selector('#main[data-state="LIST"]')
        self.page.locator("#graph-view").click()
        self.page.wait_for_selector('#main[data-state="FIELD"]')
        scaled = texture_geometry()
        for key in native:
            with self.subTest(texture_dimension=key):
                self.assertAlmostEqual(
                    native[key] / 2, scaled[key], places=2)

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

    def test_material_boundary_reads_the_emitted_freshness_class(self):
        # §14.7 (#105): a material plate's boundary and its panel words come
        # from the class the §20 fold emitted. The render alone cannot prove
        # that — the acceptance boundary rejects any emitted class the §14.7
        # derivation would not produce, so a viewer that re-derived would draw
        # the same picture. What separates the two is the entry with no class:
        # deriving one needs only last_seen, reading one needs the field. So
        # the same graph is asserted twice, drawn and then stripped.
        material = {
            "id": "material:stale-example", "type": "material",
            "title": "Stale material (Vera Example)", "fields": [],
            "kind": "docs", "url": "", "status": "active",
        }
        encounter = {
            "id": "encounter:stale-contact", "type": "encounter", "title": "",
            "fields": [], "date": "2026-04-01", "target": material["id"],
            "depth": "read", "mode": "background",
        }
        graph = self.graph_envelope(nodes=[material, encounter])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][material["id"]] = {
            "depth_reached": "read",
            "last_seen": "2026-04-01",
            "freshness": "stale",
            "evidence": [encounter["id"]],
        }
        self.write_graph(graph)
        self.open_state("#mode=field", "FIELD")
        self.assertIn("fresh-stale", self.node_class(material["id"]))
        self.page.locator("#list-view").click()
        self.page.wait_for_selector('#main[data-state="LIST"]')
        row = self.page.locator(
            f'.node-list-row[data-node-id="{material["id"]}"]')
        self.assertIn(
            "freshness: stale — last seen 2026-04-01", row.inner_text())

        # Same contact, class removed: last_seen alone would have been enough
        # for the old derivation, and is now a rejection.
        del graph["state"][material["id"]]["freshness"]
        self.write_graph(graph)
        self.open_state("#mode=field", "REJECTED")
        self.assertEqual(
            {"path": "/state", "rule": "required"},
            self.page.evaluate(
                """async graph => {
                    const {validateGraph} = await import("./contract.js");
                    return validateGraph(graph);
                }""",
                graph,
            ),
        )

    def test_freshness_classes_match_the_fold_on_every_boundary_day(self):
        # §14.7/#108: the parity test pins the numbers both implementations
        # carry, but not the comparison that uses them — flipping either `<=`
        # to `<` in freshnessOf leaves FRESHNESS_DAYS untouched and
        # misclassifies exactly one day, which no other viewer case visits.
        # So every age across both boundaries is labelled by the §20 fold and
        # offered to the acceptance check: the two transcriptions have to
        # agree on all of them, not merely carry the same integers.
        as_of = datetime.date.fromisoformat("2026-07-16")
        span = build_atlas_graph.FRESHNESS_DAYS["aging"] + 2
        graphs = []
        for age in range(span + 1):
            last_seen = (as_of - datetime.timedelta(days=age)).isoformat()
            concept = {
                "id": f"concept:day-{age}", "type": "concept",
                "title": f"Day {age} (Vera Example)",
                "fields": ["knowledge"], "aliases": [],
            }
            artifact = {
                "id": f"artifact:day-{age}", "type": "artifact", "title": "",
                "fields": [], "kind": "note", "path": "notes/example.md",
                "observed_at": last_seen,
                "summary": "Synthetic viewer fixture (Vera Example).",
                "evidence_strength": "noticed",
            }
            graph = self.graph_envelope(nodes=[concept, artifact])
            graph["generated_at"] = "2026-07-16T00:00:00Z"
            graph["state"][concept["id"]].update({
                "exposure": "touched",
                "last_seen": last_seen,
                "freshness": build_atlas_graph.freshness_of(
                    last_seen, as_of.isoformat()),
                "evidence": [artifact["id"]],
            })
            graphs.append(graph)

        # One real load puts the acceptance module on the viewer's own origin;
        # the batch below then runs the shipped contract, not a copy of it.
        self.write_graph(graphs[0])
        self.open_state("#mode=field", "FIELD")
        diagnostics = self.page.evaluate(
            """async graphs => {
                const {validateGraph} = await import("./contract.js");
                return graphs.map(graph => validateGraph(graph));
            }""",
            graphs,
        )
        self.assertEqual([None] * (span + 1), diagnostics)

        # The other direction: accepting everything would also pass the loop
        # above, so each boundary day is offered its neighbour's class too.
        for boundary, wrong in (
            (build_atlas_graph.FRESHNESS_DAYS["fresh"], "aging"),
            (build_atlas_graph.FRESHNESS_DAYS["aging"], "stale"),
        ):
            graph = json.loads(json.dumps(graphs[boundary]))
            entry = graph["state"][f"concept:day-{boundary}"]
            self.assertNotEqual(wrong, entry["freshness"])
            entry["freshness"] = wrong
            self.assertEqual(
                {"path": f"/state/freshness", "rule": "derivedFreshness"},
                self.page.evaluate(
                    """async graph => {
                        const {validateGraph} = await import("./contract.js");
                        return validateGraph(graph);
                    }""",
                    graph,
                ),
            )

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
                    tokens: {
                        high: token("--rail-mark-3") * token("--plate-r") / 7,
                    },
                };
            }""",
            concept["id"],
        )
        # confidence high: one struck mark at the top extent.
        self.assertEqual(
            [round(drawn["tokens"]["high"], 2)],
            [round(height, 2) for height in drawn["confidence"]],
        )
        # clarity disputed: the fork — a base and two tines, not a rung.
        self.assertEqual(3, drawn["clarity"])
        # coverage undecided: the slot stays drawn and unstruck.
        self.assertEqual(0, drawn["coverage"])
        # A kind that admits no gated dimension draws no rail.
        self.assertEqual(0, self.page.locator(
            f'g.node[data-node-id="{artifact["id"]}"] .rail').count())
        self.open_state(
            "#mode=field&focus=" + quote(concept["id"], safe=""), "FIELD")
        self.page.wait_for_selector("#details:not([hidden])")
        panel = self.page.locator("#details").inner_text()
        self.assertIn("high", panel)
        self.assertIn("disputed", panel)
        self.assertIn("no decision", panel)

    def test_question_status_rail_is_one_nonordinal_slot(self):
        # §16.2 A1/A2: question status is review-gated, so silence is one
        # unstruck slot and every confirmed status gets the same strike. The
        # status value remains in words; mark extent must not rank it.
        question_id = "question:demo-when-is-retry-safe"
        decided_heights = []
        for status in (None, "open", "clarified", "resolved", "stale"):
            graph = json.loads(DEMO_GRAPH.read_text(encoding="utf-8"))
            if status is not None:
                graph["state"][question_id] = {
                    "status": status,
                    "evidence": ["artifact:missing-note"],
                    "decisions": [{
                        "dimension": "status",
                        "date": "2026-07-10",
                        "evidence": ["artifact:missing-note"],
                    }],
                }
            with self.subTest(status=status or "undecided"):
                self.write_graph(graph)
                self.open_state("#mode=field", "FIELD")
                node = self.page.locator(
                    f'g.node[data-node-id="{question_id}"]')
                slots = node.locator(".rail-slot")
                marks = node.locator(".rail-mark")
                self.assertEqual(1, node.locator(".rail").count())
                self.assertEqual(1, slots.count())
                self.assertEqual(
                    "status", slots.first.get_attribute("data-dimension"))
                if status is None:
                    self.assertEqual(0, marks.count())
                else:
                    self.assertEqual(1, marks.count())
                    decided_heights.append(float(
                        marks.first.get_attribute("height")))
                self.assertEqual(
                    "none",
                    node.locator(".question-ring").evaluate(
                        "ring => getComputedStyle(ring).animationName"),
                )
        self.assertEqual(
            1, len({round(height, 2) for height in decided_heights}))

    def test_rail_anchor_clears_auxiliary_kind_marks(self):
        # The rail begins after the complete drawn glyph, not the primary
        # plate: question pull rings and node-payload sensitivity dots remain
        # unobscured when their kinds also admit review-gated state.
        question_id = "question:demo-when-is-retry-safe"
        self.open_state("#mode=field", "FIELD")
        question = self.page.locator(
            f'g.node[data-node-id="{question_id}"]')
        question_geometry = question.evaluate(
            """group => ({
                ringRight: parseFloat(
                    group.querySelector(".question-ring").getAttribute("r")),
                railLeft: parseFloat(
                    group.querySelector(".rail-slot").getAttribute("x")),
            })""")
        self.assertGreater(
            question_geometry["railLeft"], question_geometry["ringRight"])

        concept = self.concept_node("classed-rail")
        concept["sensitivity"] = "medical"
        graph = self.graph_envelope(nodes=[concept])
        graph["state"][concept["id"]]["sensitivity"] = "medical"
        self.write_graph(graph)
        self.open_state("#mode=field", "FIELD")
        marked = self.page.locator(
            f'g.node[data-node-id="{concept["id"]}"]')
        marked_geometry = marked.evaluate(
            """group => {
                const dot = group.querySelector(".sensitivity-dot");
                return {
                    dotRight: parseFloat(dot.getAttribute("cx"))
                        + parseFloat(dot.getAttribute("r")),
                    railLeft: parseFloat(
                        group.querySelector(".rail-slot").getAttribute("x")),
                };
            }""")
        self.assertGreater(
            marked_geometry["railLeft"], marked_geometry["dotRight"])

    def test_rail_geometry_scales_with_plate_token(self):
        # --plate-r is the one glyph scale control. Re-rendering at half the
        # radius must halve the slot, strike, pitch, and gap with the plate.
        graph = json.loads(DEMO_GRAPH.read_text(encoding="utf-8"))
        graph["state"]["concept:idempotency"].update({
            "confidence": "high",
            "decisions": [{
                "dimension": "confidence",
                "date": "2026-07-10",
                "evidence": ["artifact:demo-retry-script"],
            }],
        })
        self.write_graph(graph)
        self.open_state("#mode=field", "FIELD")

        def geometry():
            return self.page.evaluate(
                """() => {
                    const group = document.querySelector(
                        'g.node[data-node-id="concept:idempotency"]');
                    const shape = group.querySelector(".node-shape");
                    const slots = group.querySelectorAll(".rail-slot");
                    const first = slots[0];
                    return {
                        radius: parseFloat(shape.getAttribute("r")),
                        gap: parseFloat(first.getAttribute("x"))
                            - parseFloat(shape.getAttribute("r")),
                        width: parseFloat(first.getAttribute("width")),
                        height: parseFloat(first.getAttribute("height")),
                        pitch: parseFloat(slots[1].getAttribute("y"))
                            - parseFloat(first.getAttribute("y")),
                        mark: parseFloat(
                            group.querySelector(".rail-mark")
                                .getAttribute("height")),
                    };
                }""")

        native = geometry()
        self.page.evaluate(
            """() => {
                const sheet = [...document.styleSheets].find(
                    item => item.href?.endsWith("/viewer/viewer.css"));
                sheet.insertRule(":root { --plate-r: 9px; }", sheet.cssRules.length);
            }""")
        self.page.locator("#list-view").click()
        self.page.wait_for_selector('#main[data-state="LIST"]')
        self.page.locator("#graph-view").click()
        self.page.wait_for_selector('#main[data-state="FIELD"]')
        scaled = geometry()
        for key in native:
            with self.subTest(dimension=key):
                self.assertAlmostEqual(
                    native[key] / 2, scaled[key], places=2)

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

        # §29 keeps medical-derived state out of the active viewer slice. The
        # input contract still validates its provenance, but the accepted
        # projection neither draws nor names state-entry sensitivity.
        concept = self.concept_node("classed-state")
        artifact = self.artifact_node(
            "classed-state-evidence", "noticed", "2026-07-16")
        artifact["sensitivity"] = "medical"
        graph = self.graph_envelope(nodes=[concept, artifact])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        graph["state"][concept["id"]].update({
            "exposure": "touched",
            "last_seen": "2026-07-16",
            "freshness": "fresh",
            "evidence": [artifact["id"]],
            "sensitivity": "medical",
        })
        self.write_graph(graph)
        self.open_state("#mode=field", "FIELD")
        field_node = self.page.locator(
            f'g.node[data-node-id="{concept["id"]}"]')
        self.assertEqual(0, field_node.locator(".sensitivity-dot").count())
        self.page.locator("#list-view").click()
        self.page.wait_for_selector('#main[data-state="LIST"]')
        row = self.page.locator(
            f'.node-list-row[data-node-id="{concept["id"]}"]')
        row_words = row.inner_text()
        self.assertIn("exposure: touched", row_words)
        self.assertIn(
            "freshness: fresh — last seen 2026-07-16", row_words)
        self.assertNotIn("state sensitivity", row_words.lower())
        row.click()
        self.page.wait_for_selector("#details:not([hidden])")
        panel_words = self.page.locator("#details").inner_text()
        self.assertIn("touched", panel_words)
        self.assertIn("fresh — last seen 2026-07-16", panel_words)
        self.assertEqual(
            0,
            self.page.locator(
                '#details .detail-row dt',
                has_text="state sensitivity",
            ).count(),
        )

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

    def test_label_anchor_clears_auxiliary_kind_marks(self):
        # A label starts after the complete glyph footprint, including a
        # sensitivity dot, rather than after only the primary plate.
        artifact = self.artifact_node(
            "classed-label-anchor", "noticed", "2026-07-16")
        artifact["fields"] = ["knowledge"]
        artifact["sensitivity"] = "medical"
        graph = self.graph_envelope(nodes=[artifact])
        graph["generated_at"] = "2026-07-16T00:00:00Z"
        self.write_graph(graph)
        self.open_state("#mode=field", "FIELD")
        geometry = self.page.evaluate(
            """id => {
                const group = document.querySelector(
                    `g.node[data-node-id="${id}"]`);
                const dot = group.querySelector(".sensitivity-dot");
                return {
                    dotRight: parseFloat(dot.getAttribute("cx"))
                        + parseFloat(dot.getAttribute("r")),
                    labelX: parseFloat(
                        group.querySelector(".node-label").getAttribute("x")),
                };
            }""",
            artifact["id"],
        )
        self.assertAlmostEqual(
            4, geometry["labelX"] - geometry["dotRight"], places=2)

    def test_directed_edges_stop_short_of_their_endpoints(self):
        # An untrimmed stroke would bury its arrowhead under the target
        # plate; every demo edge is long enough to trim, so no rendered line
        # may end at a node centre.
        self.open_state("#mode=field", "FIELD")
        marker = self.page.locator("svg marker#arrow")
        self.assertEqual("10", marker.get_attribute("refX"))
        self.assertEqual(
            "10", marker.get_attribute("viewBox").split()[-2])
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

    def test_edges_trim_to_noncircular_circumradii(self):
        # A diagonal edge between square material parts needs halfExtent*sqrt(2)
        # of clearance. Coordinates are emitted at three decimals, so compare
        # the resulting trim at two decimals.
        graph = json.loads(DEMO_GRAPH.read_text(encoding="utf-8"))
        visible_ids = {
            node["id"] for node in graph["nodes"]
            if "knowledge" in node["fields"] or node["fields"] == []
        }
        visible_edges = [
            edge for edge in graph["edges"]
            if edge["source"] in visible_ids and edge["target"] in visible_ids
        ]
        edge_index = next(
            index for index, edge in enumerate(visible_edges)
            if edge["type"] == "supports"
            and edge["source"].startswith("part:")
            and edge["target"].startswith("part:")
        )
        edge = visible_edges[edge_index]
        self.open_state("#mode=field", "FIELD")
        trims = self.page.evaluate(
            """({index, sourceId, targetId}) => {
                const centre = (id) => {
                    const transform = document.querySelector(
                        `g.node[data-node-id="${id}"]`)
                        .getAttribute("transform");
                    const match = transform.match(
                        /translate\\(([-\\d.]+) ([-\\d.]+)\\)/);
                    return {x: parseFloat(match[1]), y: parseFloat(match[2])};
                };
                const hit = document.querySelectorAll(
                    "svg .edge-group")[index].querySelector(".edge-hit");
                const source = centre(sourceId);
                const target = centre(targetId);
                return {
                    source: Math.hypot(
                        parseFloat(hit.getAttribute("x1")) - source.x,
                        parseFloat(hit.getAttribute("y1")) - source.y),
                    target: Math.hypot(
                        parseFloat(hit.getAttribute("x2")) - target.x,
                        parseFloat(hit.getAttribute("y2")) - target.y),
                    expected: Math.hypot(4.5, 4.5)
                        * parseFloat(getComputedStyle(document.documentElement)
                            .getPropertyValue("--plate-r")) / 7 + 2,
                };
            }""",
            {
                "index": edge_index,
                "sourceId": edge["source"],
                "targetId": edge["target"],
            },
        )
        self.assertAlmostEqual(
            trims["expected"], trims["source"], places=2)
        self.assertAlmostEqual(
            trims["expected"], trims["target"], places=2)

    def test_edges_trim_past_target_rail_on_its_approach_ray(self):
        # A right-side incoming arrow must stop outside the target's complete
        # glyph, not under the decision rail painted over it. The trim stays
        # direction-sensitive rather than reserving rail width on every side.
        source = self.concept_node("a-source")
        target = self.concept_node("b-target")
        target["sensitivity"] = "medical"
        edge = {
            "source": source["id"], "target": target["id"],
            "type": "prerequisite_of",
            "provenance": [source["id"], target["id"]],
            "weight": "low",
        }
        graph = self.graph_envelope(nodes=[source, target], edges=[edge])
        graph["state"][target["id"]]["sensitivity"] = "medical"
        self.write_graph(graph)
        self.open_state("#mode=field", "FIELD")
        geometry = self.page.evaluate(
            """({sourceId, targetId}) => {
                const centre = (id) => {
                    const transform = document.querySelector(
                        `g.node[data-node-id="${id}"]`)
                        .getAttribute("transform");
                    const match = transform.match(
                        /translate\\(([-\\d.]+) ([-\\d.]+)\\)/);
                    return {x: Number(match[1]), y: Number(match[2])};
                };
                const source = centre(sourceId);
                const target = centre(targetId);
                const dx = source.x - target.x;
                const dy = source.y - target.y;
                const length = Math.hypot(dx, dy);
                const direction = {x: dx / length, y: dy / length};
                const line = document.querySelector(
                    ".edge-group .edge-line[marker-end]");
                const lineEnd = {
                    x: Number(line.getAttribute("x2")),
                    y: Number(line.getAttribute("y2")),
                };
                const slots = [...document.querySelectorAll(
                    `g.node[data-node-id="${targetId}"] .rail-slot`)];
                const left = Math.min(...slots.map(
                    slot => Number(slot.getAttribute("x"))));
                const right = Math.max(...slots.map(
                    slot => Number(slot.getAttribute("x"))
                        + Number(slot.getAttribute("width"))));
                const top = Math.min(...slots.map(
                    slot => Number(slot.getAttribute("y"))));
                const bottom = Math.max(...slots.map(
                    slot => Number(slot.getAttribute("y"))
                        + Number(slot.getAttribute("height"))));
                const slab = (component, minimum, maximum) => {
                    const first = minimum / component;
                    const second = maximum / component;
                    return [Math.min(first, second), Math.max(first, second)];
                };
                const [xEntry, xExit] = slab(direction.x, left, right);
                const [yEntry, yExit] = slab(direction.y, top, bottom);
                return {
                    trim: Math.hypot(
                        lineEnd.x - target.x, lineEnd.y - target.y),
                    railExit: Math.min(xExit, yExit),
                    railEntry: Math.max(xEntry, yEntry),
                };
            }""",
            {"sourceId": source["id"], "targetId": target["id"]},
        )
        self.assertGreater(geometry["railExit"], geometry["railEntry"])
        self.assertGreaterEqual(
            geometry["trim"], geometry["railExit"] + 1.9)

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

    def test_plates_never_settle_on_top_of_one_another(self):
        # Two plates in one place hide each other's state: the reader cannot
        # tell one texture, boundary, or rail from the other, and A11's drop
        # order has no tier that would rescue it. The separation pass runs in
        # frame units after the fit, so the guarantee is what is drawn.
        self.open_state("#mode=field", "FIELD")
        overlaps = self.page.evaluate(
            """() => {
                const boxes = [...document.querySelectorAll("svg .node")]
                    .map((node) => ({
                        id: node.dataset.nodeId,
                        box: node.querySelector(".node-shape").getBoundingClientRect(),
                    }));
                const hits = [];
                for (let i = 0; i < boxes.length; i += 1) {
                    for (let j = i + 1; j < boxes.length; j += 1) {
                        const a = boxes[i].box, b = boxes[j].box;
                        if (a.left < b.right && b.left < a.right
                            && a.top < b.bottom && b.top < a.bottom) {
                            hits.push(boxes[i].id + " / " + boxes[j].id);
                        }
                    }
                }
                return hits;
            }"""
        )
        self.assertEqual([], overlaps)

    def test_labels_clear_each_other_and_stay_seeded(self):
        # A label that lands on its neighbour's label is the label channel
        # drawn and unreadable at once. Each takes the first free slot around
        # its node; the slot order is fixed, so the same graph keeps the same
        # sides and the picture stays seeded (§27.8).
        self.open_state("#mode=field", "FIELD")
        read_labels = """() => [...document.querySelectorAll("svg .node")]
            .map((node) => {
                const label = node.querySelector(".node-label");
                const box = label.getBoundingClientRect();
                return {
                    id: node.dataset.nodeId,
                    anchor: label.getAttribute("text-anchor") || "start",
                    x: label.getAttribute("x"),
                    y: label.getAttribute("y"),
                    box: {left: box.left, right: box.right,
                          top: box.top, bottom: box.bottom},
                };
            })"""
        labels = self.page.evaluate(read_labels)
        overlaps = []
        for index, left in enumerate(labels):
            for right in labels[index + 1:]:
                a, b = left["box"], right["box"]
                if (a["left"] < b["right"] and b["left"] < a["right"]
                        and a["top"] < b["bottom"] and b["top"] < a["bottom"]):
                    overlaps.append(f"{left['id']} / {right['id']}")
        self.assertEqual([], overlaps)
        # The demo field is crowded enough that clearing the collisions needs
        # the left side, so the sweep is proved to do something here.
        self.assertIn("end", {label["anchor"] for label in labels})

        self.page.reload(wait_until="domcontentloaded")
        self.page.wait_for_selector('#main[data-state="FIELD"]')
        repeated = self.page.evaluate(read_labels)
        self.assertEqual(
            [(label["id"], label["anchor"], label["x"], label["y"])
             for label in labels],
            [(label["id"], label["anchor"], label["x"], label["y"])
             for label in repeated],
        )

    def test_edges_of_one_pair_are_drawn_apart(self):
        # The demo graph joins some pairs by more than one edge — related_to
        # and alternative_to say different things about the same two nodes.
        # Stacked on one axis the field would show one stroke where the graph
        # holds several, so each takes its own lane.
        self.open_state("#mode=field", "FIELD")
        spans = self.page.evaluate(
            """() => [...document.querySelectorAll("svg .edge-group")]
                .map((group) => {
                    const line = group.querySelector(
                        ".weight-dropped") || group.querySelector(".edge-line");
                    return ["x1", "y1", "x2", "y2"]
                        .map((name) => Number(line.getAttribute(name)).toFixed(1))
                        .join(",");
                })"""
        )
        self.assertEqual(len(spans), len(set(spans)))


if __name__ == "__main__":
    unittest.main()
