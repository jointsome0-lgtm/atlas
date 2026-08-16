import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

import {
  DEMO_GRAPH,
  UNSUPPORTED_VERSION_FIXTURE,
  lab,
  type Fixture,
} from "./harness.ts";
import { hitPoint, viewportTransform } from "./helpers.ts";

type Dict = Record<string, unknown>;

async function evaluate<R>(it: Fixture, source: string): Promise<R> {
  return await it.page.evaluate<R>(`(${source})()`);
}

async function evaluateWithArgument<R>(
  it: Fixture,
  source: string,
  argument: unknown,
): Promise<R> {
  const encoded = JSON.stringify(argument);
  if (encoded === undefined) throw new TypeError("page.evaluate argument is not JSON-serializable");
  return await it.page.evaluate<R>(`(${source})(${encoded})`);
}

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

function chainGraph(it: Fixture): Dict {
  // a — b — c — d, plus one node joined to a by a suggested step alone
  // and one joined to nothing at all. The route and its plan carry the
  // step's context and are themselves unjoined.
  const nodes: Dict[] = ["a", "b", "c", "d", "far", "island"].map((name) => ({
    id: `concept:${name}`,
    type: "concept",
    title: name[0]!.toUpperCase() + name.slice(1),
    fields: ["knowledge"],
    aliases: [],
  }));
  nodes.push({
    id: "suggested-route:chain",
    type: "suggested_route",
    title: "Chain route",
    status: "available",
    source_plan: "plan:chain",
    fields: ["knowledge"],
  });
  nodes.push({
    id: "plan:chain",
    type: "plan",
    title: "Chain plan",
    fields: ["knowledge"],
  });
  const edges: Dict[] = [
    ["a", "b"],
    ["b", "c"],
    ["c", "d"],
  ].map(([left, right]) => ({
    source: `concept:${left}`,
    target: `concept:${right}`,
    type: "related_to",
    provenance: [`concept:${left}`],
    weight: "unassessed",
  }));
  edges.push({
    source: "concept:a",
    target: "concept:far",
    type: "suggested_next",
    provenance: ["suggested-route:chain"],
    context: "suggested-route:chain",
  });
  return it.graphEnvelope({ nodes, edges });
}

async function drawnIds(it: Fixture): Promise<string[]> {
  const ids = await evaluate<string[]>(
    it,
    `() => [...document.querySelectorAll("svg .node")]
      .map(node => node.dataset.nodeId)`,
  );
  return ids.sort();
}

test("focus horizon draws the named hops and says the field goes on", async () => {
  // Fog of war: past the horizon nothing is drawn, and nothing stands in
  // for it (A5, A11). The status line says the field continues, so the
  // dark never reads as the edge of the field — and says it without a
  // number: a running count of what lies ahead is a backlog reading, and
  // this system refuses those (§3, §4). Where the field continues is the
  // stubs' job, not the status line's.
  it.writeGraph(chainGraph(it));
  await it.openState("#mode=field&focus=concept:a", "FIELD");
  const horizon = it.page.locator("#horizon-select");
  expect(await horizon.inputValue()).toBe("all");
  expect((await drawnIds(it)).length).toBe(8);
  expect(await it.page.locator("#status-bar").innerText()).not.toContain(
    "past the focus horizon",
  );

  await horizon.selectOption("1");
  await it.page.waitForFunction(
    "() => document.querySelectorAll('svg .node').length === 3",
  );
  expect(await drawnIds(it)).toEqual(["concept:a", "concept:b", "concept:far"]);
  const status = await it.page.locator("#status-bar").innerText();
  expect(status).toContain("the field continues past the focus horizon");
  // No count of what is being kept out, in any wording.
  expect(status.split("continues past")[1]).not.toMatch(/\d/);

  await horizon.selectOption("2");
  await it.page.waitForFunction(
    "() => document.querySelectorAll('svg .node').length === 4",
  );
  expect(await drawnIds(it)).toEqual([
    "concept:a",
    "concept:b",
    "concept:c",
    "concept:far",
  ]);

  // An unjoined node is never inside any horizon, however wide.
  await horizon.selectOption("3");
  await it.page.waitForFunction(
    "() => document.querySelectorAll('svg .node').length === 5",
  );
  expect(await drawnIds(it)).not.toContain("concept:island");
});

test("the list carries the whole field past a horizon", async () => {
  // §16.3 bounds the node-link view alone. The list is A11's fallback and
  // carries the field's channels as columns, so a hop radius must not
  // thin it: a cut relation has a stub in the picture and would have
  // nothing at all here.
  it.writeGraph(chainGraph(it));
  await it.openState("#mode=field&focus=concept:a", "FIELD");
  await it.page.locator("#horizon-select").selectOption("1");
  await it.page.waitForFunction(
    "() => document.querySelectorAll('svg .node').length === 3",
  );
  await it.page.locator("#list-view").click();
  await it.page.waitForSelector(".node-list-row");
  expect(await it.page.locator(".node-list-row").count()).toBe(8);
  // A control that cannot act must not read as though it could.
  expect(await it.page.locator("#horizon-select").isDisabled()).toBe(true);
  expect(await it.page.locator("#status-bar").innerText()).not.toContain(
    "past the focus horizon",
  );
});

async function oversizedFocusedField(it: Fixture): Promise<void> {
  const nodes: Dict[] = Array.from({ length: 2401 }, (_, index) => ({
    id: `concept:n-${index}`,
    type: "concept",
    title: `Node ${index}`,
    fields: ["knowledge"],
    aliases: [],
  }));
  const edges: Dict[] = Array.from({ length: 3 }, (_, offset) => {
    const index = offset + 1;
    return {
      source: "concept:n-0",
      target: `concept:n-${index}`,
      type: "related_to",
      provenance: ["concept:n-0"],
      weight: "unassessed",
    };
  });
  it.writeGraph(it.graphEnvelope({ nodes, edges }));
  await it.openState("#mode=field&focus=concept:n-0", "LIST");
}

test("a horizon holding a hub back still meets the ceiling", async () => {
  // A hop radius can leave two plates in view and the whole rest of the
  // field cut at the rim — and every cut relation is drawn: a group, a
  // stroke, a hit band and a label apiece. Counting plates alone lets a
  // hub slip under §25.8's line and hand the frame a hundred thousand
  // marks it never agreed to.
  const nodes: Dict[] = Array.from({ length: 3000 }, (_, index) => ({
    id: `concept:h-${index}`,
    type: "concept",
    title: `Node ${index}`,
    fields: ["knowledge"],
    aliases: [],
  }));
  const edges: Dict[] = [
    {
      source: "concept:h-0",
      target: "concept:h-1",
      type: "related_to",
      provenance: ["concept:h-0"],
      weight: "unassessed",
    },
  ];
  edges.push(
    ...Array.from({ length: 2998 }, (_, offset) => {
      const index = offset + 2;
      return {
        source: "concept:h-1",
        target: `concept:h-${index}`,
        type: "related_to",
        provenance: ["concept:h-1"],
        weight: "unassessed",
      };
    }),
  );
  // §20.3: the builder emits relations in canonical identity order, and
  // the viewer rejects a shuffle rather than lay one out input-driven.
  edges.sort((left, right) => {
    const a = [left["type"], left["source"], left["target"]].join("\0");
    const b = [right["type"], right["source"], right["target"]].join("\0");
    return a.localeCompare(b);
  });
  it.writeGraph(it.graphEnvelope({ nodes, edges }));
  await it.openState("#mode=field&focus=concept:h-0", "LIST");
  await it.page.locator("#horizon-select").selectOption("1");
  // Two plates in view, and the fallback still holds: the rim is the
  // rest of the field.
  await it.page.waitForSelector('#main[data-state="LIST"]');
  expect(await it.page.locator("#graph-view").isDisabled()).toBe(true);
});

test("a horizon can bring an oversized field back into the picture", async () => {
  // Past the ceiling the list is forced, and the radius is the one
  // control that can bring the field back under it. Standing it down
  // there would shut the reader out of the node-link view for exactly
  // the fields a bounded one serves best.
  await oversizedFocusedField(it);
  const horizon = it.page.locator("#horizon-select");
  expect(await horizon.isDisabled()).toBe(false);
  await horizon.selectOption("1");
  await it.page.waitForSelector("#main[data-state='FIELD']");
  expect((await drawnIds(it)).length).toBe(4);
  expect(await it.page.locator("#graph-view").isDisabled()).toBe(false);
});

test("asking for the list the ceiling forced is not a locked door", async () => {
  // The forced fallback already reads as the list, so the reader may well
  // press the list again — and that press is a lens the reader chose,
  // which is the state the radius stands down for. With the graph shut by
  // the ceiling and the radius shut by the press, there would be no way
  // back to the picture at all.
  await oversizedFocusedField(it);
  await it.page.locator("#list-view").click();
  await it.page.waitForSelector("#main[data-state='LIST']");
  const horizon = it.page.locator("#horizon-select");
  expect(await horizon.isDisabled()).toBe(false);
  await horizon.selectOption("1");
  // The reader is still in the list they asked for, but the field under
  // the radius fits the picture again and the way back is open.
  await it.page.waitForSelector("#graph-view:not([disabled])");
  await it.page.locator("#graph-view").click();
  await it.page.waitForSelector("#main[data-state='FIELD']");
  expect((await drawnIds(it)).length).toBe(4);
});

test("focus horizon walks only the edges in view", async () => {
  // Hops are counted over what the reader can see: with routes hidden a
  // node joined only by a route step is not one hop away, because the
  // step that would make it one is not on the screen.
  it.writeGraph(chainGraph(it));
  await it.openState("#mode=field&focus=concept:a", "FIELD");
  await it.page.locator("#horizon-select").selectOption("1");
  await it.page.waitForFunction(
    "() => document.querySelectorAll('svg .node').length === 3",
  );
  expect(await drawnIds(it)).toContain("concept:far");

  await it.page.locator("#routes-toggle").click();
  await it.page.waitForFunction(
    "() => document.querySelectorAll('svg .node').length === 2",
  );
  expect(await drawnIds(it)).toEqual(["concept:a", "concept:b"]);
});

interface StubReach {
  near: number;
  far: number;
}

test("an edge leaving the horizon is drawn as far as the view reaches", async () => {
  // #99: a shown boundary is a drawn boundary. The edge b — c leaves the
  // one-hop view, so b keeps a stub pointing outward instead of looking
  // like a node with no further relations. The stub carries family and
  // nothing else — no arrowhead at an absent target, no weight tick at a
  // midpoint that is off screen (A3, A5).
  it.writeGraph(chainGraph(it));
  await it.openState("#mode=field&focus=concept:a", "FIELD");
  expect(await it.page.locator("svg .edge-stub").count()).toBe(0);

  await it.page.locator("#horizon-select").selectOption("1");
  await it.page.waitForFunction(
    "() => document.querySelectorAll('svg .node').length === 3",
  );
  const stubs = it.page.locator("svg .edge-stub");
  expect(await stubs.count()).toBe(1);
  expect(await stubs.first().getAttribute("class")).toContain("edge-authored");
  expect(await stubs.first().getAttribute("marker-end")).toBeNull();
  expect(await it.page.locator("svg .edge-stub-group .edge-weight").count()).toBe(0);

  // The stub starts outside its own plate and runs away from the focus,
  // so it never doubles back over the picture it came from.
  const reach = await evaluate<StubReach>(it, `() => {
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
  }`);
  expect(reach.far).toBeGreaterThan(reach.near);

  // A relation the reader cannot see leaves no stub behind: with routes
  // hidden the step a — far is not cut, it is simply not a relation on
  // the screen, so only the authored b — c still reaches outward.
  await it.page.locator("#routes-toggle").click();
  await it.page.waitForFunction(
    "() => document.querySelectorAll('svg .node').length === 2",
  );
  expect(await it.page.locator("svg .edge-stub").count()).toBe(1);
  expect(await it.page.locator("svg .edge-stub.edge-route").count()).toBe(0);
});

// Colours are authored in oklch and getComputedStyle hands that back
// verbatim, so contrast has to be measured through a canvas, which is the
// one place the browser will resolve a colour to the bytes it paints.
// Each family recedes to the same quiet level, so each is measured with
// its own token: colour, its recession, and the floor they all answer to.
const RECEDING_FAMILIES = [
  ["--e-authored", "--recede-authored"],
  ["--e-derived", "--recede-derived"],
  ["--e-route", "--recede-route"],
];

const CONTRAST_JS = `(names) => {
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
}`;

async function edgeStrokes(it: Fixture): Promise<string[]> {
  return await evaluate<string[]>(it, `() =>
    [...document.querySelectorAll("svg .edge-line")].map((line) => {
      const s = getComputedStyle(line);
      return [s.stroke, s.strokeWidth, s.strokeDasharray,
              line.getAttribute("marker-end") || ""].join("|");
    })`);
}

async function incidentPairs(it: Fixture): Promise<string[]> {
  const pairs = await evaluate<string[]>(
    it,
    `() => [...document.querySelectorAll("svg .edge-group.incident")].map(
      (g) => g.dataset.source + " " + (g.dataset.target || ""))`,
  );
  return pairs.sort();
}

interface RecededRelations {
  [family: string]: [number, number];
}

test("a selection answers with the relations that touch it", async () => {
  // §16.2 A9's focus feedback: picking a node lights the relations it
  // stands in by quieting the ones it does not, so the reader sees what
  // they picked joined to something rather than a ring on one plate.
  await it.openState("#mode=field", "FIELD");
  expect(await it.page.locator("svg .viewport.has-selection").count()).toBe(0);
  expect(await it.page.locator("svg .edge-group.incident").count()).toBe(0);

  await it.openState("#mode=field&focus=concept:http-methods", "FIELD");
  expect(await it.page.locator("svg .viewport.has-selection").count()).toBe(1);
  expect(await incidentPairs(it)).toEqual([
    "concept:http-methods concept:rest-api",
    "concept:http-methods question:demo-when-is-retry-safe",
    "material:mdn-http-methods concept:http-methods",
    "part:fastapi-tutorial/path-operations concept:http-methods",
    "part:mdn-http-methods/idempotency concept:http-methods",
  ]);

  // The quiet is a floor, not a disappearance: a receded relation still
  // answers the hand, and the panel names every one of them in words (A8).
  // Read once the quiet has settled — A9 gives focus feedback the one
  // transition there is, so the opacity is on its way for a moment.
  await it.page.waitForTimeout(300);
  const receded = await evaluate<RecededRelations>(it, `() => {
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
  }`);
  expect(Object.keys(receded).length).toBeGreaterThan(1);
  for (const [family, [drawn, authored]] of Object.entries(receded)) {
    expect(drawn, `${family} does not recede to its own token`).toBeCloseTo(authored, 2);
  }
  const panel = await it.page.locator("#details").innerText();
  for (const named of ["concept:rest-api", "part:mdn-http-methods/idempotency"]) {
    expect(panel).toContain(named);
  }

  // Moving the selection moves the lit set with it, and clearing it
  // returns the field whole.
  await it.page.locator("#close-details").click();
  await it.page.waitForSelector("svg .viewport:not(.has-selection)");
  expect(await it.page.locator("svg .edge-group.incident").count()).toBe(0);
});

test("the emphasis spends no family channel", async () => {
  // A3 tripwire: stroke colour, dash and width carry edge family and
  // nothing else. Whatever a selection does to the picture, it may not
  // touch them — element for element. The emphasis is switched on the
  // standing picture rather than by opening a second address, so the
  // camera is identical and only the emphasis differs.
  await it.openState("#mode=field&focus=concept:http-methods", "FIELD");
  const lit = await edgeStrokes(it);
  await evaluate<void>(
    it,
    `() => document.querySelector("svg .viewport")
      .classList.remove("has-selection")`,
  );
  expect(await edgeStrokes(it)).toEqual(lit);
});

test("the trail never recedes behind a selection", async () => {
  // A7: a suggested route never renders brighter than the trail it
  // parallels. A route touching the selection beside a trail edge that
  // does not is exactly that inversion, so the trail is exempt — the
  // reader's real path is the one thing the looking never dims.
  await it.openState("#mode=field&focus=concept:http-methods", "FIELD");
  const trails = it.page.locator('svg .edge-group[data-family="trail"]:not(.incident)');
  const trailCount = await trails.count();
  expect(trailCount).toBeGreaterThan(0);
  expect(
    await evaluate<string[]>(
      it,
      `() => [...document.querySelectorAll(
        'svg .edge-group[data-family="trail"]:not(.incident)')].map(
        (g) => getComputedStyle(g.querySelector(".edge-line")).opacity)`,
    ),
  ).toEqual(Array(trailCount).fill("1"));
});

interface ContrastMeasurement {
  rule: number;
  receded: Record<string, number>;
  alphas: Record<string, number>;
  surface: string;
  ground: string;
}

async function expectRecessionClearsTheRule(it: Fixture, label: string): Promise<void> {
  const measured = await evaluateWithArgument<ContrastMeasurement>(
    it,
    CONTRAST_JS,
    RECEDING_FAMILIES,
  );
  // The field is not the panel: an edge paints on --page and the plates
  // are the --ground above it, so a recession calibrated on --ground is
  // calibrated on a surface no relation touches.
  expect(measured.surface, label).not.toBe(measured.ground);
  for (const [name, ratio] of Object.entries(measured.receded)) {
    expect(measured.alphas[name], label).toBeGreaterThan(0);
    expect(
      ratio,
      `${label}: ${name} recedes below --rule: ${ratio.toFixed(2)} < ${measured.rule.toFixed(2)}`,
    ).toBeGreaterThanOrEqual(measured.rule);
  }
  // And they recede TO that level, not merely above it: one shared
  // amount would leave the darkest family darker than an undimmed faint
  // one, which is the reading failing to carry.
  const quiet = Object.values(measured.receded);
  expect(Math.max(...quiet) - Math.min(...quiet), label).toBeLessThan(0.25 * measured.rule);
}

test("a receded relation is still a drawn relation", async () => {
  // The recession is bounded by the sheet's own hairline: no family may
  // fall below the presence --rule already carries, that being the
  // faintest line this design draws on purpose. Below it the channel has
  // not receded, it has dropped — and dropping belongs to A11's fixed
  // order and to the focus horizon, never to a selection.
  // Both palettes: the two surfaces sit on opposite sides of the ground
  // in light and in dark, so an amount calibrated on one is calibrated on
  // neither.
  for (const scheme of ["light", "dark"] as const) {
    await it.page.emulateMedia({ colorScheme: scheme });
    await it.openState("#mode=field&focus=concept:http-methods", "FIELD");
    await expectRecessionClearsTheRule(it, `scheme=${scheme}`);
  }
});

const LABEL_INK_JS = `() => {
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
}`;

async function wideTitledField(it: Fixture, title: string, count = 11): Promise<void> {
  // A chain of eleven, which the seeded layout spreads far enough that
  // every one of these labels has a free slot to be put in. So a label
  // sitting on a plate here is the estimate being wrong and not the
  // field being full — the sweep never drops a label, it falls back.
  const nodes: Dict[] = Array.from({ length: count }, (_, index) => ({
    id: `concept:w${String(index).padStart(2, "0")}`,
    type: "concept",
    title,
    fields: ["knowledge"],
    aliases: [],
  }));
  const edges: Dict[] = Array.from({ length: nodes.length - 1 }, (_, index) => ({
    source: `concept:w${String(index).padStart(2, "0")}`,
    target: `concept:w${String(index + 1).padStart(2, "0")}`,
    type: "related_to",
    provenance: [`concept:w${String(index).padStart(2, "0")}`],
    weight: "unassessed",
  }));
  it.writeGraph(it.graphEnvelope({ nodes, edges }));
  await it.openState("#mode=field", "FIELD");
}

interface LabelInk {
  count: number;
  overlaps: string[];
}

test("a title of wide glyphs reserves the room it takes", async () => {
  // The label box is estimated, never measured — the picture is seeded
  // (§27.8) and a measured string would follow whichever font the reader
  // resolves. But one mean advance per glyph is an estimate that only
  // holds for mixed-case Latin: a title of full-width script, or of the
  // widest Latin capitals, takes about twice it, and the sweep then
  // accepts a slot the text runs straight out of and onto a plate.
  for (const title of ["知识图谱与检索增强生成模型学习", "W".repeat(15)]) {
    await wideTitledField(it, title);
    const drawn = await evaluate<LabelInk>(it, LABEL_INK_JS);
    expect(drawn.count, `title=${title}`).toBe(11);
    expect(drawn.overlaps, `title=${title}`).toEqual([]);
  }
});

test("a title at the boundary is inside the opening frame", async () => {
  // The opening fit is what the reader is handed before touching
  // anything. A label is drawn beside its plate and reaches further out
  // than the plate does, so a fit taken from the radii alone hands a
  // boundary node's title to the edge of the frame and cuts it there —
  // with no tier having dropped it and nothing said (A11).
  await it.page.setViewportSize({ width: 700, height: 900 });
  await wideTitledField(it, "W".repeat(15), 40);
  const outside = await evaluate<number[]>(it, `() => {
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
  }`);
  expect(outside).toEqual([]);
});

test("the emphasis stands down under forced colours", async () => {
  // The system palette has no rank below its own text, so there is no
  // quieter level left that still clears the rule. Rather than break the
  // floor the emphasis stops being drawn; the selection still answers
  // through the ring and through the panel's words (A8).
  await it.page.emulateMedia({ forcedColors: "active" });
  await it.openState("#mode=field&focus=concept:http-methods", "FIELD");
  expect(await it.page.locator("svg .node.selected").count()).toBe(1);
  expect(
    await evaluate<string[]>(it, `() => {
      const root = getComputedStyle(document.documentElement);
      return ["--recede-authored", "--recede-derived", "--recede-route"].map(
        (name) => String(Number(root.getPropertyValue(name))));
    }`),
  ).toEqual(Array(3).fill("1"));
  const opacities = await evaluate<string[]>(
    it,
    `() => [...new Set([...document.querySelectorAll("svg .edge-group .edge-line")]
      .map((l) => getComputedStyle(l).opacity))]`,
  );
  expect(opacities).toEqual(["1"]);
});

const LANE_TRIM_JS = `() => {
  const centre = (id) => {
    const [x, y] = document
      .querySelector(\`svg .node[data-node-id="\${id}"]\`)
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
}`;

test("a lane is trimmed for the ray it actually draws", async () => {
  // The trim clears everything the plate draws along the ray. A lane has
  // moved that ray off the centre, where it leaves the plate sooner and
  // can meet a mark the centre ray passed by — so the marks move under
  // the offset ray rather than the centre extent being reused.
  const nodes: Dict[] = [
    {
      id: "concept:alpha",
      type: "concept",
      title: "Alpha",
      fields: ["knowledge"],
      aliases: [],
    },
    {
      id: "concept:beta",
      type: "concept",
      title: "Beta",
      fields: ["knowledge"],
      aliases: [],
    },
  ];
  const forward: Dict = {
    type: "prerequisite_of",
    source: "concept:alpha",
    target: "concept:beta",
    provenance: ["concept:alpha"],
    weight: "unassessed",
  };
  const back: Dict = {
    type: "prerequisite_of",
    source: "concept:beta",
    target: "concept:alpha",
    provenance: ["concept:beta"],
    weight: "unassessed",
  };

  it.writeGraph(it.graphEnvelope({ nodes, edges: [forward] }));
  await it.openState("#mode=field", "FIELD");
  const centred = await evaluate<number[]>(it, LANE_TRIM_JS);
  expect(centred.length).toBe(1);

  it.writeGraph(it.graphEnvelope({ nodes, edges: [forward, back] }));
  await it.openState("#mode=field", "FIELD");
  const laned = await evaluate<number[]>(it, LANE_TRIM_JS);
  expect(laned.length).toBe(2);
  // A parallel offset cuts a chord, so an offset ray leaves the plate
  // sooner than the centre one — reusing the centre extent would trim
  // both the same and let the stroke run under whatever it passed.
  for (const trim of laned) {
    expect(centred[0]! - trim).toBeGreaterThan(0.2);
  }
});

test("a reciprocal pair of relations takes two lanes", async () => {
  // a→b and b→a are both allowed, and each says its own thing. Drawn on
  // the one axis they stack exactly and the field shows one claim where
  // the graph holds two, so the lane offset is taken along the pair's own
  // axis rather than along each edge's direction.
  const nodes: Dict[] = [
    {
      id: "concept:alpha",
      type: "concept",
      title: "Alpha",
      fields: ["knowledge"],
      aliases: [],
    },
    {
      id: "concept:beta",
      type: "concept",
      title: "Beta",
      fields: ["knowledge"],
      aliases: [],
    },
  ];
  const edges: Dict[] = [
    {
      type: "prerequisite_of",
      source: "concept:alpha",
      target: "concept:beta",
      provenance: ["concept:alpha"],
      weight: "unassessed",
    },
    {
      type: "prerequisite_of",
      source: "concept:beta",
      target: "concept:alpha",
      provenance: ["concept:beta"],
      weight: "unassessed",
    },
  ];
  it.writeGraph(it.graphEnvelope({ nodes, edges }));
  await it.openState("#mode=field", "FIELD");
  // Measured across the axis, not along it: differing end trims already
  // move the two strokes lengthwise, and that is not a lane.
  const apart = await evaluate<number | null>(it, `() => {
    const centre = (id) => {
      const node = document.querySelector(
        \`svg .node[data-node-id="\${id}"]\`);
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
  }`);
  expect(apart, "expected exactly two drawn relations").not.toBeNull();
  expect(apart as number).toBeGreaterThan(5);
});

const DRAG_JS = `([dx, dy]) => {
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
}`;

async function dragGround(it: Fixture, dx: number, dy: number): Promise<number> {
  /** Drag from the middle of the canvas; answer how far the camera went. */
  return await evaluateWithArgument<number>(it, DRAG_JS, [dx, dy]);
}

test("a pan over bare ground keeps the selection", async () => {
  // Taking hold of the picture is not letting go of the node: dragging
  // the ground moves the camera and nothing else.
  await it.openState("#mode=field&focus=concept:http-methods", "FIELD");
  expect(await it.page.locator("svg .node.selected").count()).toBe(1);
  const moved = await dragGround(it, 120, 60);
  expect(moved).toBeGreaterThan(50);
  await it.page.waitForTimeout(250);
  expect(await it.page.locator("svg .node.selected").count()).toBe(1);
  expect(await it.page.locator("svg .viewport.has-selection").count()).toBe(1);
  expect(await it.page.locator("#details").isHidden()).toBe(false);
});

test("a press that shakes leaves the camera where it was", async () => {
  // A hand wobbles a pixel or two on the way to a click. That is a press,
  // so the picture holds still; otherwise every click nudges the field
  // and the nudges accumulate.
  await it.openState("#mode=field", "FIELD");
  expect(await dragGround(it, 1, 1)).toBe(0.0);
  expect(await dragGround(it, -2, 1)).toBe(0.0);
});

test("a press that shakes in place still opens the node", async () => {
  // A shake is not a journey. Six wobbles inside one pixel add up past
  // the slop only if the path is summed, and then the press becomes a
  // pan: the plate under the hand never opens and the camera drifts.
  // The real mouse, because the point is the click the browser would
  // have synthesised.
  await it.openState("#mode=field", "FIELD");
  const spot = await hitPoint(it, ".node-shape");
  expect(spot, "no reachable plate").not.toBeNull();
  const before = await viewportTransform(it);
  const [x, y] = spot as [number, number];
  await it.page.mouse.move(x, y);
  await it.page.mouse.down();
  for (const [dx, dy] of [
    [1, 0],
    [0, 0],
    [1, 1],
    [0, 1],
    [1, 0],
    [0, 0],
  ] as const) {
    await it.page.mouse.move(x + dx, y + dy);
  }
  await it.page.mouse.up();
  await it.page.waitForTimeout(250);
  expect(await it.page.locator("svg .node.selected").count()).toBe(1);
  expect(new URL(await it.page.url()).hash).toContain("focus=");
  expect(await viewportTransform(it)).toBe(before);
});

interface RecedingMark {
  opacity: number;
  strokeOpacity: number;
}

test("a relation recedes arrowhead and all", async () => {
  // An arrowhead is a marker filled with context-stroke, which copies the
  // stroke's paint but not its opacity, so a recession spent on
  // stroke-opacity leaves bright heads scattered through the quiet.
  await it.openState("#mode=field&focus=concept:http-methods", "FIELD");
  // Read once A9's transition has settled.
  await it.page.waitForTimeout(300);
  const marked = await evaluate<RecedingMark | null>(it, `() => {
    const group = [...document.querySelectorAll(
      "svg .edge-group:not(.incident)")].find(
      (g) => g.dataset.family !== "trail"
        && g.querySelector(".edge-line").getAttribute("marker-end"));
    if (!group) return null;
    const style = getComputedStyle(group.querySelector(".edge-line"));
    return {opacity: Number(style.opacity),
            strokeOpacity: Number(style.strokeOpacity)};
  }`);
  expect(marked, "no receding directed relation to measure").not.toBeNull();
  expect((marked as RecedingMark).opacity).toBeLessThan(1);
  expect((marked as RecedingMark).strokeOpacity).toBe(1);
});

interface HitReach {
  zoom: number;
  withFloor: number;
  scaled: number;
  onEdge: boolean;
}

test("a field fitted by zoom keeps a reachable hit band", async () => {
  // Opening a field larger than the frame drops the zoom floor to the fit
  // (#99/§16.3), and a hit band that scaled with it would be a fraction of
  // a pixel wide — a drawn relation that no hand can reach.
  const nodes: Dict[] = Array.from({ length: 140 }, (_, index) => ({
    id: `concept:n${String(index).padStart(3, "0")}`,
    type: "concept",
    title: `N${String(index).padStart(3, "0")}`,
    fields: ["knowledge"],
    aliases: [],
  }));
  const edges: Dict[] = Array.from({ length: nodes.length - 1 }, (_, index) => ({
    source: `concept:n${String(index).padStart(3, "0")}`,
    target: `concept:n${String(index + 1).padStart(3, "0")}`,
    type: "related_to",
    provenance: [`concept:n${String(index).padStart(3, "0")}`],
    weight: "unassessed",
  }));
  it.writeGraph(it.graphEnvelope({ nodes, edges }));
  await it.openState("#mode=field", "FIELD");
  const reach = await evaluate<HitReach>(it, `() => {
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
  }`);
  expect(reach.zoom, "expected a field fitted by zoom").toBeLessThan(1);
  expect(reach.onEdge, "the middle of a drawn relation is not on it").toBe(true);
  expect(reach.withFloor).toBeGreaterThanOrEqual(4);
  expect(reach.withFloor).toBeGreaterThan(reach.scaled);
});

// On-screen size of a stroke authored in viewBox units, and the family
// widths beside it: the picture's own scale times the camera's.
const DRAWN_JS = `() => {
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
}`;

interface DrawnMeasurement {
  zoom: number;
  rendered: number;
  widths: Record<string, number>;
  plate: number;
  head: number;
}

async function bigField(it: Fixture, count: number): Promise<void> {
  const nodes: Dict[] = Array.from({ length: count }, (_, index) => ({
    id: `concept:n${String(index).padStart(4, "0")}`,
    type: "concept",
    title: `N${String(index).padStart(4, "0")}`,
    fields: ["knowledge"],
    aliases: [],
  }));
  const edges: Dict[] = Array.from({ length: nodes.length - 1 }, (_, index) => ({
    source: `concept:n${String(index).padStart(4, "0")}`,
    target: `concept:n${String(index + 1).padStart(4, "0")}`,
    type: "related_to",
    provenance: [`concept:n${String(index).padStart(4, "0")}`],
    weight: "unassessed",
  }));
  it.writeGraph(it.graphEnvelope({ nodes, edges }));
  await it.openState("#mode=field", "FIELD");
}

test("a field fitted by zoom still draws its relations", async () => {
  // A stroke that scales all the way down does not thin, it goes: at the
  // opening fit of a field this size it paints a fortieth of a pixel and
  // no family reaches the contrast a rule carries against the ground.
  // That is omission, and omission belongs to A11's order (§16.3).
  await bigField(it, 700);
  const drawn = await evaluate<DrawnMeasurement>(it, DRAWN_JS);
  expect(drawn.zoom, "expected a field far past the fit").toBeLessThan(0.1);
  const thinnest = Math.min(...Object.values(drawn.widths));
  // The coverage --e-route needs to carry --rule's contrast on --ground,
  // measured; without the lift this family paints about 0.05.
  expect(thinnest * drawn.zoom * drawn.rendered).toBeGreaterThanOrEqual(0.5);
  // The lift multiplies each family's own width, so width still carries
  // family alone (A3) — a shared floor would merge these.
  const base = drawn.widths["edge-route"]!;
  expect(drawn.widths["edge-structural"]! / base).toBeCloseTo(1.0, 3);
  expect(drawn.widths["edge-journal"]! / base).toBeCloseTo(1.25, 3);
  expect(drawn.widths["edge-authored"]! / base).toBeCloseTo(1.5, 3);
  expect(drawn.widths["edge-trail"]! / base).toBeCloseTo(2.5, 3);
});

test("a narrow embed keeps the floor and the hit band", async () => {
  // The frame scales the picture as surely as the camera does (§16.4), so
  // a floor measured in screen pixels has to see both: at half the frame
  // a floor blind to it lands at half the presence it promised.
  await it.page.setViewportSize({ width: 450, height: 325 });
  await it.openState("#mode=field", "FIELD");
  const embed = await evaluate<DrawnMeasurement>(it, DRAWN_JS);
  expect(embed.rendered, "expected a narrow frame").toBeLessThan(0.6);
  const thinnest = Math.min(...Object.values(embed.widths));
  expect(thinnest * embed.zoom * embed.rendered).toBeGreaterThanOrEqual(0.5);
  const band = await evaluate<number>(it, `() => {
    const hit = document.querySelector("svg .edge-hit");
    const svg = document.querySelector("svg.graph-svg");
    const rendered = Math.min(
      svg.getBoundingClientRect().width / svg.viewBox.baseVal.width,
      svg.getBoundingClientRect().height / svg.viewBox.baseVal.height);
    const zoom = Number(document.querySelector(".viewport")
      .getAttribute("transform").match(/scale\\(([-\\d.]+)\\)/)[1]);
    return Number.parseFloat(getComputedStyle(hit).strokeWidth)
      * zoom * rendered;
  }`);
  expect(band).toBeGreaterThanOrEqual(11.5);
});

// What a quieted relation actually lays down: the painted width capped at a
// pixel is the coverage, and the opacity is spent on top of it.
const QUIET_COVERAGE_JS = `() => {
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
}`;

interface QuietCoverage {
  screen: number;
  families: Record<string, number>;
  floored: boolean;
  wanted: Record<string, number>;
}

test("the quiet is spent out of what the stroke actually lays down", async () => {
  // A stroke narrower than a pixel does not paint a thin line, it paints
  // a pale one — the width is the coverage. So a family already spending
  // part of its presence on being drawn has that much less to spend on
  // being quiet, and the amount measured at full width would take it
  // under §16.3's floor. Three frames: the lift working, the stretch
  // above the hairline where it has not started but the one-unit families
  // are already under a pixel, and the field at its own size.
  let measured!: QuietCoverage;
  for (const [width, height] of [
    [450, 325],
    [1000, 720],
    [1280, 900],
  ] as const) {
    const frame = `frame=${width}x${height}`;
    await it.page.setViewportSize({ width, height });
    await it.openState("#mode=field&focus=concept:http-methods", "FIELD");
    // Read once A9's transition has settled.
    await it.page.waitForTimeout(300);
    measured = await evaluate<QuietCoverage>(it, QUIET_COVERAGE_JS);
    expect(Object.keys(measured.families).length, frame).toBeGreaterThan(0);
    for (const [family, laid] of Object.entries(measured.families)) {
      const wanted = measured.wanted[family]!;
      expect(
        laid,
        `${frame}: ${family} lays down ${laid.toFixed(3)} of the ${wanted} the floor asks, ` +
          `at screen scale ${measured.screen}`,
      ).toBeGreaterThanOrEqual(wanted - 0.005);
    }
  }
  // And the quiet is still a quiet: at its own size the field recedes by
  // exactly the sheet's amounts, the division being the identity there.
  expect(measured.screen).toBeGreaterThanOrEqual(1);
  expect(measured.floored).toBe(false);
  for (const [family, laid] of Object.entries(measured.families)) {
    expect(laid).toBeCloseTo(measured.wanted[family]!, 2);
  }
});

test("a lifted stroke does not cap back over the plate", async () => {
  // The endpoints were trimmed to clear the glyph at the width the field
  // was solved at. A round cap runs half the stroke past its endpoint, so
  // once the floor lifts the stroke the cap reaches back over the plate.
  await bigField(it, 1400);
  const capped = await evaluate<DrawnMeasurement>(it, DRAWN_JS);
  expect(
    await evaluate<string>(it, `() => getComputedStyle(
      document.querySelector("svg .edge-line")).strokeLinecap`),
  ).toBe("butt");
  // And the reach a round cap would have had is real, not hypothetical:
  // half the widest lifted stroke against the trim that cleared the plate.
  expect(Math.max(...Object.values(capped.widths)) / 2).toBeGreaterThan(
    capped.plate / 2 + 2,
  );
});

test("a field at its own scale keeps its round caps", async () => {
  // The squaring off belongs to the floor alone: a field that opens whole
  // is drawn exactly as authored.
  await it.openState("#mode=field", "FIELD");
  expect(
    await evaluate<string>(it, `() => getComputedStyle(
      document.querySelector("svg .edge-line")).strokeLinecap`),
  ).toBe("round");
});

test("a direction mark never outgrows the plate it points at", async () => {
  // The head is sized in stroke-width units, so the stroke's own lift
  // would multiply it too and the arrow would swallow its target.
  await bigField(it, 700);
  const drawn = await evaluate<DrawnMeasurement>(it, DRAWN_JS);
  const widest = Math.max(...Object.values(drawn.widths));
  expect(drawn.head * widest).toBeLessThan(drawn.plate);
});

test("the family widths survive a palette that drops the hairline", async () => {
  // A variant is a token swap, and one that redeclares the root without
  // this token must not collapse every family onto one width (A3).
  await it.openState("#mode=field", "FIELD");
  await evaluate<void>(
    it,
    `() => document.documentElement.style
      .setProperty("--edge-hairline", "initial")`,
  );
  const drawn = await evaluate<DrawnMeasurement>(it, DRAWN_JS);
  const base = drawn.widths["edge-route"]!;
  expect(drawn.widths["edge-journal"]! / base).toBeCloseTo(1.25, 3);
  expect(drawn.widths["edge-trail"]! / base).toBeCloseTo(2.5, 3);
});
