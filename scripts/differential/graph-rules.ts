import { foldRoots, oracleAnswer, unfoldRoots } from "./oracle.ts";
// Differential harness: the emitted-graph joins against the CPython oracle.
//
// Unlike the §-rule harness next door, these rules are not small pure
// functions over invented records — they are one pass over a whole graph, and
// every clause reads a table some earlier clause built. A corpus of invented
// fragments would exercise the clauses and miss the tables, so this one starts
// from `fixtures/demo-graph/atlas-graph.json` — a real, valid emission — and
// applies one mutation per clause. A rule that stopped firing then has a case
// that used to fire and now does not, and the unmutated base proves the whole
// pass stays silent on a graph a real build produced.
//
// Both sides read the same bytes off the same disk: the harness writes each
// case into its own temp instance, the oracle runs `validate_instance` over
// it, and this side runs the ported reader over the same file. That also
// means the diagnostics carry the same absolute path on both sides, so
// nothing has to be folded away before comparing.

import fs from "node:fs";

import { snapshotDanglingRefs, snapshotStateKindErrors } from "../src/checks.ts";
import { stateCitesWithheldId } from "../src/checks.ts";
import { emittedGraphErrors } from "../src/graph-rules.ts";
import { readJsonFile } from "../src/json-input.ts";
import { AtlasReader } from "../src/reader.ts";
import { loadRegistry, schemaErrors } from "../src/schema-registry.ts";
import { foldQuotes } from "./spelling.ts";

type Dict = Record<string, unknown>;

const DIFFERENTIAL = import.meta.dir;
const ROOT = `${DIFFERENTIAL}/../..`;

// The three emitted files the oracle looks for, in the order it looks for
// them: the full graph is read first because the redacted variant is only
// checkable against the sibling it redacts.
const EMITTED: ReadonlyArray<readonly [string, string]> = [
  ["atlas-graph.json", "atlas-graph"],
  ["atlas-graph.redacted.json", "atlas-graph"],
  ["atlas-snapshot.json", "atlas-snapshot"],
];

// ---------------------------------------------------------------------------
// The base emission and the surgery done to it
// ---------------------------------------------------------------------------

const BASE_TEXT = fs.readFileSync(
  `${ROOT}/fixtures/demo-graph/atlas-graph.json`,
  "utf8",
);

const clone = (): Dict => JSON.parse(BASE_TEXT) as Dict;

const nodesOf = (graph: Dict): Dict[] => graph["nodes"] as Dict[];
const edgesOf = (graph: Dict): Dict[] => graph["edges"] as Dict[];
const stateOf = (graph: Dict): Dict => graph["state"] as Dict;

/** The node with this id, or a throw: a typo must not become a quiet case. */
function nodeOf(graph: Dict, id: string): Dict {
  const node = nodesOf(graph).find((entry) => entry["id"] === id);
  if (node === undefined) throw new Error(`no node ${id} in the base graph`);
  return node;
}

function edgeIndexOf(
  graph: Dict,
  type: string,
  source: string,
  target: string,
): number {
  const index = edgesOf(graph).findIndex(
    (entry) =>
      entry["type"] === type &&
      entry["source"] === source &&
      entry["target"] === target,
  );
  if (index < 0) {
    throw new Error(`no ${type} edge ${source} -> ${target} in the base graph`);
  }
  return index;
}

/** Edges are addressed by what they say, not by an index that shifts. */
function edgeOf(graph: Dict, type: string, source: string, target: string): Dict {
  return edgesOf(graph)[edgeIndexOf(graph, type, source, target)] as Dict;
}

function dropEdge(graph: Dict, type: string, source: string, target: string): void {
  edgesOf(graph).splice(edgeIndexOf(graph, type, source, target), 1);
}

/** Two edges exchanged in place, for the orders `addEdge` will not produce. */
function swapEdges(
  graph: Dict,
  left: (edge: Dict) => boolean,
  right: (edge: Dict) => boolean,
): void {
  const edges = edgesOf(graph);
  const here = edges.findIndex(left);
  const there = edges.findIndex(right);
  if (here < 0 || there < 0) throw new Error("no such pair of edges to swap");
  [edges[here], edges[there]] = [edges[there] as Dict, edges[here] as Dict];
}

/**
 * §20.3's canonical identity order, spelled here so an inserted edge lands
 * where a real build would have put it.
 *
 * Deliberately a second implementation rather than an import: an edge this
 * comparator misplaces produces the "not in canonical identity order"
 * diagnostic on *both* sides, so a disagreement between the two spellings
 * shows up as a case that no longer isolates its clause, never as a false
 * agreement.
 */
function canonicalKey(edge: Dict): [string, string, string, string, number, string] {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const order = edge["order"];
  return [
    text(edge["type"]),
    text(edge["source"]),
    text(edge["target"]),
    text(edge["context"]),
    typeof order === "number" ? order : 0,
    text(edge["step"]),
  ];
}

function addEdge(graph: Dict, edge: Dict): void {
  edgesOf(graph).push(edge);
  edgesOf(graph).sort((left, right) => {
    const leftKey = canonicalKey(left);
    const rightKey = canonicalKey(right);
    for (let index = 0; index < leftKey.length; index += 1) {
      const a = leftKey[index] as string | number;
      const b = rightKey[index] as string | number;
      if (a < b) return -1;
      if (a > b) return 1;
    }
    return 0;
  });
}

/**
 * A second encounter, reading the FastAPI part while the retry artifact was
 * the context.
 *
 * §11.3's supporting arm folds from exactly this shape — an encounter whose
 * target is the material and whose context artifact the segment produced —
 * and nothing in the base graph has it, so the whole arm would sit behind a
 * "not backed" early return without this.
 */
function withSecondEncounter(graph: Dict): void {
  nodesOf(graph).push({
    id: "encounter:demo-fastapi-read",
    type: "encounter",
    title: "Read the FastAPI path-operations page while writing the retry wrapper",
    date: "2026-07-09",
    target: "part:fastapi-tutorial/path-operations",
    depth: "read",
    mode: "artifact-driven",
    context: { artifact: "artifact:demo-retry-script" },
    fields: ["knowledge"],
  });
  addEdge(graph, {
    source: "encounter:demo-fastapi-read",
    target: "part:fastapi-tutorial/path-operations",
    type: "visited",
    provenance: ["encounter:demo-fastapi-read"],
  });
}

/**
 * The §32.6 redaction of a full graph: nodes withheld whole, every edge that
 * names one dropped, and every state value that rests on one dropped with it.
 *
 * The port's own `stateCitesWithheldId` decides the last part. That is not
 * circular: a wrong answer here builds a redacted file the oracle then judges
 * differently, which is a divergence this harness reports rather than hides.
 */
function redact(full: Dict, withheldIds: readonly string[]): Dict {
  const withheld = new Set(withheldIds);
  const nodes = nodesOf(full).filter((node) => !withheld.has(node["id"] as string));
  const kept = new Set(nodes.map((node) => node["id"] as string));
  const names = (edge: Dict): string[] => {
    const refs: string[] = [];
    for (const key of ["source", "target", "context", "step"] as const) {
      if (typeof edge[key] === "string") refs.push(edge[key] as string);
    }
    for (const list of ["provenance", "alternative_in"] as const) {
      for (const ref of (edge[list] as unknown[] | undefined) ?? []) {
        if (typeof ref === "string") refs.push(ref);
      }
    }
    return refs;
  };
  const edges = edgesOf(full).filter((edge) =>
    names(edge).every((ref) => kept.has(ref)),
  );
  const state: Dict = {};
  let droppedState = 0;
  for (const [id, entry] of Object.entries(stateOf(full))) {
    const classed =
      typeof entry === "object" && entry !== null && "sensitivity" in entry;
    if (withheld.has(id) || classed || stateCitesWithheldId(entry, withheld)) {
      droppedState += 1;
      continue;
    }
    state[id] = entry;
  }
  return {
    ...full,
    nodes,
    edges,
    state,
    withheld: {
      nodes: nodesOf(full).length - nodes.length,
      edges: edgesOf(full).length - edges.length,
      trails: 0,
      state: droppedState,
      influence: 0,
      frontier: 0,
      projections: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/**
 * What each case must draw, so agreement can never be vacuous.
 *
 * Two implementations agree perfectly about a file neither of them reaches.
 * `fires` — the default — says the mutation must make at least one *rule*
 * diagnostic appear; `clean` says the graph is one a real build could have
 * emitted and nothing at all may be said about it; `quiet` says the rules stay
 * silent while the schema still speaks, which is the honest state of a case
 * built to exercise one rule on a deliberately partial record.
 */
type Expect = "fires" | "clean" | "quiet";

interface Case {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly expect: Expect;
  /**
   * Words the oracle must use about this case.
   *
   * `fires` only asks that *a* rule spoke, and a mutation can perfectly well
   * draw a different one — a review found one case here doing exactly that.
   * Where a mutation is close enough to another rule for that to be plausible,
   * the case names the sentence it is about and stops being satisfiable by
   * the neighbour.
   */
  readonly says: readonly string[];
}

const cases: Case[] = [];

function add(
  name: string,
  files: Record<string, unknown>,
  expect: Expect = "fires",
  says: readonly string[] = [],
): void {
  const text: Record<string, string> = {};
  for (const [filename, value] of Object.entries(files)) {
    // A case may hand over the bytes itself. Some spellings — a `.0` on an
    // integer — do not survive a round trip through a JavaScript value, and
    // those are exactly the ones worth comparing.
    text[filename] =
      typeof value === "string" ? value : JSON.stringify(value, null, 1);
  }
  cases.push({ name, files: text, expect, says });
}

/** One mutation of the base full graph, emitted on its own. */
function graph(
  name: string,
  mutate: (graph: Dict) => void,
  expect: Expect = "fires",
  says: readonly string[] = [],
): void {
  const subject = clone();
  mutate(subject);
  add(name, { "atlas-graph.json": subject }, expect, says);
}

/** A full graph and its redacted sibling, each mutable in turn. */
function pair(
  name: string,
  withheldIds: readonly string[],
  mutate: (full: Dict, redacted: Dict) => void,
  expect: Expect = "fires",
): void {
  const full = clone();
  const redacted = redact(full, withheldIds);
  mutate(full, redacted);
  add(
    name,
    {
      "atlas-graph.json": full,
      "atlas-graph.redacted.json": redacted,
    },
    expect,
  );
}

// -- the base itself --------------------------------------------------------

// The premise of every case below: the fixture a real build produced draws no
// diagnostic at all. Without it a mutation that fires for the wrong reason
// looks exactly like one that fires for the right one.
graph("base: the demo emission is silent", () => {}, "clean");

// -- the schema arm of the same loop ---------------------------------------

// The graph rules run beside the schema pass and their diagnostics interleave,
// so the schema's own spellings belong in this corpus: an enum and a closed
// key set are rendered as *lists*, and no earlier harness had a case where a
// list in a message held more than one member.
// The enum has to be one no `oneOf` sits in front of, or the complaint folds
// into a count of matching branches and the list is never printed at all —
// which is what an earlier version of this case did, agreeing loudly about a
// spelling it never reached. The sentence is named so it cannot happen again.
graph(
  "schema: a value outside its enum",
  (subject) => {
    nodeOf(subject, "concept:redis")["type"] = "mastery";
  },
  "fires",
  ["value is outside allowed choices ["],
);

// A state value off its ladder, which the oracle folds into a `oneOf` count —
// the same mutation, met by the other half of the schema layer, and the reason
// the case above had to move.
graph("schema: a value outside a folded enum", (subject) => {
  (stateOf(subject)["concept:redis"] as Dict)["exposure"] = "mastered";
});

// At the top level, where no `oneOf` is there to fold the complaint into a
// count of matching branches.
graph(
  "schema: a property outside the closed key set",
  (subject) => {
    subject["mastery"] = "high";
  },
  "quiet",
  ["unknown property outside the closed key set ["],
);

graph(
  "schema: the wrong format constant",
  (subject) => {
    subject["format"] = "atlas-graph-v2";
  },
  "quiet",
);

// -- node pass (§10.1, §10.4) ----------------------------------------------

graph("nodes: a duplicated id", (subject) => {
  nodesOf(subject).push({ ...nodeOf(subject, "concept:redis") });
});

// Two records under one id, disagreeing about the kind. Whichever of them the
// evidence table keeps decides what a ladder rung is allowed to rest on, so
// "first wins" and "last wins" are different validators — and a duplicate of
// an identical record cannot tell them apart.
graph("nodes: a duplicated id under a different kind", (subject) => {
  nodesOf(subject).push({
    ...nodeOf(subject, "encounter:demo-mdn-idempotency-read"),
    type: "artifact",
  });
});

// A node that is not an object at all. The dated-node pass reports positions
// in the whole array, so a skipped entry ahead of a dated one is the only
// thing that separates that index from an index into the dated ones.
graph("nodes: a non-object ahead of the dated ones", (subject) => {
  nodeOf(subject, "encounter:demo-mdn-idempotency-read")["date"] = "2026-07-11";
  nodesOf(subject).unshift(null as unknown as Dict);
});

// §10.4 field membership is derived, not declared; the field pass runs first
// and nothing else in this corpus makes it speak.
graph("nodes: fields that are not the derivation", (subject) => {
  nodeOf(subject, "part:mdn-http-methods/idempotency")["fields"] = [
    "body",
    "knowledge",
  ];
});

graph("nodes: a part embedding the wrong material", (subject) => {
  nodeOf(subject, "part:mdn-http-methods/idempotency")["material"] =
    "material:fastapi-tutorial";
});

// -- the as-of (§20.1) ------------------------------------------------------

graph("as-of: dated nodes with no generated_at", (subject) => {
  delete subject["generated_at"];
});

graph("as-of: a generated_at that is not a date", (subject) => {
  subject["generated_at"] = "the tenth of July";
});

graph("as-of: a node dated after it", (subject) => {
  nodeOf(subject, "encounter:demo-mdn-idempotency-read")["date"] = "2026-07-11";
});

// The node arm reads the dated *field*, so stripping every one of them leaves
// the state arm alone — the two are separate diagnostics and a case that
// fires both proves neither.
// Each dated kind carries its own payload field, so one case per kind is the
// only way a kind dropped from that table shows up.
graph("as-of: an artifact dated after it", (subject) => {
  nodeOf(subject, "artifact:demo-retry-script")["observed_at"] = "2026-07-11";
});

graph("as-of: a question dated after it", (subject) => {
  nodeOf(subject, "question:demo-when-is-retry-safe")["created_at"] = "2026-07-11";
});

graph("as-of: a segment dated after it", (subject) => {
  nodeOf(subject, "trail-segment:2026-07-10-retry-with-idempotency")["date"] =
    "2026-07-11";
});

graph("as-of: dated state with no generated_at and no dated node", (subject) => {
  delete subject["generated_at"];
  delete nodeOf(subject, "artifact:demo-retry-script")["observed_at"];
  delete nodeOf(subject, "encounter:demo-mdn-idempotency-read")["date"];
  delete nodeOf(subject, "question:demo-when-is-retry-safe")["created_at"];
  delete nodeOf(
    subject,
    "trail-segment:2026-07-10-retry-with-idempotency",
  )["date"];
});

// -- the step-9 fold (§20 step 9, §14.6) ------------------------------------

graph("state: a key that is not an emitted node id", (subject) => {
  stateOf(subject)["concept:not-emitted"] = {
    ...(stateOf(subject)["concept:redis"] as Dict),
  };
});

graph("state: a key outside the step-9 slice", (subject) => {
  stateOf(subject)["artifact:demo-retry-script"] = {
    ...(stateOf(subject)["concept:redis"] as Dict),
  };
});

graph("state: an entry without its kind's fold shape", (subject) => {
  delete (stateOf(subject)["concept:redis"] as Dict)["exposure"];
});

graph("state: a gated value moved with no decision", (subject) => {
  (stateOf(subject)["concept:redis"] as Dict)["confidence"] = "high";
});

// Two holes, and the node carrying the second one moved to the front: the
// totality diagnostics come out sorted by id, not in the order the nodes
// arrived, and a single hole cannot tell those apart.
graph("state: two holes reported in sorted order", (subject) => {
  delete stateOf(subject)["concept:redis"];
  delete stateOf(subject)["question:demo-when-is-retry-safe"];
  const nodes = nodesOf(subject);
  const question = nodeOf(subject, "question:demo-when-is-retry-safe");
  nodes.splice(nodes.indexOf(question), 1);
  nodes.unshift(question);
});

graph("state: a concept with no entry", (subject) => {
  delete stateOf(subject)["concept:redis"];
});

graph("state: a question with no entry", (subject) => {
  delete stateOf(subject)["question:demo-when-is-retry-safe"];
});

// -- edge references (§10, §10.3) ------------------------------------------

graph("edges: a dangling target", (subject) => {
  edgeOf(
    subject,
    "explains",
    "part:mdn-http-methods/idempotency",
    "concept:idempotency",
  )["target"] = "concept:not-emitted";
});

graph("edges: a dangling source", (subject) => {
  edgeOf(
    subject,
    "explains",
    "part:mdn-http-methods/idempotency",
    "concept:idempotency",
  )["source"] = "part:not-emitted/anything";
});

graph("edges: both endpoints on one node", (subject) => {
  edgeOf(subject, "related_to", "concept:http-methods", "concept:rest-api")[
    "target"
  ] = "concept:http-methods";
});

graph("edges: a provenance ref that is not a node", (subject) => {
  edgeOf(
    subject,
    "explains",
    "part:mdn-http-methods/idempotency",
    "concept:idempotency",
  )["provenance"] = ["part:mdn-http-methods/idempotency", "encounter:not-emitted"];
});

graph("edges: a context that is not a node", (subject) => {
  edgeOf(subject, "suggested_next", "concept:rest-api", "concept:idempotency")[
    "context"
  ] = "suggested-route:not-emitted";
});

graph("edges: a step that is not a node", (subject) => {
  edgeOf(
    subject,
    "primary_for",
    "part:mdn-http-methods/idempotency",
    "trail-segment:2026-07-10-retry-with-idempotency",
  )["step"] = "concept:not-emitted";
});

graph("edges: alternative_in out of order", (subject) => {
  edgeOf(subject, "related_to", "concept:http-methods", "concept:rest-api")[
    "alternative_in"
  ] = ["concept:rest-api", "concept:idempotency"];
});

graph("edges: alternative_in with a repeat", (subject) => {
  edgeOf(subject, "related_to", "concept:http-methods", "concept:rest-api")[
    "alternative_in"
  ] = ["concept:idempotency", "concept:idempotency"];
});

graph("edges: an alternative_in ref that is not a node", (subject) => {
  edgeOf(subject, "related_to", "concept:http-methods", "concept:rest-api")[
    "alternative_in"
  ] = ["concept:not-emitted"];
});

graph("edges: provenance without the authoring source", (subject) => {
  edgeOf(
    subject,
    "has_part",
    "material:fastapi-tutorial",
    "part:fastapi-tutorial/path-operations",
  )["provenance"] = ["material:mdn-http-methods"];
});

graph("edges: provenance without the owning target", (subject) => {
  edgeOf(
    subject,
    "probed_by",
    "concept:idempotency",
    "probe:duplicate-post-idempotency",
  )["provenance"] = ["concept:idempotency"];
});

graph("edges: suggested_next provenance without the deriving route", (subject) => {
  edgeOf(subject, "suggested_next", "concept:rest-api", "concept:idempotency")[
    "provenance"
  ] = ["concept:idempotency"];
});

graph("edges: symmetric provenance naming neither endpoint", (subject) => {
  edgeOf(subject, "related_to", "concept:http-methods", "concept:rest-api")[
    "provenance"
  ] = ["concept:redis"];
});

// -- route structure (§9.4, §10.2) -----------------------------------------

graph("route: two steps at one order", (subject) => {
  edgeOf(
    subject,
    "step_of_route",
    "concept:redis",
    "suggested-route:demo-backend-default",
  )["order"] = 2;
});

graph("route: a gap in the orders", (subject) => {
  edgeOf(
    subject,
    "step_of_route",
    "concept:redis",
    "suggested-route:demo-backend-default",
  )["order"] = 4;
});

graph("route: consecutive steps with no suggested_next", (subject) => {
  dropEdge(subject, "suggested_next", "concept:rest-api", "concept:idempotency");
});

// -- canonical form (§20.3) -------------------------------------------------

graph("canonical: two edges out of order", (subject) => {
  const edges = edgesOf(subject);
  const first = edges[0] as Dict;
  edges[0] = edges[1] as Dict;
  edges[1] = first;
});

// Two edges alike in type, source, target and context, separated only by
// their order: the one shape in which the numeric element of the identity key
// decides the sort. Spelled 10 before 2 because that pair is in order as text
// and out of order as numbers — the whole point of comparing it as a number.
graph("canonical: two step orders that sort differently as text", (subject) => {
  const step = edgeOf(
    subject,
    "step_of_route",
    "concept:redis",
    "suggested-route:demo-backend-default",
  );
  const index = edgeIndexOf(
    subject,
    "step_of_route",
    "concept:redis",
    "suggested-route:demo-backend-default",
  );
  edgesOf(subject).splice(index, 0, { ...step, order: 10 });
});

graph("canonical: a meta discriminant on the wrong type", (subject) => {
  edgeOf(
    subject,
    "demonstrates",
    "part:fastapi-tutorial/path-operations",
    "concept:http-methods",
  )["order"] = 1;
});

graph("canonical: symmetric endpoints not sorted", (subject) => {
  const edge = edgeOf(
    subject,
    "related_to",
    "concept:http-methods",
    "concept:rest-api",
  );
  edge["source"] = "concept:rest-api";
  edge["target"] = "concept:http-methods";
});

// The other symmetric type. Two members of one set are two chances to drop
// one, and the sorted-endpoint rule reads the set rather than the type.
graph("canonical: the second symmetric type unsorted", (subject) => {
  addEdge(subject, {
    source: "concept:rest-api",
    target: "concept:http-methods",
    type: "alternative_to",
    provenance: ["concept:rest-api"],
  });
});

// Two edges alike in type, source and target, separated only by the context
// they hang off. The demo field has one route, so the second context has to be
// a node of another kind and the rest of the complaints are the honest price
// of that — the sentence this case is about is named so the price cannot be
// mistaken for the goods.
graph(
  "canonical: two edges separated only by their context",
  (subject) => {
    const index = edgeIndexOf(
      subject,
      "suggested_next",
      "concept:idempotency",
      "concept:redis",
    );
    const edge = edgesOf(subject)[index] as Dict;
    edgesOf(subject).splice(index, 0, {
      ...edge,
      context: "trail-segment:2026-07-10-retry-with-idempotency",
    });
  },
  "fires",
  ["are not in canonical identity order"],
);

// Two route roles alike in everything the identity key holds but the step:
// the last element of that key, and the only shape in which it decides.
graph(
  "canonical: two route roles separated only by their step",
  (subject) => {
    for (const step of ["concept:idempotency", "concept:redis"]) {
      addEdge(subject, {
        source: "part:mdn-http-methods/idempotency",
        target: "suggested-route:demo-backend-default",
        type: "primary_for",
        provenance: ["suggested-route:demo-backend-default"],
        step,
      });
    }
    swapEdges(
      subject,
      (edge) => edge["type"] === "primary_for" && edge["step"] === "concept:idempotency",
      (edge) => edge["type"] === "primary_for" && edge["step"] === "concept:redis",
    );
  },
  "fires",
  ["are not in canonical identity order"],
);

graph("canonical: the same identity twice", (subject) => {
  addEdge(subject, {
    ...edgeOf(subject, "related_to", "concept:http-methods", "concept:rest-api"),
  });
});

// The reversed spelling of a symmetric edge: sorted-endpoint and duplicate
// identity are one statement, and only the reversed copy shows they are.
graph("canonical: a symmetric edge and its mirror", (subject) => {
  const edge = edgeOf(
    subject,
    "related_to",
    "concept:http-methods",
    "concept:rest-api",
  );
  addEdge(subject, {
    ...edge,
    source: "concept:rest-api",
    target: "concept:http-methods",
  });
});

graph("canonical: a role step that is not a step of the route", (subject) => {
  addEdge(subject, {
    source: "part:mdn-http-methods/idempotency",
    target: "suggested-route:demo-backend-default",
    type: "primary_for",
    provenance: ["suggested-route:demo-backend-default"],
    step: "concept:http-methods",
  });
});

// The same material, primary at one step and supporting at another: the two
// roles are disjoint per (route, step, material), and a check that forgot the
// step would read this as a contradiction.
graph(
  "canonical: one material at two steps in two roles",
  (subject) => {
    addEdge(subject, {
      source: "part:mdn-http-methods/idempotency",
      target: "suggested-route:demo-backend-default",
      type: "primary_for",
      provenance: ["suggested-route:demo-backend-default"],
      step: "concept:rest-api",
    });
    addEdge(subject, {
      source: "part:mdn-http-methods/idempotency",
      target: "suggested-route:demo-backend-default",
      type: "supporting_for",
      provenance: ["suggested-route:demo-backend-default"],
      step: "concept:idempotency",
    });
  },
  "clean",
);

// A question role legally has no step (§11.2), so the disjointness sentence
// has to name an absence — which the two implementations spell differently.
// Recorded as #133.
graph("canonical: one material in both roles at no step", (subject) => {
  addEdge(subject, {
    ...edgeOf(
      subject,
      "primary_for",
      "part:mdn-http-methods/idempotency",
      "question:demo-when-is-retry-safe",
    ),
    type: "supporting_for",
  });
});

// CPython holds a boolean to be an integer, so the oracle folds this order into
// 1 and goes on to judge the route; the port finds a boolean where a number
// belongs and stops. Both refuse the graph. Recorded as #131.
graph("canonical: a step order spelled as a boolean", (subject) => {
  edgeOf(
    subject,
    "step_of_route",
    "concept:redis",
    "suggested-route:demo-backend-default",
  )["order"] = true;
});

graph("canonical: one material both primary and supporting", (subject) => {
  for (const type of ["primary_for", "supporting_for"]) {
    addEdge(subject, {
      source: "part:mdn-http-methods/idempotency",
      target: "suggested-route:demo-backend-default",
      type,
      provenance: ["suggested-route:demo-backend-default"],
      step: "concept:rest-api",
    });
  }
});

// -- payload backing, forward (§10.2, §10.4, §9.9) -------------------------

graph("payload: an encounter target with no visited edge", (subject) => {
  dropEdge(
    subject,
    "visited",
    "encounter:demo-mdn-idempotency-read",
    "part:mdn-http-methods/idempotency",
  );
});

graph("payload: a part with no has_part edge", (subject) => {
  dropEdge(
    subject,
    "has_part",
    "material:fastapi-tutorial",
    "part:fastapi-tutorial/path-operations",
  );
});

graph("payload: a segment movement with no moved_to edge", (subject) => {
  dropEdge(subject, "moved_to", "concept:rest-api", "concept:idempotency");
});

graph("payload: a segment via item with no via edge", (subject) => {
  dropEdge(
    subject,
    "via",
    "trail-segment:2026-07-10-retry-with-idempotency",
    "part:mdn-http-methods/idempotency",
  );
});

graph("payload: a segment artifact with no produced_artifact edge", (subject) => {
  dropEdge(
    subject,
    "produced_artifact",
    "trail-segment:2026-07-10-retry-with-idempotency",
    "artifact:demo-retry-script",
  );
});

// -- payload backing, reverse ----------------------------------------------

graph("payload: a visited edge no encounter records", (subject) => {
  edgeOf(
    subject,
    "visited",
    "encounter:demo-mdn-idempotency-read",
    "part:mdn-http-methods/idempotency",
  )["target"] = "part:fastapi-tutorial/path-operations";
});

// Backed in one direction only: a pair set that ignored direction would call
// this edge recorded, and would call the encounter's own target visited.
graph("payload: a visited edge pointing the wrong way", (subject) => {
  const edge = edgeOf(
    subject,
    "visited",
    "encounter:demo-mdn-idempotency-read",
    "part:mdn-http-methods/idempotency",
  );
  edge["source"] = "part:mdn-http-methods/idempotency";
  edge["target"] = "encounter:demo-mdn-idempotency-read";
});

graph("payload: a has_part edge no part records", (subject) => {
  edgeOf(
    subject,
    "has_part",
    "material:fastapi-tutorial",
    "part:fastapi-tutorial/path-operations",
  )["target"] = "part:mdn-http-methods/idempotency";
});

graph("payload: a moved_to edge no segment records", (subject) => {
  edgeOf(subject, "moved_to", "concept:rest-api", "concept:idempotency")[
    "source"
  ] = "concept:http-methods";
});

graph("payload: a via edge no segment records", (subject) => {
  edgeOf(
    subject,
    "via",
    "trail-segment:2026-07-10-retry-with-idempotency",
    "part:mdn-http-methods/idempotency",
  )["target"] = "part:fastapi-tutorial/path-operations";
});

graph("payload: a produced_artifact edge no segment records", (subject) => {
  const segment = nodeOf(
    subject,
    "trail-segment:2026-07-10-retry-with-idempotency",
  );
  segment["via"] = (segment["via"] as string[]).filter(
    (ref) => !ref.startsWith("artifact:"),
  );
});

graph("payload: moved_to provenance naming no recording segment", (subject) => {
  edgeOf(subject, "moved_to", "concept:rest-api", "concept:idempotency")[
    "provenance"
  ] = ["encounter:demo-mdn-idempotency-read"];
});

// -- §34.4 at the boundary --------------------------------------------------

graph("formerly: a retired id of another kind", (subject) => {
  nodeOf(subject, "concept:rest-api")["formerly"] = ["material:restful-api"];
});

graph("formerly: a retired id that still lives", (subject) => {
  nodeOf(subject, "concept:rest-api")["formerly"] = ["concept:redis"];
});

graph("formerly: one retired id with two survivors", (subject) => {
  nodeOf(subject, "concept:redis")["formerly"] = ["concept:restful-api"];
});

// Three claimants, not two: with two, remembering the first survivor and
// remembering the last are the same map.
graph("formerly: one retired id with three survivors", (subject) => {
  nodeOf(subject, "concept:redis")["formerly"] = ["concept:restful-api"];
  nodeOf(subject, "concept:http-methods")["formerly"] = ["concept:restful-api"];
});

// -- the §11 role folds -----------------------------------------------------

graph("roles: a route role whose provenance omits the route", (subject) => {
  addEdge(subject, {
    source: "part:mdn-http-methods/idempotency",
    target: "suggested-route:demo-backend-default",
    type: "primary_for",
    provenance: ["material:mdn-http-methods"],
    step: "concept:rest-api",
  });
});

graph("roles: a question role no encounter cites", (subject) => {
  addEdge(subject, {
    source: "part:fastapi-tutorial/path-operations",
    target: "question:demo-when-is-retry-safe",
    type: "primary_for",
    provenance: ["encounter:demo-mdn-idempotency-read"],
  });
});

// §11.2 folds on the citing encounters' depth, so the rung below `applied` is
// the case that separates the two arms — the base sits on `applied` and would
// never exercise the supporting one.
graph("roles: a question role the citing depth folds the other way", (subject) => {
  nodeOf(subject, "encounter:demo-mdn-idempotency-read")["depth"] = "read";
});

// The other depth that folds to primary. The base carries `applied`, so a
// reading that admitted only that one would be indistinguishable from this
// one everywhere except here (§11.2).
graph(
  "roles: a question role cited at the deepest depth",
  (subject) => {
    nodeOf(subject, "encounter:demo-mdn-idempotency-read")["depth"] = "taught";
  },
  "clean",
);

graph("roles: a question role naming no deriving encounter", (subject) => {
  edgeOf(
    subject,
    "primary_for",
    "part:mdn-http-methods/idempotency",
    "question:demo-when-is-retry-safe",
  )["provenance"] = ["question:demo-when-is-retry-safe"];
});

graph("roles: a segment primary_for the via does not back", (subject) => {
  edgeOf(
    subject,
    "primary_for",
    "part:mdn-http-methods/idempotency",
    "trail-segment:2026-07-10-retry-with-idempotency",
  )["source"] = "part:fastapi-tutorial/path-operations";
});

graph("roles: a segment primary_for whose provenance omits the segment", (subject) => {
  edgeOf(
    subject,
    "primary_for",
    "part:mdn-http-methods/idempotency",
    "trail-segment:2026-07-10-retry-with-idempotency",
  )["provenance"] = ["encounter:demo-mdn-idempotency-read"];
});

graph("roles: a segment supporting_for on a via material", (subject) => {
  edgeOf(
    subject,
    "primary_for",
    "part:mdn-http-methods/idempotency",
    "trail-segment:2026-07-10-retry-with-idempotency",
  )["type"] = "supporting_for";
});

graph("roles: a segment supporting_for no encounter backs", (subject) => {
  addEdge(subject, {
    source: "part:fastapi-tutorial/path-operations",
    target: "trail-segment:2026-07-10-retry-with-idempotency",
    type: "supporting_for",
    provenance: ["trail-segment:2026-07-10-retry-with-idempotency"],
  });
});

graph(
  "roles: a segment supporting_for an encounter does back",
  (subject) => {
    withSecondEncounter(subject);
    addEdge(subject, {
      source: "part:fastapi-tutorial/path-operations",
      target: "trail-segment:2026-07-10-retry-with-idempotency",
      type: "supporting_for",
      provenance: [
        "trail-segment:2026-07-10-retry-with-idempotency",
        "encounter:demo-fastapi-read",
      ],
    });
  },
  "clean",
);

graph("roles: a backed supporting_for whose provenance omits the encounter", (subject) => {
  withSecondEncounter(subject);
  addEdge(subject, {
    source: "part:fastapi-tutorial/path-operations",
    target: "trail-segment:2026-07-10-retry-with-idempotency",
    type: "supporting_for",
    provenance: ["trail-segment:2026-07-10-retry-with-idempotency"],
  });
});

// -- projections (§20 step 12, §32.1) --------------------------------------

graph("projections: a key that is not a zone id", (subject) => {
  subject["projections"] = { "concept:rest-api": "torso" };
});

// A key is any string, so one holding the quote character reaches the two
// spellings of the same sentence. Recorded as #133, and only visible since the
// harness's quote fold started declining messages it cannot fold honestly.
graph("projections: a key holding the quote character", (subject) => {
  subject["projections"] = { 'zone:"bad': "torso" };
});

/** The demo graph carries no zone, so the §32.1 arm needs one made. */
function asZone(subject: Dict): void {
  const pattern = nodeOf(subject, "pattern:push-up");
  pattern["id"] = "zone:shoulder";
  pattern["type"] = "zone";
  pattern["notes"] = "Demo fixture zone, placed to exercise the projection rule.";
}

graph("projections: a zone with no entry", (subject) => {
  asZone(subject);
});

// Two zones, introduced in the order that is not their sorted order: the
// diagnostics come out sorted, and one zone could never show it.
graph("projections: two zones with no entry", (subject) => {
  asZone(subject);
  nodesOf(subject).push({
    id: "zone:ankle",
    type: "zone",
    title: "Ankle",
    notes: "Demo fixture zone, placed second and sorting first.",
    fields: ["body"],
  });
});

graph(
  "projections: a zone with its entry",
  (subject) => {
    asZone(subject);
    subject["projections"] = { "zone:shoulder": "shoulder" };
  },
  "clean",
);

// -- the redacted variant (§32.6) ------------------------------------------

// The withheld artifact carries the only classed-by-derivation state in the
// base: `concept:idempotency` rests on it, so the redaction drops that value
// whole and the fold-totality rule must accept the hole it leaves.
const WITHHELD = ["artifact:demo-retry-script"] as const;

pair("redacted: the honest redaction of the base", WITHHELD, () => {}, "clean");

pair("redacted: a state value that should have been dropped", WITHHELD, (full, out) => {
  (out["state"] as Dict)["concept:idempotency"] = (full["state"] as Dict)[
    "concept:idempotency"
  ];
});

pair("redacted: a withheld state count that does not add up", WITHHELD, (_full, out) => {
  (out["withheld"] as Dict)["state"] = 0;
});

// A count spelled with a fraction part. `2.0` is a float on both sides now, so
// the schema's integer test refuses the document before any rule looks at the
// count — which is why this expects `quiet` rather than a rule firing. It used
// to be recorded as #132, back when the reader folded `2.0` to `2` and the two
// sides disagreed about which complaint to make.
{
  const full = clone();
  const out = redact(full, WITHHELD);
  const outText = JSON.stringify(out, null, 1);
  const floated = outText.replace('"state": 1', '"state": 2.0');
  if (floated === outText) throw new Error("the withheld state count moved");
  add(
    "redacted: a withheld state count spelled as a float",
    {
      "atlas-graph.json": full,
      "atlas-graph.redacted.json": floated,
    },
    "quiet",
  );
}

// A count that is a boolean. CPython holds `True` to be an `int` and excludes
// it by hand; here it is simply not a number, and both sides say nothing.
pair(
  "redacted: a withheld state count spelled as a boolean",
  WITHHELD,
  (_full, out) => {
    (out["withheld"] as Dict)["state"] = true;
  },
  "quiet",
);

pair("redacted: no withheld block at all", WITHHELD, (_full, out) => {
  delete out["withheld"];
});

pair("redacted: a node still carrying sensitivity", WITHHELD, (_full, out) => {
  (nodesOf(out)[0] as Dict)["sensitivity"] = "medical";
});

pair("redacted: an edge still carrying sensitivity", WITHHELD, (_full, out) => {
  (edgesOf(out)[0] as Dict)["sensitivity"] = "medical";
});

// A classed state value in the full graph is licensed to be missing from the
// redaction; keeping it is both a surviving class and a redaction mismatch.
pair(
  "redacted: a classed state value dropped",
  WITHHELD,
  (full, out) => {
    (full["state"] as Dict)["concept:redis"] = {
      ...((full["state"] as Dict)["concept:redis"] as Dict),
      sensitivity: "medical",
    };
    delete (out["state"] as Dict)["concept:redis"];
    (out["withheld"] as Dict)["state"] = 2;
  },
  "clean",
);

pair("redacted: a classed state value kept", WITHHELD, (full, out) => {
  const classed = {
    ...((full["state"] as Dict)["concept:redis"] as Dict),
    sensitivity: "medical",
  };
  (full["state"] as Dict)["concept:redis"] = classed;
  (out["state"] as Dict)["concept:redis"] = classed;
});

graph("full: a withheld block on the full graph", (subject) => {
  subject["withheld"] = {
    nodes: 0,
    edges: 0,
    trails: 0,
    state: 0,
    influence: 0,
    frontier: 0,
    projections: 0,
  };
});

// -- the snapshot arm of the same loop (§33.4) -----------------------------

// The snapshot rules have their own corpus next door; these are here to prove
// this loop dispatches to them at all, on the file name rather than on the
// shape. The §33.4 surface is wide and none of it is what is being proved, so
// these carry the fields the two rules read and let the schema say the rest.
function snapshot(name: string, body: Dict, expect: Expect = "fires"): void {
  add(
    `snapshot: ${name}`,
    {
      "atlas-snapshot.json": {
        format: "atlas-snapshot",
        version: 1,
        generated_at: "2026-07-10T00:00:00Z",
        evidence_refs: {
          "encounter:demo-mdn-idempotency-read": {
            kind: "encounter",
            date: "2026-07-09",
          },
        },
        materials: {},
        ...body,
      },
    },
    expect,
  );
}

snapshot(
  "evidence the table resolves",
  {
    state: {
      "concept:idempotency": {
        exposure: "applied",
        evidence: ["encounter:demo-mdn-idempotency-read"],
      },
    },
  },
  "quiet",
);

snapshot("evidence absent from the table", {
  state: {
    "concept:idempotency": {
      exposure: "applied",
      evidence: ["encounter:not-emitted"],
    },
  },
});

snapshot("a materials key that is not a material id", {
  materials: { "concept:idempotency": { depth_reached: "applied" } },
  state: {},
});

snapshot("a state entry carrying another kind's dimension", {
  state: {
    "concept:idempotency": { exposure: "applied", strength: "steady" },
  },
});

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

// One instance per case, so the oracle can walk the whole corpus in a single
// process and every diagnostic still carries the path it was found at.
const workspace = fs.mkdtempSync("/tmp/atlas-graph-rules-");
const roots = cases.map((item, index) => {
  const root = `${workspace}/case-${String(index).padStart(3, "0")}`;
  fs.mkdirSync(`${root}/graph`, { recursive: true });
  for (const [filename, text] of Object.entries(item.files)) {
    fs.writeFileSync(`${root}/graph/${filename}`, `${text}\n`);
  }
  return root;
});

const registry = loadRegistry(ROOT);
if (registry.errors.length > 0) {
  console.error("graph-rules: the schema registry did not load");
  for (const message of registry.errors) console.error(`  ${message}`);
  process.exit(1);
}

/** The oracle's emitted-file loop, ported alongside the rules it dispatches. */
function mine(root: string): string[] {
  const reader = new AtlasReader(root);
  const errors: string[] = [];
  let fullGraph: Dict | null = null;
  for (const [filename, schemaName] of EMITTED) {
    const file = reader.optionalFile(`graph/${filename}`);
    if (file === null) continue;
    const instance = readJsonFile(file);
    const schema = registry.schemas.get(schemaName) as Record<string, unknown>;
    errors.push(...schemaErrors(instance, schema, file));
    const dict =
      typeof instance === "object" && instance !== null && !Array.isArray(instance)
        ? (instance as Dict)
        : null;
    if (filename === "atlas-graph.json" && dict !== null) fullGraph = dict;
    if (schemaName === "atlas-snapshot" && dict !== null) {
      errors.push(...snapshotDanglingRefs(dict, file));
      errors.push(...snapshotStateKindErrors(dict, file));
    }
    if (schemaName === "atlas-graph" && dict !== null) {
      errors.push(...emittedGraphErrors(dict, file, filename, fullGraph));
    }
  }
  return errors;
}

const payload = JSON.stringify(roots.map((root) => ({ root })));
// The roots are this run's temporary directories, so they are folded out
// of both the question and the answer before either is written down, and
// folded back in for the comparison below.
const theirs = JSON.parse(
  unfoldRoots(
    oracleAnswer("graph-rules", foldRoots(payload, roots)) as string,
    roots,
  ),
) as Array<{
  ok?: string[];
  warnings?: string[];
  raised?: string;
}>;

/**
 * A schema complaint, told apart from a rule's by where it is placed.
 *
 * The schema validator anchors every message at a JSON pointer — `$`, then the
 * path into the document. No rule in this pass does; they name ids, array
 * positions and § tags. The two never collide because a file path holds no
 * ": " to confuse the split.
 */
function isSchemaMessage(message: string): boolean {
  const separator = message.indexOf(": ");
  return separator >= 0 && message.startsWith("$", separator + 2);
}

/** Divergences with an issue behind them, counted apart rather than hidden. */
const KNOWN: ReadonlyMap<string, string> = new Map([
  // A value inside a diagnostic is spelled as JSON here and as CPython `repr`
  // there: `null` for `None`, and double quotes where a value already holds
  // one. §24.4 makes the source a contract and the prose after it not one.
  ["canonical: one material in both roles at no step", "#133"],
  ["projections: a key holding the quote character", "#133"],
  // CPython holds a boolean to be an integer, so the oracle keeps judging a
  // route this port has already refused. Recorded as #131.
  ["canonical: a step order spelled as a boolean", "#131"],
]);

let diverged = 0;
let recorded = 0;
let vacuous = 0;
// A recorded divergence that quietly stopped diverging is a stale note
// about the port, and the next reader would believe it.
const stillDiverging = new Set<string>();

cases.forEach((item, index) => {
  const root = roots[index] as string;
  const oracle = theirs[index] as { ok?: string[]; warnings?: string[]; raised?: string };
  let ours: string[];
  try {
    ours = mine(root);
  } catch (error) {
    console.error(
      `graph-rules: ${item.name}: raised ${(error as Error).constructor.name} — ` +
        `oracle ${oracle?.raised ?? "returned"}`,
    );
    diverged += 1;
    return;
  }
  if (oracle?.raised !== undefined) {
    console.error(`graph-rules: ${item.name}: the oracle raised ${oracle.raised}`);
    diverged += 1;
    return;
  }
  // Nothing in this pass warns, so a warning means the harness has drifted
  // into another of validate_instance's passes and the comparison is no
  // longer about the emitted graph.
  if ((oracle?.warnings ?? []).length > 0) {
    console.error(`graph-rules: ${item.name}: the oracle warned, which this pass never does`);
    for (const message of oracle.warnings ?? []) console.error(`  ${message}`);
    diverged += 1;
    return;
  }
  const mineText = JSON.stringify(ours.map(foldQuotes));
  const theirsText = JSON.stringify((oracle?.ok ?? []).map(foldQuotes));
  if (mineText !== theirsText) {
    if (KNOWN.has(item.name)) {
      recorded += 1;
      stillDiverging.add(item.name);
      return;
    }
    diverged += 1;
    console.error(`graph-rules: ${item.name}`);
    console.error(`  mine:   ${mineText.replaceAll(workspace, "…")}`);
    console.error(`  oracle: ${theirsText.replaceAll(workspace, "…")}`);
    return;
  }
  // Agreement about a rule neither side reached is not evidence about the
  // rule. Checked against the oracle's list, since that is the authority here.
  const said = oracle?.ok ?? [];
  const rules = said.filter((message) => !isSchemaMessage(message));
  const wrong =
    item.expect === "clean"
      ? said.length > 0
      : item.expect === "quiet"
        ? rules.length > 0 || said.length === 0
        : rules.length === 0;
  const unsaid = item.says.filter(
    (phrase) => !said.some((message) => message.includes(phrase)),
  );
  if (wrong || unsaid.length > 0) {
    vacuous += 1;
    console.error(
      unsaid.length > 0
        ? `graph-rules: ${item.name}: the oracle never said ${unsaid.join(", ")}`
        : `graph-rules: ${item.name}: expected ${item.expect}, got ` +
            `${rules.length} rule and ${said.length - rules.length} schema ` +
            "diagnostic(s)",
    );
    for (const message of said) console.error(`  ${message.replaceAll(workspace, "…")}`);
  }
});

const stale = [...KNOWN.keys()].filter((name) => !stillDiverging.has(name));
for (const name of stale) {
  console.error(
    `graph-rules: ${name}: recorded as a divergence and no longer one`,
  );
}

fs.rmSync(workspace, { recursive: true, force: true });

const zone = process.env["TZ"] ?? "<unset>";
console.log(
  `graph-rules [TZ=${zone}]: ${cases.length} cases compared, ` +
    `${diverged} unexplained, ${recorded} recorded, ${vacuous} vacuous`,
);
process.exit(diverged === 0 && vacuous === 0 && stale.length === 0 ? 0 : 1);
