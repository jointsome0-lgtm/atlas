import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";

import {
  DEMO_GRAPH,
  REJECTED_ACCEPTANCE,
  lab,
  type Dict,
  type Fixture,
} from "./harness.ts";
import {
  chainGraph,
  dragFrom,
  hitPoint,
  incidentPairs,
  measuredDash,
  viewportTransform,
  wideRouteField,
} from "./helpers.ts";

interface Diagnostic {
  path: string;
  rule: string;
}

interface FieldGeometry {
  scale: number;
  plates: number;
  outside: number;
  overlaps: number;
}

const EXPECTED_REJECTED_FIXTURES: Record<string, Diagnostic> = {
  "dangling-provenance.json": { path: "/edges/0/provenance", rule: "danglingRef" },
  "discriminant-on-wrong-edge-type.json": {
    path: "/edges/0/order",
    rule: "forbiddenDiscriminant",
  },
  "duplicate-edge-identity.json": { path: "/edges/1", rule: "duplicateIdentity" },
  "duplicate-node-id.json": { path: "/nodes/1/id", rule: "duplicateId" },
  "duplicate-provenance.json": { path: "/edges/0/provenance", rule: "canonicalSet" },
  "formerly-on-journal-backed-kind.json": {
    path: "/nodes/1/formerly",
    rule: "noRedirectMachinery",
  },
  "impossible-edge-date.json": { path: "/edges/0/created_at", rule: "date" },
  "impossible-generated-at-date.json": { path: "/generated_at", rule: "shape" },
  "impossible-node-date.json": { path: "/nodes/0/observed_at", rule: "shape" },
  "impossible-state-decision-date.json": { path: "/state", rule: "date" },
  "impossible-state-last-seen-date.json": { path: "/state", rule: "contactDates" },
  "kind-changing-formerly-redirect.json": {
    path: "/nodes/0/formerly",
    rule: "kindChange",
  },
  "living-formerly-redirect.json": { path: "/nodes/1/formerly", rule: "livingRedirect" },
  "material-part-parent-mismatch.json": { path: "/nodes/2/material", rule: "partParent" },
  "non-canonical-edge-array-order.json": { path: "/edges/1", rule: "canonicalOrder" },
  "one-to-n-formerly-redirect.json": {
    path: "/nodes/1/formerly",
    rule: "duplicateRedirect",
  },
  "payload-on-wrong-node-kind.json": { path: "/nodes/0/url", rule: "kindProperty" },
  "primary-supporting-role-conflict.json": { path: "/edges/1", rule: "roleConflict" },
  "projection-key-not-zone-id.json": { path: "/projections", rule: "zoneKey" },
  "reversed-related-to-pair.json": { path: "/edges/0", rule: "canonicalOrder" },
  "self-referential-edge.json": { path: "/edges/0/target", rule: "selfEdge" },
  // §14.7/#108: last_seen equals the as-of, so the derivation says fresh and
  // the file says stale. Everything else about the entry is valid, which is
  // the point — the class is the only defect, and an exact recompute is the
  // only check that can see it (a monotonicity rule has one entry to compare).
  "state-freshness-not-derived.json": {
    path: "/state/freshness",
    rule: "derivedFreshness",
  },
  "state-entry-missing-required.json": { path: "/state", rule: "required" },
  "state-entry-not-an-object.json": { path: "/state", rule: "entryShape" },
  "state-entry-unknown-property.json": {
    path: "/state",
    rule: "additionalProperties",
  },
  "state-entry-wrong-node-kind.json": {
    path: "/state",
    rule: "additionalProperties",
  },
  "state-key-without-node.json": { path: "/state", rule: "danglingKey" },
  "state-missing-default-entry.json": { path: "/state", rule: "missingDefault" },
  "step-on-non-route-material-role.json": {
    path: "/edges/0/step",
    rule: "forbiddenDiscriminant",
  },
  "unsorted-provenance.json": { path: "/edges/0/provenance", rule: "canonicalSet" },
  "zone-without-projection.json": {
    path: "/projections",
    rule: "zoneWithoutProjection",
  },
};

// A layout is the one thing on this screen that costs real time, so the tests below watch for
// it directly: every LAYOUT the viewer enters is recorded, and the picture is compared plate by
// plate.
const WATCH_JS = `() => {
  window.__states = [];
  window.__svg = document.querySelector("svg.graph-svg");
  new MutationObserver((records) => {
    for (const record of records) {
      window.__states.push(document.querySelector("#main").dataset.state);
    }
  }).observe(document.querySelector("#main"),
             {attributes: true, attributeFilter: ["data-state"]});
}`;
const PLATES_JS = `() => [...document.querySelectorAll("svg .node")].map(
  (g) => g.dataset.nodeId + "@" + g.getAttribute("transform"))`;

function stateFor(graph: Dict, id: string): Dict {
  return (graph["state"] as Dict)[id] as Dict;
}

async function evaluate<R>(it: Fixture, source: string): Promise<R> {
  return await it.page.evaluate<R>(`(${source})()`);
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

test("a cancelled drag does not eat the next click", async () => {
  // A cancelled pointer sequence synthesises no click, so the suppression a completed pan arms
  // has nothing to clear it — and the reader's next ordinary click is swallowed instead.
  await it.openState("#mode=field", "FIELD");
  await evaluate<void>(it, `() => {
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
  }`);
  await it.page.locator('svg .node[data-node-id="concept:idempotency"]').click();
  await it.page.waitForSelector("svg .node.selected");
  expect(await it.page.locator("svg .node.selected").count()).toBe(1);
});

test("a press released off the canvas does not follow the hand back", async () => {
  // Below the slop the gesture is not yet captured, so a press that leaves the element never gets
  // its pointerup — and the drag would still be standing when the pointer wanders back with no
  // button held.
  await it.openState("#mode=field", "FIELD");
  const box = (await it.page.locator("svg.graph-svg").boundingBox())!;
  const middle = box.y + box.height / 2;
  const before = await viewportTransform(it);
  await it.page.mouse.move(box.x + 6, middle);
  await it.page.mouse.down();
  await it.page.mouse.move(box.x - 40, middle);
  await it.page.mouse.up();
  await it.page.mouse.move(box.x + 200, middle);
  await it.page.mouse.move(box.x + 400, middle);
  await it.page.waitForTimeout(150);
  expect(await viewportTransform(it)).toBe(before);
});

test("changing focus repaints the field instead of solving it again", async () => {
  // The same drawn set settles into the same picture every time (§27.8), so solving it again on a
  // click is a reader waiting to be shown what they were already looking at. The picture is
  // repainted: same tree, same coordinates, no LAYOUT, no blank stage.
  await it.openState("#mode=field", "FIELD");
  const before = await evaluate<string[]>(it, PLATES_JS);
  await evaluate<void>(it, WATCH_JS);
  await it.page.locator('svg .node[data-node-id="concept:idempotency"]').click();
  await it.page.waitForSelector(
    'svg .node.selected[data-node-id="concept:idempotency"]',
  );
  expect(await evaluate<string[]>(it, "() => window.__states")).not.toContain("LAYOUT");
  expect(
    await evaluate<boolean>(
      it,
      "() => window.__svg === document.querySelector('svg.graph-svg')",
    ),
  ).toBe(true);
  expect(await evaluate<string[]>(it, PLATES_JS)).toEqual(before);
  expect(await it.page.locator("svg .node.selected").count()).toBe(1);
  expect(await it.page.locator("svg .node.selected").getAttribute("tabindex")).toBe("0");

  // And again, onto a second node, from the panel's own relation list.
  await evaluate<void>(it, "() => { window.__states.length = 0; }");
  await it.page.locator("#details button", { hasText: "concept:redis" }).first().click();
  await it.page.waitForSelector('svg .node.selected[data-node-id="concept:redis"]');
  expect(await evaluate<string[]>(it, "() => window.__states")).not.toContain("LAYOUT");
  expect(await evaluate<string[]>(it, PLATES_JS)).toEqual(before);
  expect(await it.page.locator("svg .node.selected").count()).toBe(1);
});

test("each drawn set is solved once and then remembered", async () => {
  // The memo is keyed on what is drawn: a new drawn set is an honest miss and is solved, and every
  // return to one already solved gives back the identical picture without solving it again —
  // which is only ever the picture §27.8 would have produced anyway.
  it.writeGraph(chainGraph(it));
  await it.openState("#mode=field&focus=concept:a", "FIELD");
  const horizon = it.page.locator("#horizon-select");
  const whole = await evaluate<string[]>(it, PLATES_JS);
  await evaluate<void>(it, WATCH_JS);

  // A narrower horizon is a drawn set nothing has solved yet.
  await horizon.selectOption("1");
  await it.page.waitForFunction(
    "() => document.querySelectorAll('svg .node').length === 3",
  );
  const narrow = await evaluate<string[]>(it, PLATES_JS);
  expect(await evaluate<string[]>(it, "() => window.__states")).toContain("LAYOUT");

  // Both directions now come back from the memo, unchanged.
  for (const [option, count, expected] of [
    ["all", 8, whole],
    ["1", 3, narrow],
  ] as const) {
    await evaluate<void>(it, "() => { window.__states.length = 0; }");
    await horizon.selectOption(option);
    await it.page.waitForFunction(
      `() => document.querySelectorAll('svg .node').length === ${count}`,
    );
    expect(
      await evaluate<string[]>(it, "() => window.__states"),
      `option=${option}`,
    ).not.toContain("LAYOUT");
    expect(await evaluate<string[]>(it, PLATES_JS), `option=${option}`).toEqual(expected);
  }
});

test("the routes lens redraws from the remembered layout", async () => {
  // The Routes lens keeps the layout and changes the drawn edges, so an equal memo key is not an
  // equal picture across it. Without that guard a hidden route would stay on the screen.
  await it.openState("#mode=field&focus=concept:idempotency", "FIELD");
  const before = await evaluate<string[]>(it, PLATES_JS);
  const drawn = await it.page.locator("svg .edge-group").count();
  await evaluate<void>(it, WATCH_JS);

  await it.page.locator("#routes-toggle").click();
  await it.page.waitForSelector("#main[data-state='FIELD']");
  expect(await it.page.locator("svg .edge-group").count()).toBeLessThan(drawn);
  expect(await it.page.locator("svg .edge-line.edge-route").count()).toBe(0);
  expect(await evaluate<string[]>(it, "() => window.__states")).not.toContain("LAYOUT");
  expect(await evaluate<string[]>(it, PLATES_JS)).toEqual(before);

  await it.page.locator("#routes-toggle").click();
  await it.page.waitForSelector("#main[data-state='FIELD']");
  expect(await it.page.locator("svg .edge-group").count()).toBe(drawn);
  expect(await evaluate<string[]>(it, PLATES_JS)).toEqual(before);
});

test("the emphasis is reachable without a pointer", async () => {
  // §27.8: every interaction is keyboard-reachable. The selection is the field's one tab stop,
  // and stepping it from the panel moves the lit set with it — the same picture the mouse draws.
  await it.openState("#mode=field&focus=concept:idempotency", "FIELD");
  const first = await incidentPairs(it);
  expect(first.length).toBeGreaterThan(0);
  const button = it.page.locator("#details button", { hasText: "concept:redis" }).first();
  await button.focus();
  await it.page.keyboard.press("Enter");
  await it.page.waitForSelector('svg .node.selected[data-node-id="concept:redis"]');
  const second = await incidentPairs(it);
  expect(second).not.toEqual(first);
  expect(second.some((pair) => pair.includes("concept:redis"))).toBe(true);
  expect(await it.page.locator("svg .node.selected").getAttribute("tabindex")).toBe("0");
  expect(await it.page.locator('svg .node[tabindex="0"]').count()).toBe(1);
});

test("the picture is grabbable anywhere and a drag is not a click", async () => {
  // Nothing in the field moves relative to anything else, so the whole picture is the only thing
  // to take hold of — and every press takes hold of it. Requiring bare background made the
  // gesture fail wherever an edge's invisible 12px hit stroke lay, which on a dense field is most
  // of the canvas.
  const nodes: Dict[] = Array.from({ length: 24 }, (_, index) => {
    const suffix = index.toString().padStart(2, "0");
    return {
      id: `concept:n${suffix}`,
      type: "concept",
      title: `N${suffix}`,
      fields: ["knowledge"],
      aliases: [],
    };
  });
  const edges: Dict[] = Array.from({ length: nodes.length - 1 }, (_, index) => {
    const source = index.toString().padStart(2, "0");
    const target = (index + 1).toString().padStart(2, "0");
    return {
      source: `concept:n${source}`,
      target: `concept:n${target}`,
      type: "related_to",
      provenance: [`concept:n${source}`],
      weight: "unassessed",
    };
  });
  const graph = it.graphEnvelope({ nodes, edges });
  for (const target of ["svg-background", ".edge-hit", ".node-shape"]) {
    it.writeGraph(graph);
    await it.openState("#mode=field", "FIELD");
    let spot: [number, number] | null =
      target === "svg-background" ? [8, 8] : await hitPoint(it, target);
    expect(spot, `grabbed=${target}: no reachable ${target}`).not.toBeNull();
    if (target === "svg-background") {
      const box = (await it.page.locator("svg").boundingBox())!;
      spot = [Math.trunc(box.x + 12), Math.trunc(box.y + 12)];
    }
    if (spot === null) throw new Error(`no reachable ${target}`);
    expect(await dragFrom(it, ...spot), `grabbed=${target}`).toBe(true);
    // The drag moved the picture, so it did not also open a node.
    expect(await it.page.locator("#details").isHidden(), `grabbed=${target}`).toBe(true);
    expect(new URL(it.page.url()).hash.slice(1), `grabbed=${target}`).toBe("mode=field");
  }

  // A press that does not travel is still a press: it selects.
  it.writeGraph(graph);
  await it.openState("#mode=field", "FIELD");
  const spot = await hitPoint(it, ".node-shape");
  if (spot === null) throw new Error("no reachable .node-shape");
  await it.page.mouse.click(...spot);
  await it.page.waitForSelector("#details:not([hidden])");
  expect(new URL(it.page.url()).hash.slice(1)).toContain("focus=");
});

test("a field wider than the frame opens whole and unsqueezed", async () => {
  // A field too big for the frame is fitted by zooming the view out, not by pulling the positions
  // together: the plate keeps its fixed size per kind class (A10), so shrinking the gaps under it
  // was the one way to make plates overlap that no A11 tier could undo. Everything is on screen,
  // and nothing is on top of anything.
  const nodes: Dict[] = Array.from({ length: 140 }, (_, index) => {
    const suffix = index.toString().padStart(3, "0");
    return {
      id: `concept:n${suffix}`,
      type: "concept",
      title: `N${suffix}`,
      fields: ["knowledge"],
      aliases: [],
    };
  });
  const edges: Dict[] = Array.from({ length: nodes.length - 1 }, (_, index) => {
    const source = index.toString().padStart(3, "0");
    const target = (index + 1).toString().padStart(3, "0");
    return {
      source: `concept:n${source}`,
      target: `concept:n${target}`,
      type: "related_to",
      provenance: [`concept:n${source}`],
      weight: "unassessed",
    };
  });
  it.writeGraph(it.graphEnvelope({ nodes, edges }));
  await it.openState("#mode=field", "FIELD");
  const geometry = await evaluate<FieldGeometry>(it, `() => {
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
      scale: Number(viewport.getAttribute("transform").match(/scale\\(([\\d.]+)\\)/)[1]),
      plates: plates.length,
      outside: outside.length,
      overlaps: overlaps.length,
    };
  }`);
  expect(geometry.plates).toBe(140);
  expect(geometry.scale).toBeLessThan(1);
  expect(geometry.outside).toBe(0);
  expect(geometry.overlaps).toBe(0);
});

test("a field at its own scale draws the authored dash", async () => {
  // §16.2 A3 sets the route period at 4 on, 3 off. A field drawn at least at its own size draws
  // exactly that — the screen floor only ever grows a dash, so nothing the frame shows whole is
  // touched by it. Its own size is the whole trip, camera and frame: a frame shorter than the field
  // was authored for is already drawing it smaller.
  await it.page.setViewportSize({ width: 1280, height: 900 });
  it.writeGraph(chainGraph(it));
  await it.openState("#mode=field", "FIELD");
  const measured = await measuredDash(it);
  expect(measured.zoom).toBe(1);
  expect(measured.screen).toBeGreaterThanOrEqual(1);
  expect(measured.scale).toBe(1);
  expect(measured.dash).toEqual([4, 3]);
});

test("a narrow frame holds the dash up on its own", async () => {
  // The camera is not the only thing that draws the field smaller than itself: an embed narrower
  // than the field was authored for shrinks the period with everything else, and a route dash
  // blurred into a continuous stroke has stopped carrying family (A3, §16.4).
  await it.page.setViewportSize({ width: 420, height: 300 });
  it.writeGraph(chainGraph(it));
  await it.openState("#mode=field", "FIELD");
  const measured = await measuredDash(it);
  expect(measured.screen, "expected a narrow frame").toBeLessThan(0.6);
  expect(measured.scale).toBeCloseTo(1 / measured.screen, 3);
  // On screen the period is the authored one, whatever the frame does.
  expect(measured.dash[0]! * measured.screen).toBeGreaterThan(3.5);
});

test("a dash stops shrinking once the picture is drawn smaller", async () => {
  // A dash carries edge family, and its period is in layout units: a field held whole at a
  // fiftieth of its own size asks for fifty times the dashes it can show, on every edge at once.
  // The family mark dissolves into a hairline, and the browser spends a quarter-second a frame
  // drawing what cannot be seen — the picture stops answering the hand dragging it. Drawn smaller
  // than itself the dash holds its own size instead, the same floor of screen presence the plate
  // outline keeps.
  it.writeGraph(wideRouteField(it));
  await it.openState("#mode=field", "FIELD");
  const measured = await measuredDash(it);
  expect(measured.zoom).toBeLessThan(1);
  expect(measured.scale).toBeCloseTo(1 / measured.screen, 3);
  // The authored period, grown by that scale and nothing else.
  expect(measured.dash[0]!).toBeCloseTo(4 * measured.scale, 2);
  expect(measured.dash[1]!).toBeCloseTo(3 * measured.scale, 2);
});

test("focus horizon control needs a focus", async () => {
  // The horizon is a reader control over a focused node, so it stays inert — and says why —
  // until there is one. It is not an address key: §16.4's fragment is unchanged by moving it.
  it.writeGraph(chainGraph(it));
  await it.openState("#mode=field", "FIELD");
  let horizon = it.page.locator("#horizon-select");
  expect(await horizon.isDisabled()).toBe(true);
  expect(await horizon.getAttribute("title")).toBe("Open a node to look around it");

  await it.openState("#mode=field&focus=concept:a", "FIELD");
  horizon = it.page.locator("#horizon-select");
  expect(await horizon.isDisabled()).toBe(false);
  expect(await horizon.getAttribute("title")).toBeNull();
  await horizon.selectOption("1");
  await it.page.waitForFunction(
    "() => document.querySelectorAll('svg .node').length === 3",
  );
  expect(new URL(it.page.url()).hash.slice(1)).toBe("mode=field&focus=concept:a");
});

test("unknown fragment params of any shape are ignored", async () => {
  // §16.4 forward compatibility: unknown keys — underscores, digits, future names — never
  // invalidate the address.
  await it.openState("#mode=field&utm_source=x&foo-bar=1&X9=%20", "FIELD");
  expect(await it.page.locator(".banner").count()).toBe(0);
});

test("dangling edge endpoint rejects the whole file", async () => {
  const graph = it.graphEnvelope({
    nodes: [
      {
        id: "concept:alone",
        type: "concept",
        title: "Alone",
        fields: ["knowledge"],
        aliases: [],
      },
    ],
    edges: [
      {
        source: "concept:alone",
        target: "concept:absent",
        type: "related_to",
        provenance: ["concept:alone"],
        weight: "unassessed",
      },
    ],
  });
  it.writeGraph(graph);
  await it.openState("#mode=field", "REJECTED");
  expect(await it.page.locator("#main").innerText()).toContain(
    "This graph file can't be displayed",
  );
});

test("malformed builder impossible graphs reject whole", async () => {
  const fixtureNames = fs.readdirSync(REJECTED_ACCEPTANCE).sort();
  expect(fixtureNames.length).toBeGreaterThan(0);
  expect(fixtureNames).toEqual(Object.keys(EXPECTED_REJECTED_FIXTURES).sort());
  for (const name of fixtureNames) {
    const fixturePath = `${REJECTED_ACCEPTANCE}/${name}`;
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Dict;
    it.copyGraph(fixturePath);
    await it.openState("#mode=field", "REJECTED");
    const diagnostic = await it.page.evaluate<Diagnostic | null>(`(async graph => {
      const {validateGraph} = await import("./contract.js");
      return validateGraph(graph);
    })(${JSON.stringify(fixture)})`);
    expect(diagnostic, `fixture=${name}`).toEqual(EXPECTED_REJECTED_FIXTURES[name]!);
  }
});

test("state semantic gates reject builder impossible graphs", async () => {
  const concept: Dict = {
    id: "concept:alone",
    type: "concept",
    title: "Alone (Vera Example)",
    fields: ["knowledge"],
    aliases: [],
  };
  const artifact: Dict = {
    id: "artifact:notice",
    type: "artifact",
    title: "",
    fields: [],
    kind: "note",
    path: "notes/example.md",
    observed_at: "2026-07-16",
    summary: "Synthetic viewer fixture (Vera Example).",
    evidence_strength: "noticed",
  };
  const question: Dict = {
    id: "question:alone",
    type: "question",
    title: "",
    fields: ["knowledge"],
    text: "Is this resolved? (Vera Example)",
    created_at: "2026-07-16",
    source: { artifact: "artifact:missing" },
  };
  const reference: Dict = {
    dimension: "confidence",
    date: "2026-07-16",
    evidence: ["artifact:first"],
  };
  const cases: Record<string, Dict> = {};

  let graph = it.graphEnvelope({ nodes: [concept] });
  stateFor(graph, concept["id"] as string)["confidence"] = "high";
  cases["concept-missing-decision"] = graph;

  graph = it.graphEnvelope({ nodes: [question] });
  stateFor(graph, question["id"] as string)["status"] = "resolved";
  cases["question-missing-decision"] = graph;

  graph = it.graphEnvelope({ nodes: [concept] });
  stateFor(graph, concept["id"] as string)["confidence"] = "high";
  stateFor(graph, concept["id"] as string)["decisions"] = [
    reference,
    { ...reference, date: "2026-07-17", evidence: ["artifact:second"] },
  ];
  cases["duplicate-decision-dimension"] = graph;

  graph = it.graphEnvelope({ nodes: [concept, artifact] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  Object.assign(stateFor(graph, concept["id"] as string), {
    confidence: "high",
    evidence: [],
    decisions: [
      {
        dimension: "confidence",
        date: "2026-07-16",
        evidence: [artifact["id"]],
      },
    ],
  });
  cases["concept-omits-decision-evidence"] = graph;

  graph = it.graphEnvelope({ nodes: [concept, artifact] });
  Object.assign(stateFor(graph, concept["id"] as string), {
    exposure: "touched",
    evidence: [artifact["id"]],
  });
  cases["contact-without-dates"] = graph;

  graph = it.graphEnvelope({ nodes: [concept] });
  Object.assign(stateFor(graph, concept["id"] as string), {
    last_seen: "2026-07-16",
    freshness: "fresh",
  });
  cases["unseen-with-dates"] = graph;

  graph = it.graphEnvelope({ nodes: [concept, artifact] });
  Object.assign(stateFor(graph, concept["id"] as string), {
    exposure: "touched",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: [artifact["id"]],
  });
  cases["dated-state-without-as-of"] = graph;

  graph = it.graphEnvelope({ nodes: [concept, artifact] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  Object.assign(stateFor(graph, concept["id"] as string), {
    exposure: "touched",
    last_seen: "2099-01-01",
    freshness: "fresh",
    evidence: [artifact["id"]],
  });
  cases["last-seen-after-as-of"] = graph;

  graph = it.graphEnvelope({ nodes: [concept] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  stateFor(graph, concept["id"] as string)["confidence"] = "high";
  stateFor(graph, concept["id"] as string)["decisions"] = [
    { ...reference, date: "2099-01-01" },
  ];
  cases["decision-after-as-of"] = graph;

  graph = it.graphEnvelope({ nodes: [question] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  Object.assign(stateFor(graph, question["id"] as string), {
    status: "resolved",
    evidence: [question["id"]],
    decisions: [
      {
        dimension: "status",
        date: "2026-07-16",
        evidence: [question["id"]],
      },
    ],
  });
  cases["status-cites-question-creation"] = graph;

  graph = it.graphEnvelope({ nodes: [question] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  Object.assign(stateFor(graph, question["id"] as string), {
    status: "resolved",
    evidence: [],
    decisions: [
      {
        dimension: "status",
        date: "2026-07-16",
        evidence: [artifact["id"]],
      },
    ],
  });
  cases["status-evidence-diverges-from-decision"] = graph;

  graph = JSON.parse(fs.readFileSync(DEMO_GRAPH, "utf8")) as Dict;
  stateFor(graph, "question:demo-when-is-retry-safe")["status"] = "stale";
  stateFor(graph, "question:demo-when-is-retry-safe")["evidence"] = [
    "artifact:demo-retry-script",
  ];
  stateFor(graph, "question:demo-when-is-retry-safe")["decisions"] = [
    {
      dimension: "status",
      date: "2026-07-10",
      evidence: ["artifact:demo-retry-script"],
    },
  ];
  cases["stale-cites-resolved-script"] = graph;

  graph = it.graphEnvelope({ nodes: [concept, artifact] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  Object.assign(stateFor(graph, concept["id"] as string), {
    exposure: "taught",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: [artifact["id"]],
  });
  cases["taught-cites-noticed-artifact"] = graph;

  graph = it.graphEnvelope({ nodes: [concept, question] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  Object.assign(stateFor(graph, concept["id"] as string), {
    exposure: "taught",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: [question["id"]],
  });
  cases["taught-cites-question"] = graph;

  graph = it.graphEnvelope({ nodes: [concept, artifact] });
  graph["generated_at"] = "2026-07-27T00:00:00Z";
  Object.assign(stateFor(graph, concept["id"] as string), {
    exposure: "touched",
    last_seen: "2026-01-01",
    freshness: "fresh",
    evidence: [artifact["id"]],
  });
  cases["freshness-not-derived"] = graph;

  const earlierArtifact: Dict = {
    ...artifact,
    id: "artifact:earlier-contact",
    observed_at: "2026-07-10",
  };
  graph = it.graphEnvelope({ nodes: [concept, earlierArtifact] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  Object.assign(stateFor(graph, concept["id"] as string), {
    exposure: "touched",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: [earlierArtifact["id"]],
  });
  cases["concept-last-seen-is-not-cited-date"] = graph;

  const classedArtifact: Dict = {
    ...artifact,
    id: "artifact:classed",
    sensitivity: "medical",
  };
  graph = it.graphEnvelope({ nodes: [concept, classedArtifact] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  Object.assign(stateFor(graph, concept["id"] as string), {
    exposure: "touched",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: [classedArtifact["id"]],
  });
  cases["state-omits-evidence-sensitivity"] = graph;

  graph = it.graphEnvelope({ nodes: [{ ...concept, sensitivity: "medical" }] });
  delete stateFor(graph, concept["id"] as string)["sensitivity"];
  cases["state-omits-target-sensitivity"] = graph;

  const material: Dict = {
    id: "material:example",
    type: "material",
    title: "Example material (Vera Example)",
    fields: [],
    kind: "docs",
    url: "",
    status: "active",
  };
  const encounter: Dict = {
    id: "encounter:example",
    type: "encounter",
    title: "",
    fields: [],
    date: "2026-07-16",
    target: material["id"],
    depth: "applied",
    mode: "background",
  };
  graph = it.graphEnvelope({ nodes: [material, encounter] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  (graph["state"] as Dict)[material["id"] as string] = {
    depth_reached: "taught",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: [encounter["id"]],
  };
  cases["depth-exceeds-encounter"] = graph;

  graph = it.graphEnvelope({ nodes: [material, encounter] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  (graph["state"] as Dict)[material["id"] as string] = {
    depth_reached: "applied",
    last_seen: "2026-07-15",
    freshness: "fresh",
    evidence: [encounter["id"]],
  };
  cases["material-last-seen-predates-cited-encounter"] = graph;

  graph = it.graphEnvelope({ nodes: [material] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  (graph["state"] as Dict)[material["id"] as string] = {
    depth_reached: "skim",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: ["encounter:missing"],
  };
  cases["material-cites-no-emitted-encounter"] = graph;

  graph = it.graphEnvelope({ nodes: [material, encounter] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  (graph["state"] as Dict)[material["id"] as string] = {
    depth_reached: "applied",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: [encounter["id"], "encounter:missing"],
  };
  cases["material-cites-partially-dangling-encounters"] = graph;

  // #105: the material contact pair is emitted, so the viewer holds it to the same §14.7
  // derivation as the concept pair — an absent class is not a licensed omission, and a supplied
  // one is not proof.
  graph = it.graphEnvelope({ nodes: [material, encounter] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  (graph["state"] as Dict)[material["id"] as string] = {
    depth_reached: "applied",
    last_seen: "2026-07-16",
    evidence: [encounter["id"]],
  };
  cases["material-freshness-missing"] = graph;

  const staleEncounter: Dict = {
    ...encounter,
    id: "encounter:stale-example",
    date: "2026-01-01",
  };
  graph = it.graphEnvelope({ nodes: [material, staleEncounter] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  (graph["state"] as Dict)[material["id"] as string] = {
    depth_reached: "applied",
    last_seen: "2026-01-01",
    freshness: "fresh",
    evidence: [staleEncounter["id"]],
  };
  cases["material-freshness-not-derived"] = graph;

  const explained: Dict = {
    ...artifact,
    id: "artifact:explained",
    observed_at: "2026-07-16",
    evidence_strength: "explained",
  };
  const reviewedBefore: Dict = {
    ...artifact,
    id: "artifact:reviewed",
    observed_at: "2026-07-15",
    evidence_strength: "reviewed",
  };
  graph = it.graphEnvelope({ nodes: [concept, explained, reviewedBefore] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  Object.assign(stateFor(graph, concept["id"] as string), {
    exposure: "taught",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: [explained["id"], reviewedBefore["id"]],
  });
  cases["taught-review-predates-explanation"] = graph;

  for (const [name, impossible] of Object.entries(cases)) {
    it.writeGraph(impossible);
    try {
      await it.openState("#mode=field", "REJECTED");
    } catch (error) {
      throw new Error(`case=${name}`, { cause: error });
    }
  }

  // §20.1 keeps a decision applicable when its cited artifact lies outside the cut or was deleted,
  // so unresolved stale evidence stays acceptable until its non-note kind is actually knowable.
  graph = JSON.parse(fs.readFileSync(DEMO_GRAPH, "utf8")) as Dict;
  (graph["state"] as Dict)["question:demo-when-is-retry-safe"] = {
    status: "stale",
    evidence: ["artifact:missing-note"],
    decisions: [
      {
        dimension: "status",
        date: "2026-07-10",
        evidence: ["artifact:missing-note"],
      },
    ],
  };
  it.writeGraph(graph);
  await it.openState("#mode=field", "FIELD");

  // The observable §32.6 union is accepted when the class is preserved; the same graph also proves
  // that concept decision evidence may add provenance without being treated as direct contact.
  graph = it.graphEnvelope({ nodes: [concept, classedArtifact] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  Object.assign(stateFor(graph, concept["id"] as string), {
    confidence: "high",
    evidence: [classedArtifact["id"]],
    decisions: [
      {
        dimension: "confidence",
        date: "2026-07-16",
        evidence: [classedArtifact["id"]],
      },
    ],
    sensitivity: "medical",
  });
  it.writeGraph(graph);
  await it.openState("#mode=field", "FIELD");

  // Cross-day order is knowable from emitted nodes, but same-day journal position is not; keep the
  // latter as an upper-bound case.
  const reviewedSameDay: Dict = { ...reviewedBefore, observed_at: "2026-07-16" };
  graph = it.graphEnvelope({ nodes: [concept, explained, reviewedSameDay] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  Object.assign(stateFor(graph, concept["id"] as string), {
    exposure: "taught",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: [explained["id"], reviewedSameDay["id"]],
  });
  it.writeGraph(graph);
  await it.openState("#mode=field", "FIELD");

  // The viewer copies the Python boundary's upper bounds, not a partial re-fold: a strong emitted
  // record may justify the rung without re-deriving its target/link relation from omitted journal
  // context.
  const appliedArtifact: Dict = {
    ...artifact,
    id: "artifact:applied",
    evidence_strength: "applied",
  };
  graph = it.graphEnvelope({ nodes: [concept, appliedArtifact, material, encounter] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  Object.assign(stateFor(graph, concept["id"] as string), {
    exposure: "applied",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: [appliedArtifact["id"]],
  });
  (graph["state"] as Dict)[material["id"] as string] = {
    depth_reached: "applied",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: [encounter["id"]],
  };
  it.writeGraph(graph);
  await it.openState("#mode=field", "FIELD");
});

test("dated nodes require and obey graph as of", async () => {
  const demo = JSON.parse(fs.readFileSync(DEMO_GRAPH, "utf8")) as Dict;
  const datedFields = {
    artifact: "observed_at",
    encounter: "date",
    question: "created_at",
    trail_segment: "date",
  };
  for (const [nodeType, field] of Object.entries(datedFields)) {
    const source = (demo["nodes"] as Dict[]).find((node) => node["type"] === nodeType)!;
    for (const [caseName, generatedAt] of [
      ["missing-as-of", null],
      ["after-as-of", "2026-07-08T00:00:00Z"],
    ] as const) {
      const node = JSON.parse(JSON.stringify(source)) as Dict;
      const graph = it.graphEnvelope({ nodes: [node] });
      if (generatedAt !== null) graph["generated_at"] = generatedAt;
      try {
        it.writeGraph(graph);
        await it.openState("#mode=field", "REJECTED");
      } catch (error) {
        throw new Error(`node_type=${nodeType}, field=${field}, case=${caseName}`, {
          cause: error,
        });
      }
    }
  }
});

test("bom crlf and withheld reject whole", async () => {
  const clean = JSON.stringify(it.graphEnvelope());
  it.writeGraphBytes(`\uFEFF${clean}`);
  await it.openState("#mode=field", "REJECTED");

  it.writeGraphBytes(clean.replace("{", "{\r\n"));
  await it.openState("#mode=field", "REJECTED");

  // §20: the full graph never carries withheld — a withheld-bearing file at the viewer's single
  // input path is a partial graph.
  const redacted = it.graphEnvelope();
  redacted["withheld"] = {
    nodes: 1,
    edges: 0,
    trails: 0,
    state: 0,
    influence: 0,
    frontier: 0,
    projections: 0,
  };
  it.writeGraph(redacted);
  await it.openState("#mode=field", "REJECTED");
});

test("duplicate json keys reject whole", async () => {
  const text =
    '{"format": "atlas-graph", "version": 1, "nodes": [], "nodes": [],' +
    ' "edges": [], "trails": [], "state": {}, "influence": {},' +
    ' "frontier": [], "projections": {}}';
  it.writeGraphBytes(text);
  await it.openState("#mode=field", "REJECTED");
});

test("list auto engages past node link ceiling", async () => {
  const nodes: Dict[] = Array.from({ length: 2401 }, (_, index) => ({
    id: `concept:n-${index}`,
    type: "concept",
    title: `Node ${index}`,
    fields: ["knowledge"],
    aliases: [],
  }));
  it.writeGraph(it.graphEnvelope({ nodes }));
  await it.openState("#mode=field", "LIST");
  expect(await it.page.locator('.list-ceiling-note[role="status"]').innerText()).toBe(
    "2401 nodes is past the node-link ceiling (2,400) — showing the list.",
  );
  // Sections preview; the tail renders only on explicit request.
  expect(await it.page.locator(".node-list-row").count()).toBe(500);
  const showAll = it.page.locator(".list-show-all");
  expect(await showAll.innerText()).toBe("Show all 2401 concept rows");
  await showAll.click();
  await it.page.waitForFunction(
    "document.querySelectorAll('.node-list-row').length === 2401",
  );
  expect(await it.page.locator(".list-show-all").count()).toBe(0);
  const graphButton = it.page.locator("#graph-view");
  expect(await graphButton.isDisabled()).toBe(true);
  expect(await graphButton.getAttribute("title")).toBe(
    "Node-link layout caps at 2,400 nodes",
  );
  expect(await graphButton.getAttribute("aria-pressed")).toBe("false");
  expect(await it.page.locator("#list-view").getAttribute("aria-pressed")).toBe("true");
  await it.page.locator(".node-list-row").first().click();
  await it.page.waitForSelector("#details:not([hidden])");
  expect(await it.page.locator(".node-list-row.selected").count()).toBe(1);
});
