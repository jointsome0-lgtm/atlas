import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";

import { FRESHNESS_DAYS, freshnessOf } from "../src/domain.ts";
import {
  DEMO_GRAPH,
  UNSUPPORTED_VERSION_FIXTURE,
  lab,
  type Fixture,
} from "./harness.ts";
import {
  artifactNode,
  boundaryDashes,
  conceptNode,
  freshnessGraph,
  nodeClass,
} from "./helpers.ts";

type Dict = Record<string, unknown>;

interface Graph extends Dict {
  nodes: Dict[];
  edges: Dict[];
  state: Record<string, Dict>;
}

function asGraph(value: Dict): Graph {
  return value as Graph;
}

function nodeId(node: Dict): string {
  return node["id"] as string;
}

function readDemoGraph(): Graph {
  return JSON.parse(fs.readFileSync(DEMO_GRAPH, "utf8")) as Graph;
}

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

function rounded(value: number, places: number): number {
  return Number(value.toFixed(places));
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

test("plate texture follows each contact ladder", async () => {
  // §16.2 A1: interior texture is the monotone contact ladder — the concept exposure rungs
  // and the material depth rungs each keyed to the node's own state key, never a child's
  // (A12).
  await it.openState("#mode=field", "FIELD");
  expect(await nodeClass(it, "concept:redis")).toContain("tx-plain");
  expect(await nodeClass(it, "concept:http-methods")).toContain("tx-hatch");
  expect(await nodeClass(it, "concept:idempotency")).toContain("tx-solid");
  expect(await nodeClass(it, "part:mdn-http-methods/idempotency")).toContain("tx-solid");
  // The parent material has no entry of its own: no contact, however much its part carries
  // (A12).
  expect(await nodeClass(it, "material:mdn-http-methods")).toContain("tx-plain");

  const touched = conceptNode(it, "touched-example");
  const summarized = conceptNode(it, "summarized-example");
  const taught = conceptNode(it, "taught-example");
  const noticed = artifactNode(it, "noticed", "noticed", "2026-07-16");
  const summed = artifactNode(it, "summarized", "summarized", "2026-07-16");
  const explained = artifactNode(it, "explained", "explained", "2026-07-15");
  const reviewed = artifactNode(it, "reviewed", "reviewed", "2026-07-16");
  const material: Dict = {
    id: "material:skimmed",
    type: "material",
    title: "Skimmed material (Vera Example)",
    fields: [],
    kind: "docs",
    url: "",
    status: "active",
  };
  const encounter: Dict = {
    id: "encounter:skim",
    type: "encounter",
    title: "",
    fields: [],
    date: "2026-07-16",
    target: nodeId(material),
    depth: "skim",
    mode: "background",
  };
  const graph = asGraph(
    it.graphEnvelope({
      nodes: [
        touched,
        summarized,
        taught,
        noticed,
        summed,
        explained,
        reviewed,
        material,
        encounter,
      ],
    }),
  );
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  Object.assign(graph.state[nodeId(touched)]!, {
    exposure: "touched",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: [nodeId(noticed)],
  });
  Object.assign(graph.state[nodeId(summarized)]!, {
    exposure: "summarized",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: [nodeId(summed)],
  });
  Object.assign(graph.state[nodeId(taught)]!, {
    exposure: "taught",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: [nodeId(explained), nodeId(reviewed)],
  });
  graph.state[nodeId(material)] = {
    depth_reached: "skim",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: [nodeId(encounter)],
  };
  it.writeGraph(graph);
  await it.openState("#mode=field", "FIELD");
  expect(await nodeClass(it, nodeId(touched))).toContain("tx-dot");
  expect(await nodeClass(it, nodeId(summarized))).toContain("tx-cross");
  expect(await nodeClass(it, nodeId(taught))).toContain("tx-keyline");
  expect(await nodeClass(it, nodeId(material))).toContain("tx-dot");
  const touchedNode = it.page.locator(`g.node[data-node-id="${nodeId(touched)}"]`);
  expect(await touchedNode.locator(".plate-dot").count()).toBe(1);
  const taughtNode = it.page.locator(`g.node[data-node-id="${nodeId(taught)}"]`);
  expect(await taughtNode.locator(".plate-keyline").count()).toBe(1);

  interface TextureGeometry {
    dotRadius: number;
    keylineInset: number;
    hatchPitch: number;
    hatchWeight: number;
  }
  const textureGeometry = async (): Promise<TextureGeometry> =>
    await evaluateWithArgument<TextureGeometry>(
      it,
      `({touchedId, taughtId}) => {
        const touched = document.querySelector(
          \`g.node[data-node-id="\${touchedId}"]\`);
        const taught = document.querySelector(
          \`g.node[data-node-id="\${taughtId}"]\`);
        const taughtShape = taught.querySelector(".node-shape");
        const keyline = taught.querySelector(".plate-keyline");
        const pattern = document.querySelector("#tx-hatch-concept");
        return {
          dotRadius: parseFloat(touched.querySelector(".plate-dot").getAttribute("r")),
          keylineInset: parseFloat(taughtShape.getAttribute("r"))
            - parseFloat(keyline.getAttribute("r")),
          hatchPitch: parseFloat(pattern.getAttribute("width")),
          hatchWeight: parseFloat(pattern.querySelector("line").getAttribute("stroke-width")),
        };
      }`,
      { touchedId: nodeId(touched), taughtId: nodeId(taught) },
    );

  const native = await textureGeometry();
  await evaluate<void>(
    it,
    `() => {
      const sheet = [...document.styleSheets].find(
        item => item.href?.endsWith("/viewer/viewer.css"));
      sheet.insertRule(":root { --plate-r: 9px; }", sheet.cssRules.length);
    }`,
  );
  await it.page.locator("#list-view").click();
  await it.page.waitForSelector('#main[data-state="LIST"]');
  await it.page.locator("#graph-view").click();
  await it.page.waitForSelector('#main[data-state="FIELD"]');
  const scaled = await textureGeometry();
  for (const key of Object.keys(native) as (keyof TextureGeometry)[]) {
    expect(scaled[key], `texture_dimension=${key}`).toBeCloseTo(native[key] / 2, 2);
  }
});

test("boundary continuity is freshness and stale recedes", async () => {
  // §16.2 A4: the three §14.7 classes are three discrete boundary continuities — no badge,
  // count, or ring — and A6: stale only mutes.
  const { graph, contacts } = freshnessGraph(it);
  it.writeGraph(graph);
  await it.openState("#mode=field", "FIELD");
  for (const [conceptId, [, freshness]] of Object.entries(contacts)) {
    expect(await nodeClass(it, conceptId)).toContain(`fresh-${freshness}`);
  }
  const { dashes, labels } = await boundaryDashes(it, contacts);
  expect(new Set(Object.values(dashes)).size).toBe(3);
  expect(dashes["fresh"]).toBe("none");
  // A6: the stale label recedes; nothing else changes register.
  expect(labels["stale"]).not.toBe(labels["fresh"]);
  expect(labels["aging"]).toBe(labels["fresh"]);
});

test("material boundary reads the emitted freshness class", async () => {
  // §14.7 (#105): a material plate's boundary and its panel words come from the class the §20
  // fold emitted. The render alone cannot prove that — the acceptance boundary rejects any
  // emitted class the §14.7 derivation would not produce, so a viewer that re-derived would
  // draw the same picture. What separates the two is the entry with no class: deriving one
  // needs only last_seen, reading one needs the field. So the same graph is asserted twice,
  // drawn and then stripped.
  const material: Dict = {
    id: "material:stale-example",
    type: "material",
    title: "Stale material (Vera Example)",
    fields: [],
    kind: "docs",
    url: "",
    status: "active",
  };
  const encounter: Dict = {
    id: "encounter:stale-contact",
    type: "encounter",
    title: "",
    fields: [],
    date: "2026-04-01",
    target: nodeId(material),
    depth: "read",
    mode: "background",
  };
  const graph = asGraph(it.graphEnvelope({ nodes: [material, encounter] }));
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  graph.state[nodeId(material)] = {
    depth_reached: "read",
    last_seen: "2026-04-01",
    freshness: "stale",
    evidence: [nodeId(encounter)],
  };
  it.writeGraph(graph);
  await it.openState("#mode=field", "FIELD");
  expect(await nodeClass(it, nodeId(material))).toContain("fresh-stale");
  await it.page.locator("#list-view").click();
  await it.page.waitForSelector('#main[data-state="LIST"]');
  const row = it.page.locator(`.node-list-row[data-node-id="${nodeId(material)}"]`);
  expect(await row.innerText()).toContain("freshness: stale — last seen 2026-04-01");

  // Same contact, class removed: last_seen alone would have been enough for the old derivation,
  // and is now a rejection.
  delete graph.state[nodeId(material)]!["freshness"];
  it.writeGraph(graph);
  await it.openState("#mode=field", "REJECTED");
  const diagnostic = await evaluateWithArgument<Dict | null>(
    it,
    `async graph => {
      const {validateGraph} = await import("./contract.js");
      return validateGraph(graph);
    }`,
    graph,
  );
  expect(diagnostic).toEqual({ path: "/state", rule: "required" });
});

test("freshness classes match the fold on every boundary day", async () => {
  // §14.7/#108: the parity test pins the numbers both implementations carry, but not the
  // comparison that uses them — flipping either `<=` to `<` in freshnessOf leaves
  // FRESHNESS_DAYS untouched and misclassifies exactly one day, which no other viewer case
  // visits. So every age across both boundaries is labelled by the §20 fold and offered to the
  // acceptance check: the two transcriptions have to agree on all of them, not merely carry the
  // same integers.
  const asOf = "2026-07-16";
  const span = FRESHNESS_DAYS.get("aging")! + 2;
  const graphs: Graph[] = [];
  for (let age = 0; age < span + 1; age += 1) {
    const date = new Date(Date.UTC(2026, 6, 16 - age));
    const lastSeen = date.toISOString().slice(0, 10);
    const concept: Dict = {
      id: `concept:day-${age}`,
      type: "concept",
      title: `Day ${age} (Vera Example)`,
      fields: ["knowledge"],
      aliases: [],
    };
    const artifact: Dict = {
      id: `artifact:day-${age}`,
      type: "artifact",
      title: "",
      fields: [],
      kind: "note",
      path: "notes/example.md",
      observed_at: lastSeen,
      summary: "Synthetic viewer fixture (Vera Example).",
      evidence_strength: "noticed",
    };
    const graph = asGraph(it.graphEnvelope({ nodes: [concept, artifact] }));
    graph["generated_at"] = "2026-07-16T00:00:00Z";
    Object.assign(graph.state[nodeId(concept)]!, {
      exposure: "touched",
      last_seen: lastSeen,
      freshness: freshnessOf(lastSeen, asOf),
      evidence: [nodeId(artifact)],
    });
    graphs.push(graph);
  }

  // One real load puts the acceptance module on the viewer's own origin; the batch below then
  // runs the shipped contract, not a copy of it.
  it.writeGraph(graphs[0]!);
  await it.openState("#mode=field", "FIELD");
  const diagnostics = await evaluateWithArgument<(Dict | null)[]>(
    it,
    `async graphs => {
      const {validateGraph} = await import("./contract.js");
      return graphs.map(graph => validateGraph(graph));
    }`,
    graphs,
  );
  expect(diagnostics).toEqual(Array.from({ length: span + 1 }, () => null));

  // The other direction: accepting everything would also pass the loop above, so each boundary
  // day is offered its neighbour's class too.
  const boundaries: readonly (readonly [number, string])[] = [
    [FRESHNESS_DAYS.get("fresh")!, "aging"],
    [FRESHNESS_DAYS.get("aging")!, "stale"],
  ];
  for (const [boundary, wrong] of boundaries) {
    const graph = JSON.parse(JSON.stringify(graphs[boundary])) as Graph;
    const entry = graph.state[`concept:day-${boundary}`]!;
    expect(entry["freshness"]).not.toBe(wrong);
    entry["freshness"] = wrong;
    const diagnostic = await evaluateWithArgument<Dict | null>(
      it,
      `async graph => {
        const {validateGraph} = await import("./contract.js");
        return validateGraph(graph);
      }`,
      graph,
    );
    expect(diagnostic).toEqual({ path: "/state/freshness", rule: "derivedFreshness" });
  }
});

test("rail carries gated dimensions only", async () => {
  // §16.2 A2: a drawn open slot for silence, a struck mark whose extent carries the decided
  // level, the fork for disputed — and no rail at all on kinds that admit no gated dimension.
  const concept = conceptNode(it, "decided-example");
  const artifact = artifactNode(it, "decision-basis", "read", "2026-07-16");
  const graph = asGraph(it.graphEnvelope({ nodes: [concept, artifact] }));
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  Object.assign(graph.state[nodeId(concept)]!, {
    exposure: "read",
    last_seen: "2026-07-16",
    freshness: "fresh",
    confidence: "high",
    clarity: "disputed",
    evidence: [nodeId(artifact)],
    decisions: [
      { dimension: "confidence", date: "2026-07-16", evidence: [nodeId(artifact)] },
      { dimension: "clarity", date: "2026-07-16", evidence: [nodeId(artifact)] },
    ],
  });
  it.writeGraph(graph);
  await it.openState("#mode=field", "FIELD");
  const node = it.page.locator(`g.node[data-node-id="${nodeId(concept)}"]`);
  expect(await node.locator(".rail").count()).toBe(1);
  expect(
    await evaluateWithArgument<string[]>(
      it,
      `id => [...document.querySelectorAll(
        \`g.node[data-node-id="\${id}"] .rail-slot\`)]
        .map(slot => slot.dataset.dimension)`,
      nodeId(concept),
    ),
  ).toEqual(["confidence", "clarity", "coverage"]);
  interface DrawnRail {
    confidence: number[];
    clarity: number;
    coverage: number;
    tokens: { high: number };
  }
  const drawn = await evaluateWithArgument<DrawnRail>(
    it,
    `id => {
      const token = name => parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(name));
      const rail = document.querySelector(\`g.node[data-node-id="\${id}"] .rail\`);
      const slots = [...rail.querySelectorAll(".rail-slot")];
      const marks = [...rail.querySelectorAll(".rail-mark")];
      const within = slot => marks.filter(mark => {
        const y = parseFloat(mark.getAttribute("y"));
        const top = parseFloat(slot.getAttribute("y"));
        return y >= top - 0.01
          && y <= top + parseFloat(slot.getAttribute("height")) + 0.01;
      });
      return {
        confidence: within(slots[0]).map(mark => parseFloat(mark.getAttribute("height"))),
        clarity: within(slots[1]).length,
        coverage: within(slots[2]).length,
        tokens: { high: token("--rail-mark-3") * token("--plate-r") / 7 },
      };
    }`,
    nodeId(concept),
  );
  // confidence high: one struck mark at the top extent.
  expect(drawn.confidence.map((height) => rounded(height, 2))).toEqual([
    rounded(drawn.tokens.high, 2),
  ]);
  // clarity disputed: the fork — a base and two tines, not a rung.
  expect(drawn.clarity).toBe(3);
  // coverage undecided: the slot stays drawn and unstruck.
  expect(drawn.coverage).toBe(0);
  // A kind that admits no gated dimension draws no rail.
  expect(
    await it.page.locator(`g.node[data-node-id="${nodeId(artifact)}"] .rail`).count(),
  ).toBe(0);
  await it.openState(`#mode=field&focus=${encodeURIComponent(nodeId(concept))}`, "FIELD");
  await it.page.waitForSelector("#details:not([hidden])");
  const panel = await it.page.locator("#details").innerText();
  expect(panel).toContain("high");
  expect(panel).toContain("disputed");
  expect(panel).toContain("no decision");
});

test("question status rail is one nonordinal slot", async () => {
  // §16.2 A1/A2: question status is review-gated, so silence is one unstruck slot and every
  // confirmed status gets the same strike. The status value remains in words; mark extent must
  // not rank it.
  const questionId = "question:demo-when-is-retry-safe";
  const decidedHeights: number[] = [];
  for (const status of [null, "open", "clarified", "resolved", "stale"] as const) {
    const graph = readDemoGraph();
    if (status !== null) {
      graph.state[questionId] = {
        status,
        evidence: ["artifact:missing-note"],
        decisions: [
          {
            dimension: "status",
            date: "2026-07-10",
            evidence: ["artifact:missing-note"],
          },
        ],
      };
    }
    const label = `status=${status ?? "undecided"}`;
    it.writeGraph(graph);
    await it.openState("#mode=field", "FIELD");
    const node = it.page.locator(`g.node[data-node-id="${questionId}"]`);
    const slots = node.locator(".rail-slot");
    const marks = node.locator(".rail-mark");
    expect(await node.locator(".rail").count(), label).toBe(1);
    expect(await slots.count(), label).toBe(1);
    expect(await slots.first().getAttribute("data-dimension"), label).toBe("status");
    if (status === null) {
      expect(await marks.count(), label).toBe(0);
    } else {
      expect(await marks.count(), label).toBe(1);
      const height = await marks.first().getAttribute("height");
      if (height === null) throw new TypeError("rail mark has no height");
      decidedHeights.push(Number(height));
    }
    expect(
      await evaluateWithArgument<string>(
        it,
        `id => getComputedStyle(document.querySelector(
          \`g.node[data-node-id="\${id}"] .question-ring\`)).animationName`,
        questionId,
      ),
      label,
    ).toBe("none");
  }
  expect(new Set(decidedHeights.map((height) => rounded(height, 2))).size).toBe(1);
});

test("rail anchor clears auxiliary kind marks", async () => {
  // The rail begins after the complete drawn glyph, not the primary plate: question pull rings
  // and node-payload sensitivity dots remain unobscured when their kinds also admit review-gated
  // state.
  const questionId = "question:demo-when-is-retry-safe";
  await it.openState("#mode=field", "FIELD");
  const questionGeometry = await evaluateWithArgument<{
    ringRight: number;
    railLeft: number;
  }>(
    it,
    `id => {
      const group = document.querySelector(\`g.node[data-node-id="\${id}"]\`);
      return {
        ringRight: parseFloat(group.querySelector(".question-ring").getAttribute("r")),
        railLeft: parseFloat(group.querySelector(".rail-slot").getAttribute("x")),
      };
    }`,
    questionId,
  );
  expect(questionGeometry.railLeft).toBeGreaterThan(questionGeometry.ringRight);

  const concept = conceptNode(it, "classed-rail");
  concept["sensitivity"] = "medical";
  const graph = asGraph(it.graphEnvelope({ nodes: [concept] }));
  graph.state[nodeId(concept)]!["sensitivity"] = "medical";
  it.writeGraph(graph);
  await it.openState("#mode=field", "FIELD");
  const markedGeometry = await evaluateWithArgument<{ dotRight: number; railLeft: number }>(
    it,
    `id => {
      const group = document.querySelector(\`g.node[data-node-id="\${id}"]\`);
      const dot = group.querySelector(".sensitivity-dot");
      return {
        dotRight: parseFloat(dot.getAttribute("cx")) + parseFloat(dot.getAttribute("r")),
        railLeft: parseFloat(group.querySelector(".rail-slot").getAttribute("x")),
      };
    }`,
    nodeId(concept),
  );
  expect(markedGeometry.railLeft).toBeGreaterThan(markedGeometry.dotRight);
});

test("rail geometry scales with plate token", async () => {
  // --plate-r is the one glyph scale control. Re-rendering at half the radius must halve the
  // slot, strike, pitch, and gap with the plate.
  const graph = readDemoGraph();
  Object.assign(graph.state["concept:idempotency"]!, {
    confidence: "high",
    decisions: [
      {
        dimension: "confidence",
        date: "2026-07-10",
        evidence: ["artifact:demo-retry-script"],
      },
    ],
  });
  it.writeGraph(graph);
  await it.openState("#mode=field", "FIELD");

  interface RailGeometry {
    radius: number;
    gap: number;
    width: number;
    height: number;
    pitch: number;
    mark: number;
  }
  const geometry = async (): Promise<RailGeometry> =>
    await evaluate<RailGeometry>(
      it,
      `() => {
        const group = document.querySelector(
          'g.node[data-node-id="concept:idempotency"]');
        const shape = group.querySelector(".node-shape");
        const slots = group.querySelectorAll(".rail-slot");
        const first = slots[0];
        return {
          radius: parseFloat(shape.getAttribute("r")),
          gap: parseFloat(first.getAttribute("x")) - parseFloat(shape.getAttribute("r")),
          width: parseFloat(first.getAttribute("width")),
          height: parseFloat(first.getAttribute("height")),
          pitch: parseFloat(slots[1].getAttribute("y")) - parseFloat(first.getAttribute("y")),
          mark: parseFloat(group.querySelector(".rail-mark").getAttribute("height")),
        };
      }`,
    );

  const native = await geometry();
  await evaluate<void>(
    it,
    `() => {
      const sheet = [...document.styleSheets].find(
        item => item.href?.endsWith("/viewer/viewer.css"));
      sheet.insertRule(":root { --plate-r: 9px; }", sheet.cssRules.length);
    }`,
  );
  await it.page.locator("#list-view").click();
  await it.page.waitForSelector('#main[data-state="LIST"]');
  await it.page.locator("#graph-view").click();
  await it.page.waitForSelector('#main[data-state="FIELD"]');
  const scaled = await geometry();
  for (const key of Object.keys(native) as (keyof RailGeometry)[]) {
    expect(scaled[key], `dimension=${key}`).toBeCloseTo(native[key] / 2, 2);
  }
});

test("state words share one vocabulary across surfaces", async () => {
  // §16.2 A8: field marks, panel words, and list columns speak one vocabulary; silence is
  // "no decision" / "no contact" everywhere.
  await it.openState("#mode=field&focus=material%3Amdn-http-methods", "FIELD");
  const panel = await it.page.locator("#details").innerText();
  expect(panel.toLowerCase()).toContain("depth reached");
  expect(panel).toContain("no contact");
  await it.page.locator("#list-view").click();
  await it.page.waitForSelector('#main[data-state="LIST"]');
  let row = it.page.locator(
    '.node-list-row[data-node-id="material:mdn-http-methods"]',
  );
  expect(await row.innerText()).toContain("depth reached: no contact");
  const conceptRow = it.page.locator(
    '.node-list-row[data-node-id="concept:http-methods"]',
  );
  const words = await conceptRow.innerText();
  expect(words).toContain("exposure: read");
  expect(words).toContain("confidence: no decision");
  expect(words).toContain("freshness: fresh — last seen 2026-07-09");
  // Question status is gated (§14.6): the demo question has no confirmed decision, so its words
  // are the unstruck form — never a value indistinguishable from a decided "open".
  const questionRow = it.page.locator(
    '.node-list-row[data-node-id="question:demo-when-is-retry-safe"]',
  );
  expect(await questionRow.innerText()).toContain("status: no decision");
  // The legend speaks the same words for the drawn silence.
  await it.page.locator("#legend-toggle").click();
  const legend = await it.page.locator("#legend").innerText();
  expect(legend).toContain("no decision recorded");
  expect(legend).toContain("no contact");

  // §29 keeps medical-derived state out of the active viewer slice. The input contract still
  // validates its provenance, but the accepted projection neither draws nor names state-entry
  // sensitivity.
  const concept = conceptNode(it, "classed-state");
  const artifact = artifactNode(it, "classed-state-evidence", "noticed", "2026-07-16");
  artifact["sensitivity"] = "medical";
  const graph = asGraph(it.graphEnvelope({ nodes: [concept, artifact] }));
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  Object.assign(graph.state[nodeId(concept)]!, {
    exposure: "touched",
    last_seen: "2026-07-16",
    freshness: "fresh",
    evidence: [nodeId(artifact)],
    sensitivity: "medical",
  });
  it.writeGraph(graph);
  await it.openState("#mode=field", "FIELD");
  const fieldNode = it.page.locator(`g.node[data-node-id="${nodeId(concept)}"]`);
  expect(await fieldNode.locator(".sensitivity-dot").count()).toBe(0);
  await it.page.locator("#list-view").click();
  await it.page.waitForSelector('#main[data-state="LIST"]');
  row = it.page.locator(`.node-list-row[data-node-id="${nodeId(concept)}"]`);
  const rowWords = await row.innerText();
  expect(rowWords).toContain("exposure: touched");
  expect(rowWords).toContain("freshness: fresh — last seen 2026-07-16");
  expect(rowWords.toLowerCase()).not.toContain("state sensitivity");
  await row.click();
  await it.page.waitForSelector("#details:not([hidden])");
  const panelWords = await it.page.locator("#details").innerText();
  expect(panelWords).toContain("touched");
  expect(panelWords).toContain("fresh — last seen 2026-07-16");
  expect(
    await it.page
      .locator("#details .detail-row dt", { hasText: "state sensitivity" })
      .count(),
  ).toBe(0);
});

test("field undefined is a cartouche never a boundary dash", async () => {
  // §16.2 A4: a dash on a node boundary is always freshness, so the field-undefined flag is a
  // hairline cartouche plus words.
  await it.openState("#mode=field&focus=direction:demo-unanchored", "FIELD");
  const flagged = it.page.locator(".node.field-undefined.selected");
  expect(await flagged.locator(".cartouche").count()).toBe(1);
  expect(
    await evaluate<string>(
      it,
      `() => getComputedStyle(document.querySelector(
        ".node.field-undefined.selected .node-shape")).strokeDasharray`,
    ),
  ).toBe("none");
  // The frame encloses the whole drawn glyph rather than cutting it.
  expect(
    await evaluate<boolean>(
      it,
      `() => {
        const group = document.querySelector(".node.field-undefined.selected");
        const frame = group.querySelector(".cartouche").getBBox();
        const shape = group.querySelector(".node-shape").getBBox();
        return frame.x < shape.x && frame.y < shape.y
          && frame.x + frame.width > shape.x + shape.width
          && frame.y + frame.height > shape.y + shape.height;
      }`,
    ),
  ).toBe(true);
});

test("label anchor clears auxiliary kind marks", async () => {
  // A label starts after the complete glyph footprint, including a sensitivity dot, rather than
  // after only the primary plate.
  const artifact = artifactNode(it, "classed-label-anchor", "noticed", "2026-07-16");
  artifact["fields"] = ["knowledge"];
  artifact["sensitivity"] = "medical";
  const graph = asGraph(it.graphEnvelope({ nodes: [artifact] }));
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  it.writeGraph(graph);
  await it.openState("#mode=field", "FIELD");
  const geometry = await evaluateWithArgument<{ dotRight: number; labelX: number }>(
    it,
    `id => {
      const group = document.querySelector(\`g.node[data-node-id="\${id}"]\`);
      const dot = group.querySelector(".sensitivity-dot");
      return {
        dotRight: parseFloat(dot.getAttribute("cx")) + parseFloat(dot.getAttribute("r")),
        labelX: parseFloat(group.querySelector(".node-label").getAttribute("x")),
      };
    }`,
    nodeId(artifact),
  );
  expect(geometry.labelX - geometry.dotRight).toBeCloseTo(4, 2);
});

test("directed edges stop short of their endpoints", async () => {
  // An untrimmed stroke would bury its arrowhead under the target plate; every demo edge is long
  // enough to trim, so no rendered line may end at a node centre.
  await it.openState("#mode=field", "FIELD");
  const marker = it.page.locator("svg marker#arrow");
  expect(await marker.getAttribute("refX")).toBe("10");
  const viewBox = await marker.getAttribute("viewBox");
  if (viewBox === null) throw new TypeError("arrow marker has no viewBox");
  expect(viewBox.split(/\s+/).at(-2)).toBe("10");
  const untrimmed = await evaluate<number>(
    it,
    `() => {
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
          if (centres.some(centre => Math.hypot(centre.x - px, centre.y - py) < 0.01)) {
            count += 1;
          }
        }
      }
      return count;
    }`,
  );
  expect(untrimmed).toBe(0);
});

test("edges trim to noncircular circumradii", async () => {
  // A diagonal edge between square material parts needs halfExtent*sqrt(2) of clearance.
  // Coordinates are emitted at three decimals, so compare the resulting trim at two decimals.
  const graph = readDemoGraph();
  const visibleIds = new Set(
    graph.nodes
      .filter((node) => {
        const fields = node["fields"] as unknown[];
        return fields.includes("knowledge") || fields.length === 0;
      })
      .map(nodeId),
  );
  const visibleEdges = graph.edges.filter(
    (edge) =>
      visibleIds.has(edge["source"] as string) && visibleIds.has(edge["target"] as string),
  );
  const edgeIndex = visibleEdges.findIndex(
    (edge) =>
      edge["type"] === "supports" &&
      (edge["source"] as string).startsWith("part:") &&
      (edge["target"] as string).startsWith("part:"),
  );
  if (edgeIndex < 0) throw new Error("demo graph has no visible part-to-part supports edge");
  const edge = visibleEdges[edgeIndex]!;
  await it.openState("#mode=field", "FIELD");
  interface Trims {
    source: number;
    target: number;
    expected: number;
  }
  const trims = await evaluateWithArgument<Trims>(
    it,
    `({index, sourceId, targetId}) => {
      const centre = id => {
        const transform = document.querySelector(\`g.node[data-node-id="\${id}"]\`)
          .getAttribute("transform");
        const match = transform.match(/translate\\(([-\\d.]+) ([-\\d.]+)\\)/);
        return {x: parseFloat(match[1]), y: parseFloat(match[2])};
      };
      const hit = document.querySelectorAll("svg .edge-group")[index]
        .querySelector(".edge-hit");
      const source = centre(sourceId);
      const target = centre(targetId);
      return {
        source: Math.hypot(
          parseFloat(hit.getAttribute("x1")) - source.x,
          parseFloat(hit.getAttribute("y1")) - source.y,
        ),
        target: Math.hypot(
          parseFloat(hit.getAttribute("x2")) - target.x,
          parseFloat(hit.getAttribute("y2")) - target.y,
        ),
        expected: Math.hypot(4.5, 4.5)
          * parseFloat(getComputedStyle(document.documentElement)
            .getPropertyValue("--plate-r")) / 7 + 2,
      };
    }`,
    { index: edgeIndex, sourceId: edge["source"], targetId: edge["target"] },
  );
  expect(trims.source).toBeCloseTo(trims.expected, 2);
  expect(trims.target).toBeCloseTo(trims.expected, 2);
});

test("edges trim past target rail on its approach ray", async () => {
  // A right-side incoming arrow must stop outside the target's complete glyph, not under the
  // decision rail painted over it. The trim stays direction-sensitive rather than reserving rail
  // width on every side.
  const source = conceptNode(it, "a-source");
  const target = conceptNode(it, "b-target");
  target["sensitivity"] = "medical";
  const edge: Dict = {
    source: nodeId(source),
    target: nodeId(target),
    type: "prerequisite_of",
    provenance: [nodeId(source), nodeId(target)],
    weight: "low",
  };
  const graph = asGraph(it.graphEnvelope({ nodes: [source, target], edges: [edge] }));
  graph.state[nodeId(target)]!["sensitivity"] = "medical";
  it.writeGraph(graph);
  await it.openState("#mode=field", "FIELD");
  interface RailTrimGeometry {
    trim: number;
    railExit: number;
    railEntry: number;
  }
  const geometry = await evaluateWithArgument<RailTrimGeometry>(
    it,
    `({sourceId, targetId}) => {
      const centre = id => {
        const transform = document.querySelector(\`g.node[data-node-id="\${id}"]\`)
          .getAttribute("transform");
        const match = transform.match(/translate\\(([-\\d.]+) ([-\\d.]+)\\)/);
        return {x: Number(match[1]), y: Number(match[2])};
      };
      const source = centre(sourceId);
      const target = centre(targetId);
      const dx = source.x - target.x;
      const dy = source.y - target.y;
      const length = Math.hypot(dx, dy);
      const direction = {x: dx / length, y: dy / length};
      const line = document.querySelector(".edge-group .edge-line[marker-end]");
      const lineEnd = {
        x: Number(line.getAttribute("x2")),
        y: Number(line.getAttribute("y2")),
      };
      const slots = [...document.querySelectorAll(
        \`g.node[data-node-id="\${targetId}"] .rail-slot\`)];
      const left = Math.min(...slots.map(slot => Number(slot.getAttribute("x"))));
      const right = Math.max(...slots.map(
        slot => Number(slot.getAttribute("x")) + Number(slot.getAttribute("width"))));
      const top = Math.min(...slots.map(slot => Number(slot.getAttribute("y"))));
      const bottom = Math.max(...slots.map(
        slot => Number(slot.getAttribute("y")) + Number(slot.getAttribute("height"))));
      const slab = (component, minimum, maximum) => {
        const first = minimum / component;
        const second = maximum / component;
        return [Math.min(first, second), Math.max(first, second)];
      };
      const [xEntry, xExit] = slab(direction.x, left, right);
      const [yEntry, yExit] = slab(direction.y, top, bottom);
      return {
        trim: Math.hypot(lineEnd.x - target.x, lineEnd.y - target.y),
        railExit: Math.min(xExit, yExit),
        railEntry: Math.max(xEntry, yEntry),
      };
    }`,
    { sourceId: nodeId(source), targetId: nodeId(target) },
  );
  expect(geometry.railExit).toBeGreaterThan(geometry.railEntry);
  expect(geometry.trim).toBeGreaterThanOrEqual(geometry.railExit + 1.9);
});

test("forced colors keeps state structural", async () => {
  // §27.8: every state distinction survives forced colours because the channels are texture,
  // continuity, and mark extent — not hue.
  await it.page.emulateMedia({ forcedColors: "active" });
  await it.openState("#mode=field", "FIELD");
  const hatchedFill = await it.page.evaluate<string>(
    `getComputedStyle(document.querySelector(
      'g.node[data-node-id="concept:http-methods"] .node-shape')).fill`,
  );
  expect(hatchedFill).toContain("url");
  expect(await it.page.locator("svg .rail-slot").count()).toBeGreaterThan(0);
  const [plainFill, solidFill] = await evaluate<[string, string]>(
    it,
    `() => ["concept:redis", "concept:idempotency"].map(id =>
      getComputedStyle(document.querySelector(
        \`g.node[data-node-id="\${id}"] .node-shape\`)).fill)`,
  );
  expect(solidFill).not.toBe(plainFill);
  // The three boundary continuities stay three under the forced palette.
  const { graph, contacts } = freshnessGraph(it);
  it.writeGraph(graph);
  await it.openState("#mode=field", "FIELD");
  const { dashes } = await boundaryDashes(it, contacts);
  expect(new Set(Object.values(dashes)).size).toBe(3);
});

test("focus opens panel for each rendered kind", async () => {
  const graph = readDemoGraph();
  const examples = new Map<string, Dict>();
  for (const node of graph.nodes) {
    const fields = node["fields"] as unknown[];
    if (fields.includes("knowledge") || fields.length === 0) {
      const nodeType = node["type"] as string;
      if (!examples.has(nodeType)) examples.set(nodeType, node);
    }
  }
  for (const [nodeType, node] of examples) {
    const label = `node_type=${nodeType}`;
    const focus = encodeURIComponent(nodeId(node));
    await it.openState(`#mode=field&focus=${focus}`, "FIELD");
    await it.page.waitForSelector("#details:not([hidden])");
    const expectedHeading = (node["title"] as string) || nodeId(node);
    expect(await it.page.locator("#details h2").innerText(), label).toBe(expectedHeading);
    expect(await it.page.locator("#details .type-chip").innerText(), label).toBe(
      nodeType.replaceAll("_", " "),
    );
    expect(await it.page.locator("svg .node.selected").count(), label).toBe(1);
  }
});

test("url field is link only after https reparse", async () => {
  const nodes: Dict[] = [
    {
      id: "material:linked",
      type: "material",
      title: "Linked material",
      fields: ["knowledge"],
      kind: "docs",
      url: "https://example.test/Guide",
      status: "active",
    },
    {
      id: "material:inert",
      type: "material",
      title: "Inert material",
      fields: ["knowledge"],
      kind: "docs",
      url: "https://a%",
      status: "active",
    },
  ];
  it.writeGraph(it.graphEnvelope({ nodes }));
  await it.openState("#mode=field&focus=material%3Alinked", "FIELD");
  const link = it.page.locator("#details .detail-row a");
  expect(await link.count()).toBe(1);
  expect(await link.innerText()).toBe("https://example.test/Guide");
  expect(await link.getAttribute("rel")).toBe("noopener noreferrer");
  // No target="_blank": the §16.5 sandbox grants no popups, so an auxiliary context would leave
  // embedded links inert.
  expect(await link.getAttribute("target")).toBeNull();

  await it.openState("#mode=field&focus=material%3Ainert", "FIELD");
  expect(await it.page.locator("#details .detail-row a").count()).toBe(0);
  expect(await it.page.locator("#details").innerText()).toContain("https://a%");
});

test("layout is deterministic and focus survives reload", async () => {
  await it.openState("#mode=field", "FIELD");
  const first = await evaluate<(string | null)[]>(
    it,
    `() => [...document.querySelectorAll("svg .node")]
      .map(node => node.getAttribute("transform"))`,
  );
  await it.page.reload({ waitUntil: "domcontentloaded" });
  await it.page.waitForSelector('#main[data-state="FIELD"]');
  const second = await evaluate<(string | null)[]>(
    it,
    `() => [...document.querySelectorAll("svg .node")]
      .map(node => node.getAttribute("transform"))`,
  );
  expect(second).toEqual(first);

  await it.openState("#mode=field&focus=concept%3Aidempotency", "FIELD");
  await it.page.waitForSelector("#details:not([hidden])");
  const selectedBefore = await it.page
    .locator("svg .node.selected")
    .getAttribute("transform");
  const viewportBefore = await it.page.locator("svg .viewport").getAttribute("transform");
  await it.page.reload({ waitUntil: "domcontentloaded" });
  await it.page.waitForSelector('#main[data-state="FIELD"]');
  await it.page.waitForSelector("#details:not([hidden])");
  expect(await it.page.locator("svg .node.selected").count()).toBe(1);
  expect(await it.page.locator("svg .node.selected").getAttribute("transform")).toBe(
    selectedBefore,
  );
  expect(await it.page.locator("svg .viewport").getAttribute("transform")).toBe(
    viewportBefore,
  );
});

test("plates never settle on top of one another", async () => {
  // Two plates in one place hide each other's state: the reader cannot tell one texture,
  // boundary, or rail from the other, and A11's drop order has no tier that would rescue it. The
  // separation pass runs in frame units after the fit, so the guarantee is what is drawn.
  await it.openState("#mode=field", "FIELD");
  const overlaps = await evaluate<string[]>(
    it,
    `() => {
      const boxes = [...document.querySelectorAll("svg .node")].map(node => ({
        id: node.dataset.nodeId,
        box: node.querySelector(".node-shape").getBoundingClientRect(),
      }));
      const hits = [];
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i].box;
          const b = boxes[j].box;
          if (a.left < b.right && b.left < a.right
              && a.top < b.bottom && b.top < a.bottom) {
            hits.push(boxes[i].id + " / " + boxes[j].id);
          }
        }
      }
      return hits;
    }`,
  );
  expect(overlaps).toEqual([]);
});

test("labels clear each other and stay seeded", async () => {
  // A label that lands on its neighbour's label is the label channel drawn and unreadable at
  // once. Each takes the first free slot around its node; the slot order is fixed, so the same
  // graph keeps the same sides and the picture stays seeded (§27.8).
  await it.openState("#mode=field", "FIELD");
  const readLabels = `() => [...document.querySelectorAll("svg .node")]
    .map(node => {
      const label = node.querySelector(".node-label");
      const box = label.getBoundingClientRect();
      return {
        id: node.dataset.nodeId,
        anchor: label.getAttribute("text-anchor") || "start",
        x: label.getAttribute("x"),
        y: label.getAttribute("y"),
        box: {left: box.left, right: box.right, top: box.top, bottom: box.bottom},
      };
    })`;
  interface LabelMeasurement {
    id: string;
    anchor: string;
    x: string | null;
    y: string | null;
    box: { left: number; right: number; top: number; bottom: number };
  }
  const labels = await evaluate<LabelMeasurement[]>(it, readLabels);
  const overlaps: string[] = [];
  for (let index = 0; index < labels.length; index += 1) {
    const left = labels[index]!;
    for (const right of labels.slice(index + 1)) {
      const a = left.box;
      const b = right.box;
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
        overlaps.push(`${left.id} / ${right.id}`);
      }
    }
  }
  expect(overlaps).toEqual([]);
  // The demo field is crowded enough that clearing the collisions needs the left side, so the
  // sweep is proved to do something here.
  expect(new Set(labels.map((label) => label.anchor))).toContain("end");

  await it.page.reload({ waitUntil: "domcontentloaded" });
  await it.page.waitForSelector('#main[data-state="FIELD"]');
  const repeated = await evaluate<LabelMeasurement[]>(it, readLabels);
  expect(repeated.map(({ id, anchor, x, y }) => [id, anchor, x, y])).toEqual(
    labels.map(({ id, anchor, x, y }) => [id, anchor, x, y]),
  );
});

test("edges of one pair are drawn apart", async () => {
  // The demo graph joins some pairs by more than one edge — related_to and alternative_to say
  // different things about the same two nodes. Stacked on one axis the field would show one
  // stroke where the graph holds several, so each takes its own lane.
  await it.openState("#mode=field", "FIELD");
  const spans = await evaluate<string[]>(
    it,
    `() => [...document.querySelectorAll("svg .edge-group")].map(group => {
      const line = group.querySelector(".weight-dropped") || group.querySelector(".edge-line");
      return ["x1", "y1", "x2", "y2"]
        .map(name => Number(line.getAttribute(name)).toFixed(1))
        .join(",");
    })`,
  );
  expect(new Set(spans).size).toBe(spans.length);
});
