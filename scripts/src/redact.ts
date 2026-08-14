// §20 step 12 / §32.6: the redacted sibling of an emitted graph.
//
// Taint lives on whole nodes. A classed node leaves as a unit, and so does
// everything resting on it — edges touching its id, silhouette entries for
// that zone, folded state that cites it. Nothing is ever rewritten: a
// half-erased payload is a leak wearing a redaction, and the full graph beside
// it is left exactly as it was. What the redacted file discloses about any of
// this is a count.
//
// The closure is a fixpoint rather than a pass, because withholding a node
// drops its edges, and dropping an edge can strand a derived field on a node
// that survived — which withholds that node, which drops more edges. It
// settles when a round adds nobody.
//
// Ported from _redact_graph in scripts/build_atlas_graph.py.

import { graphFieldExpectations } from "./domain.ts";
import { sameJson } from "./checks.ts";

type Dict = Record<string, unknown>;

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asRecord = (value: unknown): Dict | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Dict)
    : null;

/**
 * Every string anywhere in a payload, joined on a byte no id can contain.
 *
 * The identity fields the caller checks exactly are skipped; everything else
 * is in scope, reference fields and free text alike. The separator keeps two
 * neighbouring strings from spelling an id between them that neither one
 * holds.
 */
function payloadText(mapping: Dict, skip: ReadonlySet<string>): string {
  const parts: string[] = [];
  const stack: unknown[] = [];
  for (const [key, value] of Object.entries(mapping)) {
    if (!skip.has(key)) stack.push(value);
  }
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) stack.push(...value);
    else if (value !== null && typeof value === "object") {
      stack.push(...Object.values(value as Dict));
    }
  }
  // The separator is a NUL, written as an escape and never as the byte:
  // it is the one character no id or payload string of ours carries, so two
  // neighbouring parts can never spell an id between them that neither holds.
  // As the byte it would make this file binary to grep, diff and review.
  return parts.join("\u0000");
}

/** The refs a folded state entry cites, in its evidence and its decisions. */
function stateEvidenceRefs(entry: Dict): Set<string> {
  const refs = new Set<string>();
  const evidence = entry["evidence"];
  if (Array.isArray(evidence)) {
    for (const ref of evidence) if (typeof ref === "string") refs.add(ref);
  }
  const decisions = entry["decisions"];
  if (Array.isArray(decisions)) {
    for (const decision of decisions) {
      if (decision === null || typeof decision !== "object") continue;
      const cited = (decision as Dict)["evidence"];
      if (!Array.isArray(cited)) continue;
      for (const ref of cited) if (typeof ref === "string") refs.add(ref);
    }
  }
  return refs;
}

export function redactGraph(graph: Dict): Dict {
  const nodesIn = asList(graph["nodes"]) as Dict[];
  const edgesIn = asList(graph["edges"]) as Dict[];

  const withheld = new Set<string>();
  for (const node of nodesIn) {
    if ("sensitivity" in node) withheld.add(node["id"] as string);
  }

  const EDGE_IDENTITY = new Set([
    "source",
    "target",
    "context",
    "step",
    "provenance",
  ]);
  const NODE_IDENTITY = new Set(["id"]);

  // An edge leaves whole when any id it carries is withheld: its endpoints,
  // its own class, and the identity metadata that also holds node ids — a
  // route in `context`, a concept in `step`. What is left after those (a note,
  // a weight) gets the same scan a node payload gets, because a withheld id
  // in an edge's free text is the same leak as one in a reference field.
  const keepEdge = (edge: Dict): boolean => {
    if (
      withheld.has(edge["source"] as string) ||
      withheld.has(edge["target"] as string) ||
      withheld.has(edge["context"] as string) ||
      withheld.has(edge["step"] as string) ||
      "sensitivity" in edge ||
      asList(edge["provenance"]).some(
        (ref) => typeof ref === "string" && withheld.has(ref),
      )
    ) {
      return false;
    }
    const text = payloadText(edge, EDGE_IDENTITY);
    return ![...withheld].some((marked) => text.includes(marked));
  };

  let nodes: Dict[] = [];
  let edges: Dict[] = [];
  for (;;) {
    // Citation taint, to a fixpoint of its own: a surviving node whose payload
    // carries a withheld id rests on it and leaves whole. Containment is the
    // test on purpose — an id embedded in surviving prose is the same leak as
    // one in a reference field, and mentioning it deliberately taints by
    // construction.
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodesIn) {
        const id = node["id"] as string;
        if (withheld.has(id)) continue;
        const text = payloadText(node, NODE_IDENTITY);
        if ([...withheld].some((marked) => text.includes(marked))) {
          withheld.add(id);
          changed = true;
        }
      }
    }
    nodes = nodesIn.filter((node) => !withheld.has(node["id"] as string));
    edges = edgesIn.filter(keepEdge);
    // §10.4: a surviving node's fields must still be derivable from the
    // surviving edges. One that is not rests on refs that were redacted, and
    // a derived value resting on classed data is marked by the union — so it
    // leaves whole, which drops its edges, which can strand the next one.
    const expected = graphFieldExpectations({ nodes, edges });
    const stale = new Set<string>();
    for (const node of nodes) {
      const id = node["id"] as string;
      const wanted = expected.get(id);
      if (wanted !== undefined && !sameJson(node["fields"], wanted)) {
        stale.add(id);
      }
    }
    if (stale.size === 0) break;
    for (const id of stale) withheld.add(id);
  }

  const projections: Dict = {};
  for (const [zone, region] of Object.entries(
    asRecord(graph["projections"]) ?? {},
  )) {
    if (!withheld.has(zone)) projections[zone] = region;
  }

  // A folded value is its own §32.6 granularity, omitted whole when its
  // provenance union marked it, when its target left, or when it cites a
  // withheld id — otherwise its `evidence` and `decisions` would carry that id
  // into the output. Here the refs are closed id arrays rather than free text,
  // so the test is exact: `artifact:a` must not take `artifact:a-long` with
  // it. Nothing derives from state, so the closure ends here.
  const keepState = (nodeId: string, entry: unknown): boolean => {
    if (withheld.has(nodeId)) return false;
    const record = asRecord(entry);
    if (record === null) return true;
    if ("sensitivity" in record) return false;
    return ![...stateEvidenceRefs(record)].some((ref) => withheld.has(ref));
  };

  const stateIn = asRecord(graph["state"]) ?? {};
  const state: Dict = {};
  for (const [nodeId, entry] of Object.entries(stateIn)) {
    if (keepState(nodeId, entry)) state[nodeId] = entry;
  }

  const redacted: Dict = { ...graph };
  redacted["nodes"] = nodes;
  redacted["edges"] = edges;
  redacted["state"] = state;
  redacted["projections"] = projections;
  // atlas-graph.schema.json asks for every §10 payload key, the zeros too.
  redacted["withheld"] = {
    nodes: nodesIn.length - nodes.length,
    edges: edgesIn.length - edges.length,
    trails: 0,
    state: Object.keys(stateIn).length - Object.keys(state).length,
    influence: 0,
    frontier: 0,
    projections:
      Object.keys(asRecord(graph["projections"]) ?? {}).length -
      Object.keys(projections).length,
  };
  return redacted;
}
