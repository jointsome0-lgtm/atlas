import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";

import {
  DEMO_GRAPH,
  UNSUPPORTED_VERSION_FIXTURE,
  lab,
  type Fixture,
} from "./harness.ts";
import { conceptNode, zoomOutUntil } from "./helpers.ts";

type Dict = Record<string, unknown>;

interface GraphNode extends Dict {
  id: string;
  type: string;
  fields: string[];
}

type Weight = "low" | "medium" | "high";

interface GraphEdge extends Dict {
  source: string;
  target: string;
  type: string;
  weight?: Weight | "unassessed";
}

interface DemoGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface WeightMark {
  extent: number;
  alignment: number;
  offCentre: number;
}

interface WeightOpening {
  segments: number;
  gap: number;
  tick: boolean;
  dropped: number;
}

interface WeightDrawing {
  marked: WeightMark[];
  opened: WeightOpening[];
  tokens: Record<Weight, number> & { gap: number };
}

const NODE_TYPE_ORDER = [
  "plan",
  "concept",
  "material",
  "material_part",
  "direction",
  "suggested_route",
  "personal_trail",
  "trail_segment",
  "artifact",
  "encounter",
  "question",
  "probe",
  "zone",
  "pattern",
];

// One lab per file: the browser and the server belong to this file alone,
// so another file's teardown cannot reach them.
const { baseUrl, close, open, start, stop } = lab();

let it: Fixture;

beforeAll(async () => {
  await start();
});
afterAll(async () => {
  await stop();
});
beforeEach(async () => {
  it = await open();
});
afterEach(async () => {
  await close();
});

test("keyboard navigation focuses selection and pans graph", async () => {
  // Without a selection no node sits in the tab order — the list lens is
  // the dense keyboard path; the graph exposes only the selection.
  await it.openState("#mode=field", "FIELD");
  expect(await it.page.locator('g.node[tabindex="0"]').count()).toBe(0);

  await it.openState("#mode=field&focus=concept:rest-api", "FIELD");
  expect(await it.page.locator('g.node[tabindex="0"]').count()).toBe(1);
  // The deep link lands keyboard focus on the selection itself.
  await it.page.waitForFunction(
    "document.activeElement?.getAttribute('data-node-id') === 'concept:rest-api'",
  );
  // And the selection stays tab-reachable from the graph surface.
  await it.page.locator("svg.graph-svg").focus();
  await it.page.keyboard.press("Tab");
  const focused = it.page.locator("g.node:focus");
  expect(await focused.count()).toBe(1);
  expect(await focused.getAttribute("data-node-id")).toBe("concept:rest-api");
  const ringOpacity = await it.page.evaluate<string>(
    "getComputedStyle(document.querySelector('g.node:focus .focus-ring')).opacity",
  );
  expect(ringOpacity).not.toBe("0");

  const before = await it.page.locator("svg .viewport").getAttribute("transform");
  await it.page.keyboard.press("ArrowRight");
  const after = await it.page.locator("svg .viewport").getAttribute("transform");
  expect(after).not.toBe(before);
});

test("list lens orders sections and activates rows", async () => {
  const graph = JSON.parse(fs.readFileSync(DEMO_GRAPH, "utf8")) as DemoGraph;
  const visible = graph.nodes.filter(
    (node) => node.fields.includes("knowledge") || node.fields.length === 0,
  );
  const visibleIds = new Set(visible.map((node) => node.id));
  const visibleEdges = graph.edges.filter(
    (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
  );
  const expectedTypes = NODE_TYPE_ORDER.filter((nodeType) =>
    visible.some((node) => node.type === nodeType),
  );
  await it.openState("#mode=field", "FIELD");
  await it.page.locator("#list-view").click();
  await it.page.waitForSelector('#main[data-state="LIST"]');
  const actualTypes = await it.page.evaluate<string[]>(
    "[...document.querySelectorAll('.node-list-section')]" +
      ".map(section => section.dataset.nodeType)",
  );
  expect(actualTypes).toEqual(expectedTypes);
  expect(await it.page.locator(".node-list-row").count()).toBe(visible.length);
  expect(await it.page.locator(".edge-list-row").count()).toBe(visibleEdges.length);
  const weighted = visibleEdges.filter((edge) => edge.weight !== undefined);
  expect((await it.page.locator(".edge-list-weight").allInnerTexts()).sort()).toEqual(
    weighted.map((edge) => `weight: ${edge.weight}`).sort(),
  );
  expect(await it.page.locator(".edge-list-weight").allInnerTexts()).toContain(
    "weight: unassessed",
  );
  const noWeight = visibleEdges.find((edge) => edge.weight === undefined);
  if (noWeight === undefined) throw new Error("fixture has no edge without weight");
  const noWeightRow = it.page.locator(
    `.edge-list-row[data-source="${noWeight.source}"]` +
      `[data-target="${noWeight.target}"]` +
      `[data-edge-type="${noWeight.type}"]`,
  );
  expect(await noWeightRow.count()).toBe(1);
  expect(await noWeightRow.locator(".edge-list-weight").count()).toBe(0);
  expect(await it.page.locator("#list-view").getAttribute("aria-pressed")).toBe("true");
  expect(await it.page.locator("#graph-view").isDisabled()).toBe(false);

  const row = it.page.locator(".node-list-row").first();
  const nodeId = await row.getAttribute("data-node-id");
  if (nodeId === null) throw new Error("list row has no data-node-id");
  await row.click();
  await it.page.waitForSelector("#details:not([hidden])");
  expect(await it.page.evaluate<string>("decodeURIComponent(location.hash)")).toContain(
    `focus=${nodeId}`,
  );
  expect(
    await it.page.locator(".node-list-row.selected").getAttribute("data-node-id"),
  ).toBe(nodeId);
});

test("list panel respects routes lens", async () => {
  await it.openState("#mode=field&focus=concept:rest-api", "FIELD");
  await it.page.locator("#list-view").click();
  await it.page.waitForSelector('#main[data-state="LIST"]');
  await it.page.waitForSelector("#details:not([hidden])");

  const statusEdgeCount = async (): Promise<number> =>
    await it.page.evaluate<number>(
      "Number(document.querySelector('#status-bar').textContent" +
        ".match(/· (\\d+) edges/)[1])",
    );

  const headings = async (): Promise<string[]> =>
    (await it.page.locator("#details .edge-groups h3").allInnerTexts()).map((text) =>
      text.toLowerCase(),
    );

  expect(await headings()).toContain("step_of_route");
  const allEdgeCount = await statusEdgeCount();
  await it.page.locator("#routes-toggle").click();
  await it.page.waitForSelector('#main[data-state="LIST"]');
  await it.page.waitForFunction(
    "Number(document.querySelector('#status-bar')" +
      `.textContent.match(/· (\\d+) edges/)[1]) < ${allEdgeCount}`,
  );
  const withoutRoutes = await headings();
  expect(await statusEdgeCount()).toBeLessThan(allEdgeCount);
  expect(withoutRoutes).not.toContain("step_of_route");
  expect(withoutRoutes).not.toContain("suggested_next");
});

test("redraw restores focus only when orphaned", async () => {
  await it.openState("#mode=field", "FIELD");
  await it.page.locator("#list-view").click();
  await it.page.waitForSelector('#main[data-state="LIST"]');
  const row = it.page.locator(".node-list-row").first();
  const nodeId = await row.getAttribute("data-node-id");
  if (nodeId === null) throw new Error("list row has no data-node-id");
  await row.click();
  await it.page.waitForSelector("#details:not([hidden])");
  // The activated row was destroyed by the rebuild; focus lands on its
  // replacement so Tab continues from the selection.
  await it.page.waitForFunction(
    "document.activeElement?.getAttribute('data-node-id') === " + JSON.stringify(nodeId),
  );
  // A live control keeps focus across the redraw it triggers.
  const toggle = it.page.locator("#routes-toggle");
  await toggle.focus();
  await toggle.press(" ");
  await it.page.waitForSelector('#main[data-state="LIST"]');
  await it.page.evaluate<void>(
    "new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))",
  );
  expect(await it.page.evaluate<boolean>("document.activeElement?.id === 'routes-toggle'")).toBe(
    true,
  );
});

test("focus ring sits outside selection ring", async () => {
  await it.openState("#mode=field&focus=concept:rest-api", "FIELD");
  const selected = it.page.locator(".node.selected");
  const focusRadiusText = await selected.locator(".focus-ring").getAttribute("r");
  const selectionRadiusText = await selected.locator(".selection-ring").getAttribute("r");
  if (focusRadiusText === null || selectionRadiusText === null) {
    throw new Error("selection rings have no radius");
  }
  const focusRadius = Number.parseFloat(focusRadiusText);
  const selectionRadius = Number.parseFloat(selectionRadiusText);
  expect(focusRadius).toBeGreaterThan(selectionRadius);
});

test("header controls reachable in narrow embed", async () => {
  await it.page.setViewportSize({ width: 360, height: 640 });
  await it.openState("#mode=field", "FIELD");
  const box = await it.page.locator("#legend-toggle").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  await it.page.locator("#legend-toggle").click();
  expect(await it.page.locator("#legend").isVisible()).toBe(true);
});

test("legend receives focus for keyboard scrolling", async () => {
  await it.openState("#mode=field", "FIELD");
  await it.page.locator("#legend-toggle").click();
  expect(await it.page.evaluate<boolean>("document.activeElement?.id === 'legend'")).toBe(true);
  await it.page.keyboard.press("Escape");
  expect(await it.page.evaluate<boolean>("document.activeElement?.id === 'legend-toggle'")).toBe(
    true,
  );
});

test("glyphs carry kind marks beyond color", async () => {
  await it.openState("#mode=field", "FIELD");
  await it.page.locator("#list-view").click();
  await it.page.waitForSelector('#main[data-state="LIST"]');
  const questionGlyph = it.page.locator(
    '.node-list-section[data-node-type="question"] .node-glyph',
  );
  expect(await questionGlyph.locator(".question-ring").count()).toBe(1);
  const trailGlyph = it.page.locator(
    '.node-list-section[data-node-type="personal_trail"] .node-glyph',
  );
  expect(await trailGlyph.locator("circle.node-shape").count()).toBe(2);
  await it.page.locator("#legend-toggle").click();
  expect(await it.page.locator(".legend .node-question .question-ring").count()).toBe(1);
});

test("escape dismisses layers topmost first", async () => {
  await it.openState("#mode=field&focus=concept:rest-api", "FIELD");
  await it.page.waitForSelector("#details:not([hidden])");
  await it.page.locator("#legend-toggle").click();
  await it.page.keyboard.press("Escape");
  expect(await it.page.locator("#legend").isHidden()).toBe(true);
  expect(await it.page.locator("#details").isVisible()).toBe(true);
  await it.page.keyboard.press("Escape");
  await it.page.waitForSelector("#details[hidden]", { state: "attached" });
});

test("legend omits frozen body kinds", async () => {
  await it.openState("#mode=field", "FIELD");
  await it.page.locator("#legend-toggle").click();
  const labels = await it.page.locator(".legend-nodes .legend-row span").allInnerTexts();
  expect(labels).not.toContain("zone");
  expect(labels).not.toContain("pattern");
  expect(labels).toContain("concept");
});

test("legend disclosure lists five edge families", async () => {
  await it.openState("#mode=field", "FIELD");
  const button = it.page.locator("#legend-toggle");
  expect(await button.getAttribute("aria-expanded")).toBe("false");
  await button.click();
  expect(await button.getAttribute("aria-expanded")).toBe("true");
  expect(await it.page.locator('.legend[role="note"]').isVisible()).toBe(true);
  expect(await it.page.locator(".legend-edges .legend-row span").allInnerTexts()).toEqual([
    "routes (hideable)",
    "trail",
    "authored (tick length = weight)",
    "structure",
    "journal-derived",
  ]);
  await it.page.keyboard.press("Escape");
  expect(await button.getAttribute("aria-expanded")).toBe("false");
  expect(await it.page.locator("#legend").isHidden()).toBe(true);
});

test("the quiet settles in and stands still under reduced motion", async () => {
  // A9 gives focus feedback the one transition there is, so the relations
  // that do not touch a selection settle rather than snap — and reduced
  // motion collapses it to zero, where they are simply already quiet.
  const settle =
    "getComputedStyle(document.querySelector('svg .edge-line')).transitionDuration";
  await it.openState("#mode=field", "FIELD");
  expect(await it.page.evaluate<string>(settle)).not.toBe("0s");

  const browser = it.page.context().browser();
  if (browser === null) throw new Error("page context has no browser");
  await it.page.context().close();
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl()}#mode=field`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('#main[data-state="FIELD"]');
    expect(await page.evaluate<string>(settle)).toBe("0s");
  } finally {
    await context.close();
  }
});

test("reduced motion disables question animation", async () => {
  const browser = it.page.context().browser();
  if (browser === null) throw new Error("page context has no browser");
  await it.page.context().close();
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl()}#mode=field`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('#main[data-state="FIELD"]');
    const animationName = await page.evaluate<string>(
      "getComputedStyle(document.querySelector('.question-ring')).animationName",
    );
    expect(animationName).toBe("none");
  } finally {
    await context.close();
  }
});

test("demo render and panel interactions stay offline and csp clean", async () => {
  const url = baseUrl();
  const origin = url.slice(0, url.indexOf("/viewer/"));
  const requests: string[] = [];
  it.page.on("request", (request) => requests.push(request.url()));
  await it.page.addInitScript(`
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", event => {
      window.__cspViolations.push({
        blockedURI: event.blockedURI,
        violatedDirective: event.violatedDirective
      });
    });
  `);
  await it.openState("#mode=field", "FIELD");
  await it.page.locator("g.node").first().focus();
  await it.page.keyboard.press("Enter");
  await it.page.waitForSelector("#details:not([hidden])");
  await it.page.locator("#close-details").click();
  await it.page.waitForSelector("#details", { state: "hidden" });

  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((requestUrl) => requestUrl.startsWith(origin)), requests.join("\n")).toBe(
    true,
  );
  const paths = new Set(requests.map((requestUrl) => new URL(requestUrl).pathname));
  const expected = new Set([
    "/viewer/index.html",
    "/viewer/viewer.css",
    "/viewer/viewer.js",
    "/viewer/contract.js",
    "/viewer/favicon.svg",
    "/graph/atlas-graph.json",
  ]);
  expect([...paths].every((path) => expected.has(path)), [...paths].join("\n")).toBe(true);
  const withoutFavicon = (values: Set<string>): string[] =>
    [...values].filter((path) => path !== "/viewer/favicon.svg").sort();
  expect(withoutFavicon(paths)).toEqual(withoutFavicon(expected));
  expect(await it.page.evaluate<unknown[]>("window.__cspViolations")).toEqual([]);
});

test("demo graph renders expected svg counts and route lens", async () => {
  const graph = JSON.parse(fs.readFileSync(DEMO_GRAPH, "utf8")) as DemoGraph;
  const visibleIds = new Set(
    graph.nodes
      .filter((node) => node.fields.includes("knowledge") || node.fields.length === 0)
      .map((node) => node.id),
  );
  const visibleEdges = graph.edges.filter(
    (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
  );
  await it.openState("#mode=field", "FIELD");
  expect(await it.page.locator("svg .node").count()).toBe(visibleIds.size);
  expect(await it.page.locator("svg .edge-group").count()).toBe(visibleEdges.length);
  expect(await it.page.locator("#status-bar").innerText()).toContain(
    `${visibleIds.size} nodes · ${visibleEdges.length} edges in view`,
  );
  expect(await it.page.locator("#status-bar").innerText()).toContain("as of 2026-07-10");
  const initialHash = await it.page.evaluate<string>("location.hash");
  await it.page.locator("#routes-toggle").uncheck();
  await it.page.waitForSelector('#main[data-state="FIELD"]');
  const renderedEdgeCount = await it.page.locator("svg .edge-group").count();
  expect(renderedEdgeCount).toBeLessThan(visibleEdges.length);
  expect(await it.page.locator("#status-bar").innerText()).toContain(
    `${visibleIds.size} nodes · ${renderedEdgeCount} edges in view`,
  );
  expect(await it.page.evaluate<string>("location.hash")).toBe(initialHash);
});

test("edge weight marks never ride the stroke", async () => {
  // §16.2 A2/A3: an asserted weight is a midpoint tick whose extent
  // carries the level; unassessed opens the stroke and draws no tick, so
  // silence cannot read as an asserted medium; a type that admits no
  // weight keeps one unbroken stroke.
  const graph = JSON.parse(fs.readFileSync(DEMO_GRAPH, "utf8")) as DemoGraph;
  const visibleIds = new Set(
    graph.nodes
      .filter((node) => node.fields.includes("knowledge") || node.fields.length === 0)
      .map((node) => node.id),
  );
  const visibleEdges = graph.edges.filter(
    (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
  );
  const asserted = visibleEdges.filter(
    (edge): edge is GraphEdge & { weight: Weight } =>
      edge.weight === "low" || edge.weight === "medium" || edge.weight === "high",
  );
  const unassessed = visibleEdges.filter((edge) => edge.weight === "unassessed");
  expect(
    asserted.length > 0 && unassessed.length > 0,
    "fixture must exercise both readings",
  ).toBe(true);
  await it.openState("#mode=field", "FIELD");
  expect(await it.page.locator("svg .edge-line[stroke-opacity]").count()).toBe(0);
  const drawn = await it.page.evaluate<WeightDrawing>(`(() => {
    const token = (name) => parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(name));
    const ends = (el) => ["x1", "y1", "x2", "y2"]
      .map((attribute) => parseFloat(el.getAttribute(attribute)));
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
            (tx1 + tx2) / 2 - (x1 + x2) / 2,
            (ty1 + ty2) / 2 - (y1 + y2) / 2)
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
  })()`);
  const tokens = drawn.tokens;
  // extent is the channel, so the three levels must stay ordered and apart
  expect(tokens.low).toBeLessThan(tokens.medium);
  expect(tokens.medium).toBeLessThan(tokens.high);
  expect(tokens.gap).toBeGreaterThan(0);
  expect(drawn.marked.length).toBe(asserted.length);
  // Coordinates are emitted at three decimals, so extents recovered from
  // them are exact only to two.
  expect(drawn.marked.map((mark) => Number(mark.extent.toFixed(2))).sort()).toEqual(
    asserted.map((edge) => Number(tokens[edge.weight].toFixed(2))).sort(),
  );
  for (const mark of drawn.marked) {
    // a tick that lay along its edge would vanish into the stroke
    // (coordinates are emitted at three decimals, hence the tolerance)
    expect(mark.alignment).toBeCloseTo(0, 3);
    expect(mark.offCentre).toBeCloseTo(0, 2);
  }
  expect(drawn.opened.length).toBe(unassessed.length);
  for (const opening of drawn.opened) {
    expect(opening.segments).toBe(2);
    expect(opening.tick).toBe(false);
    expect(opening.dropped).toBe(1);
    expect(opening.gap).toBeGreaterThan(0);
    expect(Number(opening.gap.toFixed(2))).toBeLessThanOrEqual(tokens.gap);
  }
});

test("density drops channels whole and in fixed order", async () => {
  // §16.2 A11: as density rises the channels drop whole and in the
  // fixed order — decision rails and weight marks together, then
  // labels, then interior texture and boundary continuity — and the
  // status line names what is not drawn, so the omission is never
  // silent. Density is spacing-driven, so the sparse demo at zoom 1
  // shows the full language. A selection is open so the label tier can
  // prove it drops the channel whole, selection included.
  await it.openState("#mode=field&focus=concept%3Ahttp-methods", "FIELD");
  const minus = it.page.getByRole("button", { name: "Zoom out" });
  const viewport = it.page.locator("svg .viewport");
  expect(await it.page.locator("svg .edge-weight").first().isVisible()).toBe(true);
  expect(await it.page.locator("svg .rail").first().isVisible()).toBe(true);
  expect(await it.page.locator("svg .weight-dropped").first().isVisible()).toBe(false);
  const edgeLabel = it.page.locator("svg .edge-label").first();
  await it.page.evaluate<void>(
    "document.querySelector('svg .edge-label').classList.add('visible')",
  );
  expect(await edgeLabel.isVisible()).toBe(true);
  expect(await it.page.locator("#status-bar").innerText()).not.toContain(
    "not drawn at this density",
  );

  await zoomOutUntil(it, viewport, minus, "drop-decision");
  expect(await viewport.getAttribute("class")).not.toContain("drop-labels");
  expect(await it.page.locator("svg .edge-weight").first().isVisible()).toBe(false);
  expect(await it.page.locator("svg .weight-detail").first().isVisible()).toBe(false);
  expect(await it.page.locator("svg .rail").first().isVisible()).toBe(false);
  expect(await it.page.locator("svg .weight-dropped").first().isVisible()).toBe(true);
  expect(await it.page.locator("svg .node-label").first().isVisible()).toBe(true);
  expect(await it.page.locator("#status-bar").innerText()).toContain(
    "not drawn at this density: decision rails, edge weight",
  );

  await zoomOutUntil(it, viewport, minus, "drop-labels");
  expect(await viewport.getAttribute("class")).not.toContain("drop-state");
  // The channel drops whole: no label survives, the selection's included.
  expect(await it.page.locator("svg .node-label:visible").count()).toBe(0);
  expect(await edgeLabel.isVisible()).toBe(false);
  expect(await it.page.locator("#status-bar").innerText()).toContain(
    "not drawn at this density: decision rails, edge weight, labels",
  );
  // The texture channel still draws between the label and state tiers.
  const hatchedFill = await it.page.evaluate<string>(
    "getComputedStyle(document.querySelector(" +
      "'g.node[data-node-id=\"concept:http-methods\"] .node-shape')).fill",
  );
  expect(hatchedFill).toContain("url");

  await zoomOutUntil(it, viewport, minus, "drop-state");
  expect(await it.page.locator("#status-bar").innerText()).toContain(
    "not drawn at this density: decision rails, edge weight, labels," +
      " state texture, freshness boundary",
  );
  // A node drawn without a boundary is drawn without state: the plate
  // falls back to its plain kind reading, never a cluster or heat.
  const droppedFill = await it.page.evaluate<string>(
    "getComputedStyle(document.querySelector(" +
      "'g.node[data-node-id=\"concept:http-methods\"] .node-shape')).fill",
  );
  expect(droppedFill).not.toContain("url");
});

test("hub and spoke density uses nearest neighbours", async () => {
  // Long incident spokes are not spacing: the leaves can overlap while
  // every hub edge remains long. A11 therefore keys the initial tier to
  // the cached median nearest-neighbour distance.
  const hub = conceptNode(it, "hub");
  const leaves = Array.from({ length: 48 }, (_, index) =>
    conceptNode(it, `leaf-${index.toString().padStart(2, "0")}`),
  );
  const edges: Dict[] = leaves.map((leaf) => ({
    source: hub["id"],
    target: leaf["id"],
    type: "related_to",
    provenance: [hub["id"], leaf["id"]],
    weight: "unassessed",
  }));
  it.writeGraph(it.graphEnvelope({ nodes: [hub, ...leaves], edges }));
  await it.openState("#mode=field", "FIELD", 30_000);
  const viewport = it.page.locator("svg .viewport");
  expect(await viewport.getAttribute("class")).toContain("drop-decision");
  expect(await it.page.locator("#status-bar").innerText()).toContain(
    "not drawn at this density: decision rails, edge weight",
  );
});

test("density recomputes when panel rescales the svg", async () => {
  // A11 consumes actual on-screen spacing. At this embed width the field
  // has room for the full language until the 320px detail panel opens;
  // the SVG ResizeObserver must then engage the omission tiers.
  await it.page.setViewportSize({ width: 800, height: 800 });
  await it.openState("#mode=field", "FIELD");
  const viewport = it.page.locator("svg .viewport");
  expect((await viewport.getAttribute("class")) ?? "").not.toContain("drop-decision");
  await it.page
    .locator('g.node[data-node-id="concept:http-methods"]')
    .dispatchEvent("click");
  await it.page.waitForSelector("#details:not([hidden])");
  await it.page.waitForFunction(
    "document.querySelector('svg .viewport').classList.contains('drop-decision')",
  );
  expect(await it.page.locator("#status-bar").innerText()).toContain(
    "not drawn at this density: decision rails, edge weight",
  );
});

test("density token overrides cannot invert drop order", async () => {
  // Tier values are tunable, but A11's order is not. A later threshold
  // that engages first must carry every preceding omission with it.
  await it.openState("#mode=field", "FIELD");
  await it.page.evaluate<void>(`(() => {
    const sheet = [...document.styleSheets].find(
      item => item.href?.endsWith("/viewer/viewer.css"));
    sheet.insertRule(
      ":root { --tier-decision-x: 0.01; "
        + "--tier-label-x: 100; --tier-state-x: 0.01; }",
      sheet.cssRules.length);
  })()`);
  await it.page.locator("#list-view").click();
  await it.page.waitForSelector('#main[data-state="LIST"]');
  await it.page.locator("#graph-view").click();
  await it.page.waitForSelector('#main[data-state="FIELD"]');
  const classes = await it.page.locator("svg .viewport").getAttribute("class");
  expect(classes).toContain("drop-decision");
  expect(classes).toContain("drop-labels");
  expect(classes).not.toContain("drop-state");
});
