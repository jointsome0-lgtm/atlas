import type { Locator } from "playwright";

import type { Dict, Fixture } from "./harness.ts";

export function chainGraph(it: Fixture): Dict {
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

export async function viewportTransform(it: Fixture): Promise<string | null> {
  return await it.page.evaluate<string | null>(
    "document.querySelector('.viewport').getAttribute('transform')",
  );
}

export async function hitPoint(
  it: Fixture,
  selector: string,
): Promise<[number, number] | null> {
  // The centre of an element is only a usable press target if it is what
  // the pointer would actually land on — edges carry a wide invisible
  // hit stroke that sits over its neighbours.
  const source = `(want) => {
      for (const el of document.querySelectorAll("svg " + want)) {
        const box = el.getBoundingClientRect();
        const x = Math.round(box.left + box.width / 2);
        const y = Math.round(box.top + box.height / 2);
        const hit = document.elementFromPoint(x, y);
        if (hit && hit.matches(want)) return [x, y];
      }
      return null;
    }`;
  return await it.page.evaluate<[number, number] | null>(
    `(${source})(${JSON.stringify(selector)})`,
  );
}

export async function incidentPairs(it: Fixture): Promise<string[]> {
  const source = `() => [...document.querySelectorAll("svg .edge-group.incident")]
    .map((g) => g.dataset.source + " " + (g.dataset.target || ""))`;
  const pairs = await it.page.evaluate<string[]>(`(${source})()`);
  return pairs.sort();
}

export async function dragFrom(it: Fixture, x: number, y: number): Promise<boolean> {
  const transform = "document.querySelector('svg .viewport').getAttribute('transform')";
  const before = await it.page.evaluate<string | null>(transform);
  await it.page.mouse.move(x, y);
  await it.page.mouse.down();
  for (let step = 1; step < 13; step += 1) {
    await it.page.mouse.move(x + step * 18, y + step * 5);
  }
  await it.page.mouse.up();
  return (await it.page.evaluate<string | null>(transform)) !== before;
}

export async function zoomOutUntil(
  it: Fixture,
  viewport: Locator,
  minus: Locator,
  className: string,
  limit = 14,
): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    if ((await viewport.getAttribute("class"))?.includes(className)) return;
    await minus.click();
  }
  throw new Error(`${className} never engaged within the zoom range`);
}

export function conceptNode(_it: Fixture, slug: string): Dict {
  return {
    id: `concept:${slug}`,
    type: "concept",
    title: `${slug} (Vera Example)`,
    fields: ["knowledge"],
    aliases: [],
  };
}

export function artifactNode(
  _it: Fixture,
  slug: string,
  strength: string,
  observedAt: string,
): Dict {
  return {
    id: `artifact:${slug}`,
    type: "artifact",
    title: "",
    fields: [],
    kind: "note",
    path: `notes/${slug}.md`,
    observed_at: observedAt,
    summary: `Synthetic viewer fixture (Vera Example): ${slug}.`,
    evidence_strength: strength,
  };
}

export async function nodeClass(it: Fixture, nodeId: string): Promise<string | null> {
  return await it.page.locator(`g.node[data-node-id="${nodeId}"]`).getAttribute("class");
}

export type FreshnessContacts = Record<string, readonly [string, string]>;

export interface FreshnessGraph {
  graph: Dict;
  contacts: FreshnessContacts;
}

export function freshnessGraph(it: Fixture): FreshnessGraph {
  const fresh = conceptNode(it, "fresh-example");
  const aging = conceptNode(it, "aging-example");
  const stale = conceptNode(it, "stale-example");
  const contacts: FreshnessContacts = {
    [fresh["id"] as string]: ["2026-07-10", "fresh"],
    [aging["id"] as string]: ["2026-05-20", "aging"],
    [stale["id"] as string]: ["2026-04-01", "stale"],
  };
  const artifacts: Dict[] = [];
  const graph = it.graphEnvelope({ nodes: [fresh, aging, stale] });
  graph["generated_at"] = "2026-07-16T00:00:00Z";
  const state = graph["state"] as Record<string, Dict>;
  let index = 0;
  for (const [conceptId, [seen, freshness]] of Object.entries(contacts)) {
    const artifact = artifactNode(it, `contact-${index}`, "read", seen);
    artifacts.push(artifact);
    Object.assign(state[conceptId]!, {
      exposure: "read",
      last_seen: seen,
      freshness,
      evidence: [artifact["id"]],
    });
    index += 1;
  }
  (graph["nodes"] as Dict[]).push(...artifacts);
  return { graph, contacts };
}

export interface BoundaryMeasurements {
  dashes: Record<string, string>;
  labels: Record<string, string>;
}

export async function boundaryDashes(
  it: Fixture,
  contacts: FreshnessContacts,
): Promise<BoundaryMeasurements> {
  const dashes: Record<string, string> = {};
  const labels: Record<string, string> = {};
  for (const [conceptId, [, freshness]] of Object.entries(contacts)) {
    const measured = await it.page.evaluate<[string, string]>(
      `(id => {
        const group = document.querySelector(\`g.node[data-node-id="\${id}"]\`);
        return [
          getComputedStyle(group.querySelector(".node-shape")).strokeDasharray,
          getComputedStyle(group.querySelector(".node-label")).fill,
        ];
      })(${JSON.stringify(conceptId)})`,
    );
    dashes[freshness] = measured[0];
    labels[freshness] = measured[1];
  }
  return { dashes, labels };
}

export function wideRouteField(it: Fixture): Dict {
  // A path long enough to open wider than the frame, carrying one route
  // edge so a dashed family is on screen. §20.3 canonical order sorts by
  // type first, so every related_to precedes the suggested_next.
  const nodes: Dict[] = Array.from({ length: 140 }, (_, index) => ({
    id: `concept:n${index.toString().padStart(3, "0")}`,
    type: "concept",
    title: `N${index.toString().padStart(3, "0")}`,
    fields: ["knowledge"],
    aliases: [],
  }));
  nodes.push({
    id: "suggested-route:wide",
    type: "suggested_route",
    title: "Wide route",
    status: "available",
    source_plan: "plan:wide",
    fields: ["knowledge"],
  });
  nodes.push({
    id: "plan:wide",
    type: "plan",
    title: "Wide plan",
    fields: ["knowledge"],
  });
  const edges: Dict[] = Array.from({ length: 139 }, (_, index) => ({
    source: `concept:n${index.toString().padStart(3, "0")}`,
    target: `concept:n${(index + 1).toString().padStart(3, "0")}`,
    type: "related_to",
    provenance: [`concept:n${index.toString().padStart(3, "0")}`],
    weight: "unassessed",
  }));
  edges.push({
    source: "concept:n000",
    target: "concept:n139",
    type: "suggested_next",
    provenance: ["suggested-route:wide"],
    context: "suggested-route:wide",
  });
  return it.graphEnvelope({ nodes, edges });
}

export interface DashMeasurement {
  zoom: number;
  scale: number;
  screen: number;
  dash: number[];
}

export async function measuredDash(it: Fixture): Promise<DashMeasurement> {
  const source = `() => {
    const viewport = document.querySelector("svg .viewport");
    const route = document.querySelector("svg .edge-route");
    return {
      zoom: Number(viewport.getAttribute("transform").match(/scale\\(([\\d.]+)\\)/)[1]),
      scale: Number(getComputedStyle(viewport).getPropertyValue("--dash-scale")),
      screen: Number(getComputedStyle(viewport).getPropertyValue("--screen-scale")),
      dash: getComputedStyle(route).strokeDasharray.match(/[\\d.]+/g).map(Number),
    };
  }`;
  return await it.page.evaluate<DashMeasurement>(`(${source})()`);
}
