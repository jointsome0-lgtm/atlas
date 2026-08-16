// Differential harness: the validator's §-rule joins against the CPython oracle.
//
// These are the checks a JSON Schema cannot express — that a gated value moved
// by a reviewed decision, that a ladder rung is reachable from the evidence
// cited for it, that a snapshot's provenance table resolves. Each is a small
// pure function over an emitted graph or snapshot, so the corpus is built the
// way the constants dump was: one base record per check, then a mutation per
// clause, so a rule that stopped firing has a case that used to fire and now
// does not.
//
// Every function is called with the *same* argument object on both sides,
// serialised as JSON. Nothing here touches the filesystem, so unlike the
// preflight harness there is no root to fold — only the messages, whose prose
// is compared and whose §-tags carry the identity of the rule.

import { oracleAnswer } from "./oracle.ts";

import {
  graphFieldErrors,
  newRejectedProposals,
  reproposalErrors,
  reviewGateErrors,
  snapshotDanglingRefs,
  snapshotStateKindErrors,
  stateCitesWithheldId,
  stateEntryHasDatedInput,
  stateProvenanceErrors,
  stateStatusEvidenceErrors,
  statusEvidenceErrors,
  userSelfProposalErrors,
} from "../src/core/checks.ts";
import { jsonLoads } from "../src/boundary/json-input.ts";
import { foldQuotes } from "./spelling.ts";

interface Case {
  readonly name: string;
  readonly check: string;
  readonly [key: string]: unknown;
}

type Dict = Record<string, unknown>;

const nodesOf = (item: Case): ReadonlyMap<string, unknown> =>
  new Map(Object.entries((item["nodes"] as Dict | undefined) ?? {}));

function runCase(item: Case): unknown {
  const path = (item["path"] as string | undefined) ?? "atlas/graph.json";
  switch (item.check) {
    case "state_entry_has_dated_input":
      return stateEntryHasDatedInput(item["entry"]);
    case "state_status_evidence":
      return stateStatusEvidenceErrors(
        item["entry"] as Dict,
        path,
        item["position"] as number,
        nodesOf(item),
      );
    case "state_provenance":
      return stateProvenanceErrors(
        item["entry"] as Dict,
        path,
        item["position"] as number,
        item["state_id"] as string,
        (item["node_type"] as string | undefined) ?? null,
        nodesOf(item),
      );
    case "review_gate":
      return reviewGateErrors(
        item["entry"] as Dict,
        path,
        item["position"] as number,
        (item["as_of"] as string | undefined) ?? null,
        nodesOf(item),
        item["state_id"] as string,
        (item["node_type"] as string | undefined) ?? null,
      );
    case "graph_field":
      return graphFieldErrors(item["instance"] as Dict, path);
    case "state_cites_withheld":
      return stateCitesWithheldId(
        item["entry"],
        new Set(item["withheld"] as string[]),
      );
    case "user_self_proposal":
      return userSelfProposalErrors(
        item["row"],
        path,
        new Map(Object.entries(item["artifact_kinds"] as Dict)),
      );
    case "status_evidence":
      return statusEvidenceErrors(
        item["row"],
        path,
        new Map(Object.entries(item["artifact_kinds"] as Dict)),
      );
    case "reproposal": {
      const rejected = newRejectedProposals();
      const retired = new Map(
        Object.entries((item["retired"] as Dict | undefined) ?? {}).map(
          ([key, value]) => [key, value as readonly string[]],
        ),
      );
      const known = new Set(item["known_targets"] as string[]);
      return (item["rows"] as unknown[]).map((row) =>
        reproposalErrors(row, path, rejected, known, retired),
      );
    }
    case "snapshot_dangling":
      return snapshotDanglingRefs(item["snapshot"] as Dict, path);
    case "snapshot_state_kind": {
      // `text` is parsed here rather than sent as a value: see the oracle.
      const snapshot =
        item["text"] === undefined
          ? (item["snapshot"] as Dict)
          : (jsonLoads(item["text"] as string) as Dict);
      return snapshotStateKindErrors(snapshot, path);
    }
    default:
      throw new Error(`unknown check ${item.check}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOTE = { type: "artifact", kind: "note", observed_at: "2026-03-01" };
const READ = {
  type: "artifact",
  kind: "reading",
  observed_at: "2026-03-02",
  evidence_strength: "read",
};
const APPLIED = {
  type: "artifact",
  kind: "reading",
  observed_at: "2026-03-05",
  evidence_strength: "applied",
};
const SESSION = { type: "encounter", date: "2026-03-03", depth: "practiced" };
const TAUGHT = { type: "encounter", date: "2026-03-04", depth: "taught" };

const NODES: Dict = {
  "concept:a": { type: "concept", id: "concept:a" },
  "material:m": { type: "material", id: "material:m" },
  "question:q": { type: "question", id: "question:q" },
  "artifact:note": NOTE,
  "artifact:read": READ,
  "artifact:applied": APPLIED,
  "encounter:session": SESSION,
  "encounter:taught": TAUGHT,
};

const MEDICAL_NODES: Dict = {
  ...NODES,
  "zone:z": { type: "zone", id: "zone:z", sensitivity: "medical" },
  "artifact:private": { ...NOTE, sensitivity: "medical" },
};

const cases: Case[] = [];
const add = (name: string, check: string, rest: Dict): void => {
  cases.push({ name, check, ...rest } as Case);
};

// -- has a dated input -------------------------------------------------------
for (const [label, entry] of [
  ["a bare last_seen", { last_seen: "2026-03-01" }],
  // Presence, not a value: a key holding null is a dated input in both
  // languages, and a rule that read the value instead would agree with the
  // oracle on every entry that carries a date.
  ["a last_seen holding null", { last_seen: null }],
  ["a dated decision", { decisions: [{ dimension: "status", date: "2026-03-01" }] }],
  ["an undated decision", { decisions: [{ dimension: "status" }] }],
  ["decisions that are not objects", { decisions: ["x", 7, null] }],
  ["decisions that are not a list", { decisions: "x" }],
  ["nothing at all", {}],
  ["not an object", "text"],
  ["null", null],
] as ReadonlyArray<readonly [string, unknown]>) {
  add(`dated input: ${label}`, "state_entry_has_dated_input", { entry });
}

// -- status evidence on an emitted state entry -------------------------------
// `resolved`, not `answered`: §9.8's question statuses are open | clarified |
// resolved | stale, and a status outside them returns before the evidence
// restriction is ever consulted. The whole ordinary arm of this rule went
// untested behind that early return until Codex named it.
const STATUS_ENTRY = (over: Dict): Dict => ({
  status: "resolved",
  evidence: ["artifact:read"],
  decisions: [{ dimension: "status", date: "2026-03-02", evidence: ["artifact:read"] }],
  ...over,
});

for (const [label, entry] of [
  ["an answered status on an artifact", STATUS_ENTRY({})],
  ["a status outside the vocabulary", STATUS_ENTRY({ status: "invented" })],
  ["a status that is not a string", STATUS_ENTRY({ status: 7 })],
  ["no status at all", STATUS_ENTRY({ status: undefined })],
  ["no status decision", STATUS_ENTRY({ decisions: [] })],
  [
    "a status decision citing a question",
    STATUS_ENTRY({
      decisions: [{ dimension: "status", evidence: ["question:q"] }],
    }),
  ],
  // The one citation the two arms disagree about: an encounter resolves a
  // question and cannot make it stale. Everything else the corpus cites is
  // an artifact, which both arms admit.
  [
    "a status decision citing an encounter",
    STATUS_ENTRY({
      decisions: [{ dimension: "status", evidence: ["encounter:session"] }],
    }),
  ],
  [
    "a status decision citing nothing",
    STATUS_ENTRY({ decisions: [{ dimension: "status", evidence: [] }] }),
  ],
  [
    "a status decision whose evidence is not a list",
    STATUS_ENTRY({ decisions: [{ dimension: "status", evidence: "artifact:read" }] }),
  ],
  [
    "a status decision citing a non-string",
    STATUS_ENTRY({ decisions: [{ dimension: "status", evidence: [7] }] }),
  ],
  [
    "stale, cited to the user's own note",
    STATUS_ENTRY({
      status: "stale",
      decisions: [{ dimension: "status", evidence: ["artifact:note"] }],
    }),
  ],
  [
    "stale, cited to a reading instead",
    STATUS_ENTRY({
      status: "stale",
      decisions: [{ dimension: "status", evidence: ["artifact:read"] }],
    }),
  ],
  [
    "stale, cited to an encounter the restriction excludes",
    STATUS_ENTRY({
      status: "stale",
      decisions: [{ dimension: "status", evidence: ["encounter:session"] }],
    }),
  ],
  [
    "stale, cited to an artifact that does not resolve",
    STATUS_ENTRY({
      status: "stale",
      decisions: [{ dimension: "status", evidence: ["artifact:gone"] }],
    }),
  ],
  [
    "stale, one resolving and one dangling",
    STATUS_ENTRY({
      status: "stale",
      decisions: [
        { dimension: "status", evidence: ["artifact:read", "artifact:gone"] },
      ],
    }),
  ],
] as ReadonlyArray<readonly [string, Dict]>) {
  add(`status evidence: ${label}`, "state_status_evidence", {
    entry,
    position: 3,
    nodes: NODES,
  });
}

// -- provenance --------------------------------------------------------------
const CONCEPT_ENTRY = (over: Dict): Dict => ({
  exposure: "read",
  last_seen: "2026-03-02",
  freshness: "fresh",
  evidence: ["artifact:read"],
  decisions: [{ dimension: "confidence", date: "2026-03-02", evidence: ["artifact:read"] }],
  ...over,
});

for (const [label, entry, nodeType, nodes] of [
  ["a concept whose decision evidence is in its own", CONCEPT_ENTRY({}), "concept", NODES],
  [
    "a concept whose decision cites more than its state",
    CONCEPT_ENTRY({
      decisions: [{ dimension: "confidence", evidence: ["artifact:read", "artifact:note"] }],
    }),
    "concept",
    NODES,
  ],
  [
    "a concept whose last_seen is not a cited contact date",
    CONCEPT_ENTRY({ last_seen: "2026-03-09" }),
    "concept",
    NODES,
  ],
  [
    "a concept whose last_seen matches an encounter",
    CONCEPT_ENTRY({ last_seen: "2026-03-03", evidence: ["encounter:session"] }),
    "concept",
    NODES,
  ],
  [
    "a concept citing a question, which carries no contact date",
    CONCEPT_ENTRY({ evidence: ["question:q"], last_seen: "2026-03-02" }),
    "concept",
    NODES,
  ],
  [
    "a concept whose last_seen is not a string",
    CONCEPT_ENTRY({ last_seen: 20_260_302 }),
    "concept",
    NODES,
  ],
  [
    "a concept citing an artifact with an impossible date",
    CONCEPT_ENTRY({
      evidence: ["artifact:bad"],
      last_seen: "2026-02-30",
    }),
    "concept",
    { ...NODES, "artifact:bad": { type: "artifact", observed_at: "2026-02-30" } },
  ],
  [
    "a material whose last_seen is its latest encounter",
    { last_seen: "2026-03-04", evidence: ["encounter:session", "encounter:taught"] },
    "material",
    NODES,
  ],
  [
    "a material whose last_seen is the earlier encounter",
    { last_seen: "2026-03-03", evidence: ["encounter:session", "encounter:taught"] },
    "material",
    NODES,
  ],
  [
    "a material part, on the same rule",
    { last_seen: "2026-03-03", evidence: ["encounter:session", "encounter:taught"] },
    "material_part",
    NODES,
  ],
  [
    "a material citing no encounter at all",
    { last_seen: "2026-03-02", evidence: ["artifact:read"] },
    "material",
    NODES,
  ],
  [
    "a question whose evidence equals its status decision",
    {
      evidence: ["artifact:read"],
      decisions: [{ dimension: "status", evidence: ["artifact:read"] }],
    },
    "question",
    NODES,
  ],
  [
    "a question whose evidence differs from its status decision",
    {
      evidence: ["artifact:read", "artifact:note"],
      decisions: [{ dimension: "status", evidence: ["artifact:read"] }],
    },
    "question",
    NODES,
  ],
  [
    "a question whose evidence differs only in order",
    {
      evidence: ["artifact:note", "artifact:read"],
      decisions: [{ dimension: "status", evidence: ["artifact:read", "artifact:note"] }],
    },
    "question",
    NODES,
  ],
  [
    "a question with no status decision",
    { evidence: ["artifact:read"], decisions: [] },
    "question",
    NODES,
  ],
  // Evidence is a list of ids everywhere a producer writes it, so the
  // structural comparison behind this rule is only ever asked about strings —
  // and a comparison that stopped looking at object keys would agree with the
  // oracle on every one of them. These two are the shape that separates them:
  // Python's `==` is False between dicts of different size, and a JavaScript
  // key-by-key walk over the smaller one is True. The smaller dict has to be
  // the one walked, so the extra key sits on the decision's side.
  [
    "a question whose status decision carries an object with an extra key",
    {
      evidence: [{ id: "artifact:read" }],
      decisions: [
        { dimension: "status", evidence: [{ id: "artifact:read", note: "kept" }] },
      ],
    },
    "question",
    NODES,
  ],
  // CPython's `1 == True` (#131). The oracle finds these two lists equal and
  // says nothing; the port compares with `===`, finds them different and
  // fires. Kept as a divergence rather than fixed: both values are already
  // schema-invalid, and agreeing would mean accepting more.
  [
    "a question whose evidence is an integer against a boolean",
    {
      evidence: [1],
      decisions: [{ dimension: "status", evidence: [true] }],
    },
    "question",
    NODES,
  ],
  [
    "a question whose evidence objects agree on keys and not on values",
    {
      evidence: [{ id: "artifact:read" }],
      decisions: [{ dimension: "status", evidence: [{ id: "artifact:note" }] }],
    },
    "question",
    NODES,
  ],
  [
    "a question whose evidence carries the same object twice",
    {
      evidence: [{ id: "artifact:read", note: "kept" }],
      decisions: [
        { dimension: "status", evidence: [{ id: "artifact:read", note: "kept" }] },
      ],
    },
    "question",
    NODES,
  ],
  [
    "a medical target whose entry carries the class",
    { evidence: ["artifact:read"], sensitivity: "medical" },
    "zone",
    MEDICAL_NODES,
  ],
  [
    "a medical target whose entry omits the class",
    { evidence: ["artifact:read"] },
    "zone",
    MEDICAL_NODES,
  ],
  [
    "medical evidence, an unmarked target",
    { evidence: ["artifact:private"] },
    "concept",
    MEDICAL_NODES,
  ],
  [
    "medical evidence reached through a decision only",
    { evidence: [], decisions: [{ dimension: "status", evidence: ["artifact:private"] }] },
    "concept",
    MEDICAL_NODES,
  ],
  [
    "a sensitivity class canon does not define",
    { evidence: ["artifact:read"], sensitivity: "invented" },
    "zone",
    MEDICAL_NODES,
  ],
  ["a node type nothing special applies to", { evidence: [] }, "probe", NODES],
  ["no node type at all", { evidence: [] }, null, NODES],
] as ReadonlyArray<readonly [string, Dict, string | null, Dict]>) {
  add(`provenance: ${label}`, "state_provenance", {
    entry,
    position: 1,
    state_id: nodeType === "zone" ? "zone:z" : "concept:a",
    node_type: nodeType,
    nodes,
  });
}

// -- the review gate ---------------------------------------------------------
const GATE = (over: Dict): Dict => ({
  exposure: "read",
  last_seen: "2026-03-02",
  freshness: "fresh",
  evidence: ["artifact:read"],
  ...over,
});

for (const [label, entry, nodeType, asOf] of [
  ["a first-value exposure with no evidence", { exposure: "unseen" }, "concept", "2026-03-10"],
  ["a moved exposure with no evidence", { exposure: "read", evidence: [] }, "concept", "2026-03-10"],
  ["a moved exposure within its ceiling", GATE({}), "concept", "2026-03-10"],
  [
    "an exposure past what its evidence can reach",
    GATE({ exposure: "taught" }),
    "concept",
    "2026-03-10",
  ],
  [
    "an exposure exactly at its ceiling",
    GATE({ exposure: "applied", evidence: ["artifact:applied"], last_seen: "2026-03-05" }),
    "concept",
    "2026-03-10",
  ],
  // The rung above the ceiling and the rung at it, as a pair. Only these two
  // separate a ceiling that is an upper bound from one that is off by one:
  // an exposure several rungs too high is refused either way.
  [
    "an exposure exactly one rung above its ceiling",
    GATE({ exposure: "summarized" }),
    "concept",
    "2026-03-10",
  ],
  [
    "a depth reached exactly one rung above its ceiling",
    { depth_reached: "read", evidence: ["encounter:session"] },
    "material",
    "2026-03-10",
  ],
  [
    "a depth reached exactly at its ceiling",
    { depth_reached: "skim", evidence: ["encounter:session"] },
    "material",
    "2026-03-10",
  ],
  [
    "an exposure outside the ladder entirely",
    GATE({ exposure: "invented" }),
    "concept",
    "2026-03-10",
  ],
  [
    "a depth reached on encounter evidence",
    { depth_reached: "practiced", evidence: ["encounter:session"] },
    "material",
    "2026-03-10",
  ],
  [
    "a depth reached citing an artifact instead",
    { depth_reached: "practiced", evidence: ["artifact:read"] },
    "material",
    "2026-03-10",
  ],
  [
    "a depth reached citing an encounter that does not resolve",
    { depth_reached: "practiced", evidence: ["encounter:gone"] },
    "material",
    "2026-03-10",
  ],
  [
    "a depth reached past its ceiling",
    { depth_reached: "taught", evidence: ["encounter:session"] },
    "material",
    "2026-03-10",
  ],
  // Mixed provenance: every cited row must be an encounter, and a corpus of
  // all-encounter and no-encounter cases cannot tell `every` from `some`.
  [
    "a depth reached on one encounter and one artifact",
    { depth_reached: "skim", evidence: ["encounter:session", "artifact:read"] },
    "material",
    "2026-03-10",
  ],
  ["contact without last_seen", GATE({ last_seen: undefined }), "concept", "2026-03-10"],
  ["contact without freshness", GATE({ freshness: undefined }), "concept", "2026-03-10"],
  [
    "no contact but a last_seen anyway",
    { exposure: "unseen", last_seen: "2026-03-02", evidence: [] },
    "concept",
    "2026-03-10",
  ],
  [
    "no contact but a freshness anyway",
    { exposure: "unseen", freshness: "fresh", evidence: [] },
    "concept",
    "2026-03-10",
  ],
  ["last seen after the as-of", GATE({ last_seen: "2026-03-20" }), "concept", "2026-03-10"],
  ["last seen exactly on the as-of", GATE({ last_seen: "2026-03-02" }), "concept", "2026-03-02"],
  ["a freshness the derivation produces", GATE({}), "concept", "2026-03-10"],
  [
    "a freshness the derivation does not produce",
    GATE({ freshness: "stale" }),
    "concept",
    "2026-03-10",
  ],
  [
    "a freshness across the aging boundary",
    GATE({ freshness: "aging", last_seen: "2026-03-02" }),
    "concept",
    "2026-04-01",
  ],
  [
    "a freshness across the stale boundary",
    GATE({ freshness: "stale", last_seen: "2026-03-02" }),
    "concept",
    "2026-06-01",
  ],
  ["no as-of to measure against", GATE({}), "concept", null],
  [
    "two decisions for one dimension",
    GATE({
      decisions: [
        { dimension: "confidence", date: "2026-03-02", evidence: ["artifact:read"] },
        { dimension: "confidence", date: "2026-03-03", evidence: ["artifact:read"] },
      ],
    }),
    "concept",
    "2026-03-10",
  ],
  [
    "a decision dated exactly on the as-of",
    GATE({
      decisions: [{ dimension: "confidence", date: "2026-03-10", evidence: ["artifact:read"] }],
    }),
    "concept",
    "2026-03-10",
  ],
  [
    "a decision dated after the as-of",
    GATE({
      decisions: [{ dimension: "confidence", date: "2026-03-20", evidence: ["artifact:read"] }],
    }),
    "concept",
    "2026-03-10",
  ],
  [
    "a gated value moved with no decision",
    GATE({ confidence: "solid" }),
    "concept",
    "2026-03-10",
  ],
  [
    "a gated value moved with its decision",
    GATE({
      confidence: "solid",
      decisions: [{ dimension: "confidence", date: "2026-03-02", evidence: ["artifact:read"] }],
    }),
    "concept",
    "2026-03-10",
  ],
  [
    "a gated value left at its default",
    GATE({ confidence: "unknown" }),
    "concept",
    "2026-03-10",
  ],
  [
    "every gated dimension moved at once",
    GATE({ confidence: "solid", clarity: "clear", coverage: "broad", status: "answered" }),
    "concept",
    "2026-03-10",
  ],
  [
    "decisions whose dimension is not a string",
    GATE({ decisions: [{ dimension: 7 }, { dimension: null }] }),
    "concept",
    "2026-03-10",
  ],
  // The gate is a join, and a join can lose a limb without any of its own
  // cases noticing. These two carry a fault that belongs to the status and
  // evidence rule above, so a port that forgot to include that rule here —
  // and passed every case that calls it directly — fails on these.
  [
    "a status decision cited outside the outcome restriction",
    GATE({
      status: "resolved",
      decisions: [{ dimension: "status", date: "2026-03-02", evidence: ["concept:a"] }],
    }),
    "concept",
    "2026-03-10",
  ],
  [
    "a stale status with nothing but a reading behind it",
    GATE({
      status: "stale",
      decisions: [{ dimension: "status", date: "2026-03-02", evidence: ["artifact:read"] }],
    }),
    "concept",
    "2026-03-10",
  ],
] as ReadonlyArray<readonly [string, Dict, string, string | null]>) {
  add(`review gate: ${label}`, "review_gate", {
    entry,
    position: 2,
    as_of: asOf,
    nodes: NODES,
    state_id: nodeType === "material" ? "material:m" : "concept:a",
    node_type: nodeType,
  });
}

// -- §10.4 field membership --------------------------------------------------
const GRAPH = (nodes: unknown[], edges: unknown[]): Dict => ({
  format: "atlas-graph",
  version: 1,
  nodes,
  edges,
});

for (const [label, instance] of [
  [
    "a material whose fields match its reach",
    GRAPH(
      [
        { id: "concept:a", type: "concept", fields: ["knowledge"] },
        { id: "material:m", type: "material", fields: ["knowledge"] },
      ],
      [{ source: "material:m", target: "concept:a", type: "overall_concept" }],
    ),
  ],
  [
    "a material claiming a field it cannot reach",
    GRAPH(
      [
        { id: "concept:a", type: "concept", fields: ["knowledge"] },
        { id: "material:m", type: "material", fields: ["knowledge", "body"] },
      ],
      [{ source: "material:m", target: "concept:a", type: "overall_concept" }],
    ),
  ],
  [
    "a material claiming none of what it reaches",
    GRAPH(
      [
        { id: "concept:a", type: "concept", fields: ["knowledge"] },
        { id: "material:m", type: "material", fields: [] },
      ],
      [{ source: "material:m", target: "concept:a", type: "overall_concept" }],
    ),
  ],
  [
    "fields listed in another order",
    GRAPH(
      [
        { id: "concept:a", type: "concept", fields: ["knowledge"] },
        { id: "zone:z", type: "zone", fields: ["body"] },
        {
          id: "artifact:x",
          type: "artifact",
          fields: ["knowledge", "body"],
        },
      ],
      [
        { source: "artifact:x", target: "concept:a", type: "influences" },
        { source: "artifact:x", target: "zone:z", type: "updates_state" },
      ],
    ),
  ],
  [
    "fields that are not a list",
    GRAPH(
      [
        { id: "concept:a", type: "concept", fields: ["knowledge"] },
        { id: "material:m", type: "material", fields: "knowledge" },
      ],
      [{ source: "material:m", target: "concept:a", type: "overall_concept" }],
    ),
  ],
  [
    "fields holding a value that is not a name",
    GRAPH(
      [
        { id: "concept:a", type: "concept", fields: ["knowledge"] },
        { id: "material:m", type: "material", fields: ["knowledge", 7, null] },
      ],
      [{ source: "material:m", target: "concept:a", type: "overall_concept" }],
    ),
  ],
  [
    "a node with no id",
    GRAPH([{ type: "material", fields: [] }], []),
  ],
  ["no nodes at all", GRAPH([], [])],
  ["nodes that are not a list", { format: "atlas-graph", nodes: "x", edges: [] }],
] as ReadonlyArray<readonly [string, Dict]>) {
  add(`field membership: ${label}`, "graph_field", { instance });
}

// -- withheld ids ------------------------------------------------------------
for (const [label, entry, withheld] of [
  ["state citing a withheld id directly", { evidence: ["artifact:gone"] }, ["artifact:gone"]],
  [
    "state citing one only through a decision",
    { evidence: [], decisions: [{ evidence: ["artifact:gone"] }] },
    ["artifact:gone"],
  ],
  ["state citing nothing withheld", { evidence: ["artifact:read"] }, ["artifact:gone"]],
  ["nothing withheld at all", { evidence: ["artifact:read"] }, []],
  ["an entry that is not an object", "text", ["artifact:gone"]],
] as ReadonlyArray<readonly [string, unknown, string[]]>) {
  add(`withheld: ${label}`, "state_cites_withheld", { entry, withheld });
}

// -- user self-proposals and status evidence on journal rows -----------------
const KINDS: Dict = { "artifact:note": "note", "artifact:read": "reading" };

for (const [label, row] of [
  ["a user proposal citing their own note", { proposed_by: "user", evidence: ["artifact:note"] }],
  ["a user proposal citing a reading", { proposed_by: "user", evidence: ["artifact:read"] }],
  ["a user proposal citing no artifact", { proposed_by: "user", evidence: ["encounter:x"] }],
  ["a user proposal citing nothing", { proposed_by: "user", evidence: [] }],
  [
    "a user proposal citing an artifact that does not resolve",
    { proposed_by: "user", evidence: ["artifact:gone"] },
  ],
  [
    "a user proposal citing one resolving and one dangling",
    { proposed_by: "user", evidence: ["artifact:read", "artifact:gone"] },
  ],
  ["an agent proposal", { proposed_by: "plan-importer", evidence: [] }],
  ["a row that is not an object", "text"],
] as ReadonlyArray<readonly [string, unknown]>) {
  add(`self proposal: ${label}`, "user_self_proposal", { row, artifact_kinds: KINDS });
}

for (const [label, row] of [
  ["a status decision citing an artifact", { dimension: "status", to: "answered", evidence: ["artifact:read"] }],
  ["a status decision citing a question", { dimension: "status", to: "answered", evidence: ["question:q"] }],
  ["a confirmed stale citing the note", { dimension: "status", to: "stale", decision: "confirmed", evidence: ["artifact:note"] }],
  ["a confirmed stale citing a reading", { dimension: "status", to: "stale", decision: "confirmed", evidence: ["artifact:read"] }],
  ["a rejected stale citing a reading", { dimension: "status", to: "stale", decision: "rejected", evidence: ["artifact:read"] }],
  ["a confirmed stale citing a dangling artifact", { dimension: "status", to: "stale", decision: "confirmed", evidence: ["artifact:gone"] }],
  ["a stale citing an encounter", { dimension: "status", to: "stale", evidence: ["encounter:session"] }],
  ["a status decision citing nothing", { dimension: "status", to: "resolved", evidence: [] }],
  ["a decision on another dimension", { dimension: "confidence", to: "solid", evidence: [] }],
  ["a row that is not an object", 7],
] as ReadonlyArray<readonly [string, unknown]>) {
  add(`status row: ${label}`, "status_evidence", { row, artifact_kinds: KINDS });
}

// -- proposal memory ---------------------------------------------------------
const PROPOSE = (over: Dict): Dict => ({
  target: "concept:a",
  dimension: "confidence",
  to: "solid",
  evidence: ["artifact:read"],
  decision: "rejected",
  ...over,
});

add("reproposal: the same evidence twice after a rejection", "reproposal", {
  known_targets: ["concept:a"],
  rows: [PROPOSE({}), PROPOSE({ decision: "confirmed" })],
});
add("reproposal: strictly more evidence after a rejection", "reproposal", {
  known_targets: ["concept:a"],
  rows: [
    PROPOSE({}),
    PROPOSE({ decision: "confirmed", evidence: ["artifact:read", "artifact:note"] }),
  ],
});
add("reproposal: strictly less evidence after a rejection", "reproposal", {
  known_targets: ["concept:a"],
  rows: [
    PROPOSE({ evidence: ["artifact:read", "artifact:note"] }),
    PROPOSE({ decision: "confirmed", evidence: ["artifact:read"] }),
  ],
});
add("reproposal: different evidence after a rejection", "reproposal", {
  known_targets: ["concept:a"],
  rows: [PROPOSE({}), PROPOSE({ decision: "confirmed", evidence: ["artifact:note"] })],
});
add("reproposal: a different value after a rejection", "reproposal", {
  known_targets: ["concept:a"],
  rows: [PROPOSE({}), PROPOSE({ to: "shaky", decision: "confirmed" })],
});
add("reproposal: a different dimension after a rejection", "reproposal", {
  known_targets: ["concept:a"],
  rows: [PROPOSE({}), PROPOSE({ dimension: "clarity", to: "clear" })],
});
add("reproposal: two rejections then the same evidence", "reproposal", {
  known_targets: ["concept:a"],
  rows: [
    PROPOSE({ evidence: ["artifact:read"] }),
    PROPOSE({ evidence: ["artifact:note"] }),
    PROPOSE({ evidence: ["artifact:note"], decision: "confirmed" }),
  ],
});
add("reproposal: a confirmation never enters the memory", "reproposal", {
  known_targets: ["concept:a"],
  rows: [PROPOSE({ decision: "confirmed" }), PROPOSE({ decision: "confirmed" })],
});
add("reproposal: a target that is not known", "reproposal", {
  known_targets: [],
  rows: [PROPOSE({}), PROPOSE({ decision: "confirmed" })],
});
add("reproposal: a retired target redirected to a live one", "reproposal", {
  known_targets: ["concept:b"],
  retired: { "concept:a": ["concept:b"] },
  rows: [PROPOSE({}), PROPOSE({ decision: "confirmed" })],
});
add("reproposal: two ids redirected to the same target", "reproposal", {
  known_targets: ["concept:b"],
  retired: { "concept:a": ["concept:b"], "concept:old": ["concept:b"] },
  rows: [PROPOSE({}), PROPOSE({ target: "concept:old", decision: "confirmed" })],
});
add("reproposal: a dimension no target kind folds", "reproposal", {
  known_targets: ["concept:a"],
  rows: [
    PROPOSE({ dimension: "invented" }),
    PROPOSE({ dimension: "invented", decision: "confirmed" }),
  ],
});
add("reproposal: a target whose kind the dimension does not fold", "reproposal", {
  known_targets: ["material:m"],
  rows: [
    PROPOSE({ target: "material:m" }),
    PROPOSE({ target: "material:m", decision: "confirmed" }),
  ],
});
add("reproposal: rows missing the fields the rule needs", "reproposal", {
  known_targets: ["concept:a"],
  rows: [
    PROPOSE({ evidence: [] }),
    PROPOSE({ evidence: "artifact:read" }),
    PROPOSE({ evidence: [7] }),
    PROPOSE({ decision: "invented" }),
    PROPOSE({ target: 7 }),
    PROPOSE({ dimension: null }),
    PROPOSE({ to: undefined }),
    "text",
  ],
});

// -- snapshots ---------------------------------------------------------------
const SNAPSHOT = (over: Dict): Dict => ({
  format: "atlas-snapshot",
  version: 1,
  evidence_refs: {
    "artifact:read": { kind: "artifact", date: "2026-03-02" },
    "encounter:session": { kind: "encounter", date: "2026-03-03" },
  },
  state: {},
  materials: {},
  trail: [],
  questions: [],
  ...over,
});

for (const [label, snapshot] of [
  ["everything resolving", SNAPSHOT({})],
  [
    "state evidence absent from the table",
    SNAPSHOT({ state: { "concept:a": { evidence: ["artifact:gone"] } } }),
  ],
  [
    "decision evidence absent from the table",
    SNAPSHOT({
      state: { "concept:a": { evidence: [], decisions: [{ evidence: ["artifact:gone"] }] } },
    }),
  ],
  [
    "material evidence absent from the table",
    SNAPSHOT({ materials: { "material:m": { evidence: ["encounter:gone"] } } }),
  ],
  // A question is the third §9.12 evidence kind and the one a snapshot cites
  // least, so it is the one a prefix list loses without any other case
  // noticing. Both halves are here: unresolved, then resolved through the
  // table, because a rule that stopped looking at questions passes the first
  // by silence and the second by accident.
  [
    "question evidence absent from the table",
    SNAPSHOT({ state: { "concept:a": { evidence: ["question:open"] } } }),
  ],
  [
    "question evidence the table resolves",
    SNAPSHOT({
      evidence_refs: { "question:open": { kind: "question", date: "2026-03-04" } },
      state: { "concept:a": { evidence: ["question:open"] } },
    }),
  ],
  [
    "a trail segment citing an absent id",
    SNAPSHOT({ trail: [{ via: ["artifact:gone"] }] }),
  ],
  [
    "a trail segment citing a material part, which is a node ref",
    SNAPSHOT({ trail: [{ via: ["part:m/one"] }] }),
  ],
  [
    "a question citing an absent id",
    SNAPSHOT({ questions: [{ source: ["encounter:gone"] }] }),
  ],
  [
    "a table key that is not an evidence id",
    SNAPSHOT({ evidence_refs: { "concept:a": { kind: "concept" } } }),
  ],
  [
    "a table key whose kind contradicts its prefix",
    SNAPSHOT({ evidence_refs: { "artifact:read": { kind: "encounter" } } }),
  ],
  // §10.1 anchoring, in the one place a `$` is not the end of the string:
  // Python's `$` matches before a trailing newline and the oracle's
  // `fullmatch` does not (#129). Both sides must refuse this key.
  [
    "a table key with a trailing newline",
    SNAPSHOT({ evidence_refs: { "artifact:read\n": { kind: "artifact" } } }),
  ],
  [
    "a table entry that is not an object",
    SNAPSHOT({ evidence_refs: { "artifact:read": "note" } }),
  ],
  ["no table at all", SNAPSHOT({ evidence_refs: undefined })],
  ["a table that is not an object", SNAPSHOT({ evidence_refs: [] })],
  [
    "a materials key that is not a material id",
    SNAPSHOT({ materials: { "concept:a": { evidence: [] } } }),
  ],
  [
    "a materials key that is a material part",
    SNAPSHOT({ materials: { "part:m/one": { evidence: [] } } }),
  ],
  [
    "a materials key with a trailing newline",
    SNAPSHOT({ materials: { "material:m\n": { evidence: [] } } }),
  ],
] as ReadonlyArray<readonly [string, Dict]>) {
  add(`snapshot refs: ${label}`, "snapshot_dangling", { snapshot });
}

for (const [label, snapshot] of [
  [
    "a concept on concept scales",
    SNAPSHOT({ state: { "concept:a": { exposure: "read", confidence: "solid" } } }),
  ],
  [
    "a concept carrying a zone ladder",
    SNAPSHOT({ state: { "concept:a": { exposure: "read", strength: "steady" } } }),
  ],
  [
    "a zone carrying a concept dimension",
    SNAPSHOT({ state: { "zone:z": { contact: "some", clarity: "clear" } } }),
  ],
  // Every zone ladder at once, on a concept. A set is only as closed as its
  // least-named member: drop one and it stops being cross-kind anywhere,
  // because the union of the sets is what decides what counts as a dimension
  // at all. Naming them individually is what makes each one load-bearing.
  [
    "a concept carrying each zone dimension in turn",
    SNAPSHOT({
      state: {
        "concept:a": {
          contact: "some",
          strength: "steady",
          endurance: "held",
          mobility: "free",
          condition: "quiet",
        },
      },
    }),
  ],
  [
    "a concept carrying the material ladder",
    SNAPSHOT({ state: { "concept:a": { depth_reached: "practiced" } } }),
  ],
  [
    "a pattern exposure from the concept ladder",
    SNAPSHOT({ state: { "pattern:p": { exposure: "summarized" } } }),
  ],
  [
    "a pattern exposure from its own ladder",
    SNAPSHOT({ state: { "pattern:p": { exposure: "drilled" } } }),
  ],
  // The rungs at the ends of a ladder: a corpus that samples the middle
  // cannot tell a shortened ladder from the whole one.
  [
    "a pattern exposure at the top of its ladder",
    SNAPSHOT({ state: { "pattern:p": { exposure: "reviewed" } } }),
  ],
  [
    "a pattern exposure at the bottom of its ladder",
    SNAPSHOT({ state: { "pattern:p": { exposure: "unseen" } } }),
  ],
  [
    "a zone exposure, which has no ladder to check",
    SNAPSHOT({ state: { "zone:z": { exposure: "anything" } } }),
  ],
  [
    "a concept gating a zone dimension",
    SNAPSHOT({
      state: { "concept:a": { decisions: [{ dimension: "endurance" }] } },
    }),
  ],
  [
    "a concept gating its own dimension",
    SNAPSHOT({ state: { "concept:a": { decisions: [{ dimension: "clarity" }] } } }),
  ],
  [
    "a state key that is not a region id",
    SNAPSHOT({ state: { "material:m": { exposure: "read" } } }),
  ],
  [
    "a state entry that is not an object",
    SNAPSHOT({ state: { "concept:a": "read" } }),
  ],
  [
    "a state key with a trailing newline",
    SNAPSHOT({ state: { "concept:a\n": { exposure: "read" } } }),
  ],
  [
    "an unknown key, which stays additive",
    SNAPSHOT({ state: { "concept:a": { invented: "value" } } }),
  ],
  ["no state at all", SNAPSHOT({ state: undefined })],
] as ReadonlyArray<readonly [string, Dict]>) {
  add(`snapshot scales: ${label}`, "snapshot_state_kind", { snapshot });
}

// A state table whose first key is not the one written first. It has to arrive
// as text: any value this harness sends is serialised by JavaScript on the way
// out, and JavaScript has already moved the index-like key to the front by
// then, so both sides would receive the reordered document and agree about it.
add("snapshot scales: a state key that looks like an array index", "snapshot_state_kind", {
  text: JSON.stringify({
    format: "atlas-snapshot",
    version: 1,
    state: {},
  }).replace(
    '"state":{}',
    '"state":{"concept:a":{"strength":"steady"},"0":{"depth_reached":"practiced"}}',
  ),
});

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function normalise(value: unknown): unknown {
  if (typeof value === "string") return foldQuotes(value);
  if (Array.isArray(value)) return value.map(normalise);
  return value;
}

const KNOWN: ReadonlyMap<string, string> = new Map([
  // Python holds `1 == True`, so the oracle finds a state entry's evidence
  // equal to its decision's and stays quiet where the port fires. Recorded as
  // #131: the port keeps `===` and refuses input the schema refuses anyway.
  [
    "provenance: a question whose evidence is an integer against a boolean",
    "#131",
  ],
  // Object.entries visits an integer-like key first whatever order it arrived
  // in, so a state table holding one reports the same errors in another
  // sequence. Recorded as #128; the set is identical.
  ["snapshot scales: a state key that looks like an array index", "#128"],
]);

// Serialised once and parsed back for this side's own run, so both sides read
// the same bytes. A fixture written `{last_seen: undefined}` otherwise keeps
// the key as an own property here and loses it on the way to the oracle, and
// `"last_seen" in entry` — a rule this harness exists to compare — answers
// differently for a reason that is nowhere in either implementation.
const payloadText = JSON.stringify(
  cases.map((item) => {
    const { name, ...rest } = item;
    void name;
    return rest;
  }),
);
const payload = JSON.parse(payloadText) as Case[];

const theirs = oracleAnswer("checks", payloadText) as Array<{
  ok?: unknown;
  raised?: string;
}>;

let diverged = 0;
let recorded = 0;

cases.forEach((item, index) => {
  let mine: { ok?: unknown; raised?: string };
  try {
    mine = { ok: runCase(payload[index] as Case) };
  } catch (error) {
    mine = { raised: (error as Error).constructor.name };
  }
  const mineText = JSON.stringify(normalise(mine.ok ?? null));
  const oracle = theirs[index] as { ok?: unknown; raised?: string };
  const theirsText = JSON.stringify(normalise(oracle?.ok ?? null));

  if (mine.raised !== undefined || oracle?.raised !== undefined) {
    console.error(
      `checks: ${item.name}: raised — mine ${mine.raised ?? "-"}, ` +
        `oracle ${oracle?.raised ?? "-"}`,
    );
    diverged += 1;
    return;
  }
  if (mineText === theirsText) return;
  if (KNOWN.has(item.name)) {
    recorded += 1;
    return;
  }
  diverged += 1;
  console.error(`checks: ${item.name}`);
  console.error(`  mine:   ${mineText}`);
  console.error(`  oracle: ${theirsText}`);
});

// A rule whose every case draws the same answer is reachable, not tested: it
// would pass against a port that returned that answer and nothing else. So
// each rule must be seen both firing and staying quiet. This is the floor the
// review gate went under — every one of its own cases had it answering, while
// the limb it borrows from the status and evidence rule could be cut without
// a single case changing.
const answers = new Map<string, Set<string>>();
cases.forEach((item, index) => {
  const oracle = theirs[index] as { ok?: unknown };
  const seen = answers.get(item.check) ?? new Set<string>();
  seen.add(JSON.stringify(normalise(oracle?.ok ?? null)));
  answers.set(item.check, seen);
});
let vacuous = 0;
for (const [check, seen] of [...answers].sort()) {
  if (seen.size >= 2) continue;
  vacuous += 1;
  console.error(`checks: ${check}: every case draws the same answer, so none of them discriminate`);
}

// Named, because this harness runs the zone matrix: a line that did not say
// which zone it ran in would leave six identical lines and no way to tell
// which one failed.
const zone = process.env["TZ"] ?? "<unset>";
console.log(
  `checks [TZ=${zone}]: ${cases.length} cases compared, ` +
    `${diverged} unexplained, ${recorded} recorded, ${vacuous} vacuous`,
);
process.exit(diverged === 0 && vacuous === 0 ? 0 : 1);
