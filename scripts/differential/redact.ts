// Differential harness: the §32.6 redaction against the oracle.
//
// This one compares whole documents rather than diagnostics, so there is no
// prose to fold and no room to be generous: the redacted graph is a persisted
// interchange format (§25.7), and what it must be is byte-identical.
//
// What the corpus is built around is the fixpoint. A single classed node is
// the easy case and proves almost nothing; the cases that matter are the ones
// where withholding a node drops an edge, dropping the edge strands a derived
// field on a node that survived, and that node has to leave too — one round
// of taint would keep it and disclose exactly the thing the class was for.

import { redactGraph } from "../src/redact.ts";
import { oracleAnswer } from "./oracle.ts";

const DIFFERENTIAL = import.meta.dir;

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

type Dict = Record<string, unknown>;

const node = (id: string, over: Dict = {}): Dict => ({
  id,
  type: id.split(":")[0],
  title: id,
  fields: ["knowledge"],
  aliases: [],
  ...over,
});

const edge = (source: string, target: string, over: Dict = {}): Dict => ({
  source,
  target,
  type: "related_to",
  provenance: [source],
  weight: "low",
  ...over,
});

const graph = (over: Dict): Dict => ({
  format: "atlas-graph",
  version: 1,
  nodes: [],
  edges: [],
  trails: [],
  state: {},
  influence: {},
  frontier: [],
  projections: {},
  ...over,
});

interface Case {
  readonly name: string;
  readonly graph: Dict;
  /** Ids the redaction must drop, and ids it must keep. */
  readonly drops: readonly string[];
  readonly keeps: readonly string[];
}

const cases: Case[] = [];

function add(
  name: string,
  value: Dict,
  expect: { drops?: readonly string[]; keeps?: readonly string[] },
): void {
  if ((expect.drops?.length ?? 0) + (expect.keeps?.length ?? 0) === 0) {
    throw new Error(`${name}: a case must say what survives it`);
  }
  cases.push({
    name,
    graph: value,
    drops: expect.drops ?? [],
    keeps: expect.keeps ?? [],
  });
}

add(
  "a graph with nothing classed in it",
  graph({
    nodes: [node("concept:a"), node("concept:b")],
    edges: [edge("concept:a", "concept:b")],
    state: { "concept:a": { exposure: "read", evidence: [], decisions: [] } },
  }),
  { keeps: ["concept:a", "concept:b"] },
);

add(
  "one classed node, and the edge that rested on it",
  graph({
    nodes: [node("concept:a", { sensitivity: "medical" }), node("concept:b")],
    edges: [edge("concept:a", "concept:b")],
  }),
  { drops: ["concept:a"], keeps: ["concept:b"] },
);

add(
  "a classed node named in another node's free text",
  // Containment, not a reference field: a deliberate mention taints.
  graph({
    nodes: [
      node("concept:a", { sensitivity: "medical" }),
      node("concept:b", { note: "follows on from concept:a" }),
      node("concept:c"),
    ],
  }),
  { drops: ["concept:a", "concept:b"], keeps: ["concept:c"] },
);

add(
  "a classed id buried in a nested payload rather than at the top",
  graph({
    nodes: [
      node("concept:a", { sensitivity: "medical" }),
      node("concept:b", { source: { via: ["concept:a"] } }),
    ],
  }),
  { drops: ["concept:a", "concept:b"], keeps: [] },
);

add(
  "an edge carrying a classed id in its context rather than an endpoint",
  graph({
    nodes: [
      node("concept:a"),
      node("concept:b"),
      node("suggested-route:r", { sensitivity: "medical" }),
    ],
    edges: [edge("concept:a", "concept:b", { context: "suggested-route:r" })],
  }),
  { drops: ["suggested-route:r"], keeps: ["concept:a", "concept:b"] },
);

add(
  "an edge classed on its own, with both endpoints in the clear",
  graph({
    nodes: [node("concept:a"), node("concept:b")],
    edges: [edge("concept:a", "concept:b", { sensitivity: "medical" })],
  }),
  { keeps: ["concept:a", "concept:b"] },
);

add(
  "a classed id in an edge's note rather than in any of its id fields",
  graph({
    nodes: [node("concept:a"), node("concept:b"), node("concept:x", { sensitivity: "medical" })],
    edges: [edge("concept:a", "concept:b", { note: "unlike concept:x" })],
  }),
  { drops: ["concept:x"], keeps: ["concept:a", "concept:b"] },
);

add(
  "a classed id in an edge's provenance rather than its endpoints",
  graph({
    nodes: [node("concept:a"), node("concept:b"), node("concept:p", { sensitivity: "medical" })],
    edges: [edge("concept:a", "concept:b", { provenance: ["concept:p"] })],
  }),
  { drops: ["concept:p"], keeps: ["concept:a", "concept:b"] },
);

add(
  "state citing a classed id it does not belong to",
  graph({
    nodes: [node("concept:a"), node("artifact:x", { sensitivity: "medical" })],
    state: {
      "concept:a": { exposure: "read", evidence: ["artifact:x"], decisions: [] },
    },
  }),
  { drops: ["artifact:x"], keeps: ["concept:a"] },
);

add(
  "state citing a classed id only inside one of its decisions",
  graph({
    nodes: [node("concept:a"), node("artifact:x", { sensitivity: "medical" })],
    state: {
      "concept:a": {
        exposure: "read",
        evidence: [],
        decisions: [{ dimension: "confidence", date: "2026-07-16", evidence: ["artifact:x"] }],
      },
    },
  }),
  { drops: ["artifact:x"], keeps: ["concept:a"] },
);

add(
  "state citing an id that merely begins with a classed one",
  // The refs here are closed id arrays, so the test is exact — unlike free
  // text, `artifact:x` must not take `artifact:x-long` with it.
  graph({
    nodes: [
      node("concept:a"),
      node("artifact:x", { sensitivity: "medical" }),
      // Its title says nothing about the classed id, and its fields are what
      // an edgeless artifact derives: `id` is the one field exempt from the
      // free-text scan, and a stale field list would have withheld this node
      // under §10.4 before exactness ever came up.
      node("artifact:x-long", { title: "a longer id", fields: [] }),
    ],
    state: {
      "concept:a": {
        exposure: "read",
        evidence: ["artifact:x-long"],
        decisions: [],
      },
    },
  }),
  { drops: ["artifact:x"], keeps: ["concept:a", "artifact:x-long"] },
);

add(
  "a folded value classed on its own, for a node in the clear",
  graph({
    nodes: [node("concept:a")],
    state: {
      "concept:a": {
        exposure: "read",
        evidence: [],
        decisions: [],
        sensitivity: "medical",
      },
    },
  }),
  { keeps: ["concept:a"] },
);

add(
  "a chain of mentions the scan meets in the wrong order",
  // The inner scan is a fixpoint too, not a pass. `concept:c` mentions
  // `concept:b`, which mentions the classed `concept:a` — and `c` is listed
  // before `b` on purpose, so a single sweep sees `c` while `b` is still in
  // the clear and keeps it. Only a second round reaches it.
  graph({
    nodes: [
      node("concept:a", { sensitivity: "medical" }),
      node("concept:c", { note: "after concept:b" }),
      node("concept:b", { note: "after concept:a" }),
      node("concept:d"),
    ],
  }),
  {
    drops: ["concept:a", "concept:b", "concept:c"],
    keeps: ["concept:d"],
  },
);

add(
  "a silhouette entry for a classed zone",
  graph({
    nodes: [node("zone:z", { type: "zone", fields: ["body"], sensitivity: "medical" })],
    projections: { "zone:z": "region:r" },
  }),
  { drops: ["zone:z"], keeps: [] },
);

add(
  "a node whose fields stop being derivable once an edge is dropped",
  // The fixpoint's reason for existing. `material:m` carries a field it only
  // has because of its edge to the classed concept; with that edge gone the
  // surviving graph no longer derives the field, so the node rests on
  // redacted data and leaves whole rather than being rewritten.
  graph({
    nodes: [
      node("concept:a", { sensitivity: "medical" }),
      node("material:m", { type: "material", fields: ["knowledge"] }),
    ],
    edges: [edge("material:m", "concept:a", { type: "supports" })],
  }),
  { drops: ["concept:a", "material:m"], keeps: [] },
);

add(
  "a second round of the fixpoint, reached only through the first",
  // `material:m` goes because its field stops being derivable; `concept:c`
  // goes because it names `material:m` in its own text, which nothing knew
  // was a withheld id until the round before.
  graph({
    nodes: [
      node("concept:a", { sensitivity: "medical" }),
      node("material:m", { type: "material", fields: ["knowledge"] }),
      node("concept:c", { note: "see material:m" }),
      node("concept:d"),
    ],
    edges: [edge("material:m", "concept:a", { type: "supports" })],
  }),
  {
    drops: ["concept:a", "material:m", "concept:c"],
    keeps: ["concept:d"],
  },
);

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

// The graphs are the whole question here — no path or clock reaches this
// pass — so the answer is recorded as it stands.
const question = JSON.stringify(cases.map((item) => item.graph));
const theirs = oracleAnswer("redact", question) as Array<{
  graph?: Dict;
  raised?: boolean;
}>;

let diverged = 0;
let vacuous = 0;

cases.forEach((item, index) => {
  const oracle = theirs[index] as (typeof theirs)[number];
  if (oracle?.raised === true) {
    diverged += 1;
    console.error(`redact: ${item.name}: the oracle refused the graph`);
    return;
  }
  const mine = redactGraph(structuredClone(item.graph));
  // A persisted format, so the whole document is compared and the key order
  // with it — `withheld` counts included.
  const mineText = JSON.stringify(mine);
  const theirsText = JSON.stringify(oracle?.graph);
  if (mineText !== theirsText) {
    diverged += 1;
    console.error(`redact: ${item.name}`);
    console.error(`  mine:   ${mineText}`);
    console.error(`  oracle: ${theirsText}`);
    return;
  }

  // And then what the case says it is about, read off the oracle's own answer
  // — two implementations that agree on a graph nobody redacted have agreed
  // about nothing.
  const survived = new Set(
    ((oracle?.graph?.["nodes"] ?? []) as Dict[]).map((n) => n["id"] as string),
  );
  const complaints: string[] = [];
  for (const id of item.drops) {
    if (survived.has(id)) complaints.push(`kept ${id}`);
  }
  for (const id of item.keeps) {
    if (!survived.has(id)) complaints.push(`dropped ${id}`);
  }
  if (complaints.length > 0) {
    vacuous += 1;
    console.error(`redact: ${item.name}: the oracle ${complaints.join("; ")}`);
  }
});

console.log(
  `redact: ${cases.length} graphs compared, ${diverged} unexplained, ` +
    `${vacuous} vacuous`,
);
process.exit(diverged === 0 && vacuous === 0 ? 0 : 1);
