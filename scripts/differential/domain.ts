// The shared vocabulary and its derivations, against the Python the builder
// and the validator both import.
//
// Two halves, and the first is the one that earns its keep. A constant here is
// a transcription of a § line, and a transcription is exactly the kind of
// thing that is copied *almost* right: one missing member of a closed set is
// a validator that admits a word canon does not, and no derivation test would
// ever notice. So every set, map and ladder is dumped from both sides and
// compared whole, before any function is called at all.

import { oracleAnswer } from "./oracle.ts";

import {
  AGENT_ROLES,
  AUTHORED_ROLES,
  CONCEPT_DEFAULTS,
  CONCEPT_EXPOSURE,
  CONCEPT_KIND,
  CURATED_SUBDIRECTORIES,
  DECISION_OUTCOMES,
  DECISION_TARGET_PREFIXES,
  DECISION_VALUES,
  DEEP_USE_DEPTHS,
  DEFERRED_DECISION_TARGET_KINDS,
  DEFERRED_DIMENSIONS,
  EDGE_TYPES,
  EDGE_WEIGHTS,
  ENCOUNTER_DEPTHS,
  ENCOUNTER_MODES,
  ENDPOINT_RULES,
  EVIDENCE_PREFIXES,
  EVIDENCE_STRENGTHS,
  FOLDED_DECISION_TARGETS,
  FORBIDDEN_ROUTE_STATUSES,
  FRESHNESS_DAYS,
  GATED_DEFAULTS,
  ID_PREFIXES,
  INTAKE_KEY_PATTERN,
  INTAKE_KEY_RE,
  JOURNAL_ROW_KEYS,
  LIFECYCLE_STATUSES,
  MATERIAL_DEPTH,
  MATERIAL_KINDS,
  NODE_ID_PATTERN,
  NODE_ID_RE,
  NODE_TYPES,
  PART_ID_PATTERN,
  PART_ID_RE,
  PROPOSERS,
  QUESTION_DEFAULT_STATUS,
  REGION_PREFIXES,
  ROUTE_STATUSES,
  SENSITIVITY_CLASSES,
  STALE_EVIDENCE_KIND,
  STALE_EVIDENCE_PREFIXES,
  STATUS_EVIDENCE_PREFIXES,
  SYMMETRIC_EDGE_TYPES,
  WEAK_HALO_EDGE_TYPES,
  depthCeiling,
  exposureCeiling,
  foldOrderKey,
  freshnessOf,
  graphFieldExpectations,
  idType,
} from "../src/domain.ts";
import { sortedByCodePoint } from "../src/ordering.ts";

const setOf = (values: ReadonlySet<string>): string[] => sortedByCodePoint([...values]);

const mapOf = (
  mapping: ReadonlyMap<string, string | number | ReadonlySet<string>>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of sortedByCodePoint([...mapping.keys()])) {
    const value = mapping.get(key) as string | number | ReadonlySet<string>;
    out[key] = value instanceof Set ? setOf(value) : value;
  }
  return out;
};

const CONSTANTS: Record<string, unknown> = {
  NODE_TYPES: setOf(NODE_TYPES),
  EDGE_TYPES: setOf(EDGE_TYPES),
  ID_PREFIXES: mapOf(ID_PREFIXES),
  AUTHORED_ROLES: setOf(AUTHORED_ROLES),
  SYMMETRIC_EDGE_TYPES: setOf(SYMMETRIC_EDGE_TYPES),
  WEAK_HALO_EDGE_TYPES: setOf(WEAK_HALO_EDGE_TYPES),
  CONCEPT_KIND: setOf(CONCEPT_KIND),
  ENDPOINT_RULES: Object.fromEntries(
    sortedByCodePoint([...ENDPOINT_RULES.keys()]).map((key) => {
      const [source, target] = ENDPOINT_RULES.get(key) as [
        ReadonlySet<string>,
        ReadonlySet<string>,
      ];
      return [key, [setOf(source), setOf(target)]];
    }),
  ),
  EDGE_WEIGHTS: setOf(EDGE_WEIGHTS),
  CURATED_SUBDIRECTORIES: [...CURATED_SUBDIRECTORIES],
  JOURNAL_ROW_KEYS: mapOf(JOURNAL_ROW_KEYS),
  REGION_PREFIXES: setOf(REGION_PREFIXES),
  INTAKE_KEY_RE: INTAKE_KEY_PATTERN,
  PART_ID_RE: PART_ID_PATTERN,
  NODE_ID_RE: NODE_ID_PATTERN,
  LIFECYCLE_STATUSES: setOf(LIFECYCLE_STATUSES),
  MATERIAL_KINDS: setOf(MATERIAL_KINDS),
  SENSITIVITY_CLASSES: setOf(SENSITIVITY_CLASSES),
  ENCOUNTER_DEPTHS: setOf(ENCOUNTER_DEPTHS),
  ENCOUNTER_MODES: setOf(ENCOUNTER_MODES),
  DEEP_USE_DEPTHS: setOf(DEEP_USE_DEPTHS),
  EVIDENCE_STRENGTHS: setOf(EVIDENCE_STRENGTHS),
  CONCEPT_EXPOSURE: [...CONCEPT_EXPOSURE],
  CONCEPT_DEFAULTS: mapOf(CONCEPT_DEFAULTS),
  QUESTION_DEFAULT_STATUS,
  MATERIAL_DEPTH: [...MATERIAL_DEPTH],
  FRESHNESS_DAYS: mapOf(FRESHNESS_DAYS),
  GATED_DEFAULTS: mapOf(GATED_DEFAULTS),
  DECISION_VALUES: mapOf(DECISION_VALUES),
  FOLDED_DECISION_TARGETS: mapOf(FOLDED_DECISION_TARGETS),
  DEFERRED_DIMENSIONS: mapOf(DEFERRED_DIMENSIONS),
  DEFERRED_DECISION_TARGET_KINDS: mapOf(DEFERRED_DECISION_TARGET_KINDS),
  DECISION_TARGET_PREFIXES: mapOf(DECISION_TARGET_PREFIXES),
  DECISION_OUTCOMES: setOf(DECISION_OUTCOMES),
  EVIDENCE_PREFIXES: setOf(EVIDENCE_PREFIXES),
  STATUS_EVIDENCE_PREFIXES: setOf(STATUS_EVIDENCE_PREFIXES),
  STALE_EVIDENCE_PREFIXES: setOf(STALE_EVIDENCE_PREFIXES),
  STALE_EVIDENCE_KIND,
  AGENT_ROLES: setOf(AGENT_ROLES),
  PROPOSERS: setOf(PROPOSERS),
  ROUTE_STATUSES: setOf(ROUTE_STATUSES),
  FORBIDDEN_ROUTE_STATUSES: setOf(FORBIDDEN_ROUTE_STATUSES),
};

// Graphs shaped to exercise every branch of the §10.4 derivation: each ref
// route on its own, a chain that has to resolve through two hops, a cycle
// that must terminate, a node that reaches nothing, and the malformed shapes
// a boundary check meets because it runs on input that already failed.
const GRAPHS: unknown[] = [
  {},
  { nodes: [], edges: [] },
  { nodes: "not a list", edges: 7 },
  {
    nodes: [
      { id: "concept:a", type: "concept", fields: ["knowledge"] },
      { id: "material:m", type: "material" },
      { id: "part:m/one", type: "material_part" },
    ],
    edges: [
      { source: "material:m", target: "concept:a", type: "overall_concept" },
      { source: "material:m", target: "part:m/one", type: "has_part" },
    ],
  },
  {
    // A part reaching a concept through each of its own edge roles.
    nodes: [
      { id: "zone:z", type: "zone" },
      { id: "pattern:p", type: "pattern" },
      { id: "part:m/one", type: "material_part" },
    ],
    edges: [
      { source: "part:m/one", target: "pattern:p", type: "explains" },
      { source: "pattern:p", target: "zone:z", type: "loads" },
    ],
  },
  {
    // The target-owned directions: the ref runs backwards along the edge.
    nodes: [
      { id: "concept:a", type: "concept" },
      { id: "suggested-route:r", type: "suggested_route" },
      { id: "direction:d", type: "direction" },
      { id: "probe:pr", type: "probe" },
      { id: "question:q", type: "question" },
    ],
    edges: [
      { source: "concept:a", target: "suggested-route:r", type: "step_of_route" },
      { source: "concept:a", target: "direction:d", type: "part_of_direction" },
      { source: "concept:a", target: "probe:pr", type: "probed_by" },
      { source: "concept:a", target: "question:q", type: "pulled_by" },
    ],
  },
  {
    // Payload-held refs: an encounter's target, a segment's from ∪ to, and a
    // route's source_plan, which reverses to give the plan its fields.
    nodes: [
      { id: "concept:a", type: "concept" },
      { id: "material:m", type: "material" },
      { id: "encounter:e", type: "encounter", target: "material:m" },
      {
        id: "trail-segment:t",
        type: "trail_segment",
        from: ["concept:a"],
        to: "material:m",
      },
      { id: "plan:p", type: "plan" },
      { id: "suggested-route:r", type: "suggested_route", source_plan: "plan:p" },
    ],
    edges: [
      { source: "material:m", target: "concept:a", type: "overall_concept" },
      { source: "concept:a", target: "suggested-route:r", type: "step_of_route" },
    ],
  },
  {
    // `from` as a bare string rather than a list, which the derivation admits.
    nodes: [
      { id: "concept:a", type: "concept" },
      { id: "trail-segment:t", type: "trail_segment", from: "concept:a", to: null },
    ],
    edges: [],
  },
  {
    // A cycle. Termination is the whole point of the `seen` set.
    nodes: [
      { id: "material:a", type: "material" },
      { id: "material:b", type: "material" },
    ],
    edges: [
      { source: "material:a", target: "material:b", type: "overall_concept" },
      { source: "material:b", target: "material:a", type: "overall_concept" },
    ],
  },
  {
    // A node reaching a region through two hops and one that reaches nothing.
    nodes: [
      { id: "concept:a", type: "concept" },
      { id: "material:m", type: "material" },
      { id: "part:m/one", type: "material_part" },
      { id: "probe:lonely", type: "probe" },
    ],
    edges: [
      { source: "material:m", target: "part:m/one", type: "has_part" },
      { source: "part:m/one", target: "concept:a", type: "mentions" },
    ],
  },
  {
    // A part edge role from a source that is not a part: not a ref at all.
    nodes: [
      { id: "concept:a", type: "concept" },
      { id: "material:m", type: "material" },
    ],
    edges: [{ source: "material:m", target: "concept:a", type: "mentions" }],
  },
  {
    // Two regions of different fields reaching one node: a union, not a pick.
    nodes: [
      { id: "concept:a", type: "concept" },
      { id: "zone:z", type: "zone" },
      { id: "artifact:x", type: "artifact" },
    ],
    edges: [
      { source: "artifact:x", target: "concept:a", type: "influences" },
      { source: "artifact:x", target: "zone:z", type: "updates_state" },
    ],
  },
  {
    // Everything malformed at once: no ids, no types, edges to nowhere.
    nodes: [
      null,
      7,
      { id: 7, type: "concept" },
      { id: "concept:a", type: 7 },
      { id: "material:m" },
      { id: "material:n", type: "material" },
    ],
    edges: [
      null,
      { source: 1, target: "concept:a", type: "overall_concept" },
      { source: "material:n", target: "missing:thing", type: "overall_concept" },
      { source: "material:n", target: "concept:a" },
    ],
  },
];

// Evidence sets for the two ceilings, including the equality case that lifts
// exposure to the top rung and the malformed values a boundary check meets.
const NODES_FOR_CEILINGS: Record<string, unknown> = {
  "artifact:noticed": { type: "artifact", evidence_strength: "noticed", observed_at: "2026-01-01" },
  "artifact:read": { type: "artifact", evidence_strength: "read", observed_at: "2026-01-02" },
  "artifact:summarized": { type: "artifact", evidence_strength: "summarized", observed_at: "2026-01-03" },
  "artifact:applied": { type: "artifact", evidence_strength: "applied", observed_at: "2026-01-04" },
  "artifact:explained-early": { type: "artifact", evidence_strength: "explained", observed_at: "2026-01-05" },
  "artifact:explained-late": { type: "artifact", evidence_strength: "explained", observed_at: "2026-03-01" },
  "artifact:reviewed-early": { type: "artifact", evidence_strength: "reviewed", observed_at: "2026-01-04" },
  "artifact:reviewed-same": { type: "artifact", evidence_strength: "reviewed", observed_at: "2026-01-05" },
  "artifact:reviewed-late": { type: "artifact", evidence_strength: "reviewed", observed_at: "2026-06-01" },
  "artifact:unknown-strength": { type: "artifact", evidence_strength: "invented", observed_at: "2026-01-01" },
  "artifact:strength-not-a-string": { type: "artifact", evidence_strength: 7, observed_at: "2026-01-01" },
  "artifact:no-date": { type: "artifact", evidence_strength: "explained" },
  "encounter:skim": { type: "encounter", depth: "skim" },
  "encounter:read": { type: "encounter", depth: "read" },
  "encounter:taught": { type: "encounter", depth: "taught" },
  "encounter:no-depth": { type: "encounter" },
  "encounter:depth-not-a-string": { type: "encounter", depth: 7 },
  "concept:a": { type: "concept" },
  "not-a-node": 7,
};

const CEILINGS: Array<{ evidence: unknown[]; nodes: Record<string, unknown> }> = [
  [],
  ["artifact:noticed"],
  ["artifact:read"],
  ["artifact:summarized"],
  ["artifact:applied"],
  ["artifact:noticed", "artifact:applied"],
  ["encounter:skim"],
  ["encounter:read"],
  ["encounter:taught"],
  ["encounter:skim", "encounter:taught"],
  ["encounter:no-depth"],
  ["encounter:depth-not-a-string"],
  // A review no earlier than the earliest explanation lifts exposure to the
  // last rung; a review strictly before every explanation does not.
  ["artifact:explained-late", "artifact:reviewed-late"],
  ["artifact:explained-late", "artifact:reviewed-early"],
  ["artifact:explained-early", "artifact:reviewed-same"],
  ["artifact:explained-early", "artifact:no-date"],
  ["artifact:no-date", "artifact:reviewed-late"],
  ["artifact:unknown-strength"],
  ["artifact:strength-not-a-string"],
  ["concept:a"],
  ["not-a-node"],
  ["missing:entirely"],
  [7, null, "artifact:read"],
].map((evidence) => ({ evidence, nodes: NODES_FOR_CEILINGS }));

// Ages either side of both §14.7 boundaries, and exactly on them.
const FRESHNESS: Array<[string, string]> = [
  ["2026-01-01", "2026-01-01"],
  ["2026-01-01", "2026-01-31"],
  ["2026-01-01", "2026-02-01"],
  ["2026-01-01", "2026-03-31"],
  ["2026-01-01", "2026-04-01"],
  ["2026-01-01", "2027-01-01"],
  ["2024-02-28", "2024-03-29"],
  ["2024-02-29", "2024-03-30"],
  ["2023-12-31", "2024-01-30"],
  ["2026-06-01", "2026-01-01"],
];

const IDS: string[] = [
  "concept:a",
  "material:m",
  "part:m/one",
  "direction:d",
  "suggested-route:r",
  "trail-segment:t",
  "personal-trail:p",
  "artifact:x",
  "encounter:e",
  "question:q",
  "probe:pr",
  "plan:p",
  "zone:z",
  "pattern:pt",
  "invented:thing",
  "concept",
  "",
  ":",
  "concept:a:b",
];

// A pattern that reads the same can still match differently: `$` before a
// trailing newline is exactly the trap the schema port had to work around, so
// the ids here carry newlines, tabs and the near-misses the shape excludes.
const MATCHES: string[] = [
  "part:m/one",
  "part:m/one\n",
  "\npart:m/one",
  "part:m/one\nconcept:a",
  "part:M/one",
  "part:m/one/two",
  "part:m",
  "concept:a",
  "suggested-route:r",
  "concept:a\n",
  "concept:a_b",
  "concept:-a",
  "concept:a-",
  "batch/entry#0",
  "batch/entry#0\n",
  "batch/entry#",
  "batch/entry#01",
  "batch/entry",
  "",
  "\n",
  "\t",
];

const FOLD_ORDER: Array<[string, number]> = [
  ["2026-01-01", 0],
  ["2026-01-01", 7],
  ["2026-12-31", 1],
];

const payload = {
  graphs: GRAPHS,
  ceilings: CEILINGS,
  freshness: FRESHNESS,
  ids: IDS,
  fold_order: FOLD_ORDER,
  matches: MATCHES,
};

const payloadText = JSON.stringify(payload);
const oracle = oracleAnswer("domain", payloadText) as {
  constants: Record<string, unknown>;
  fields: Array<Array<[string, string[]]>>;
  exposure: number[];
  depth: number[];
  freshness: string[];
  id_type: Array<string | null>;
  fold_order: Array<[string, number]>;
  matches: boolean[][];
  loose_matches: boolean[][];
};

let compared = 0;
let divergences = 0;
let recorded = 0;

const check = (label: string, mine: unknown, theirs: unknown): void => {
  compared += 1;
  const mineText = JSON.stringify(mine);
  const theirsText = JSON.stringify(theirs);
  if (mineText !== theirsText) {
    divergences += 1;
    console.error(`domain: ${label}`);
    console.error(`  mine:   ${mineText}`);
    console.error(`  oracle: ${theirsText}`);
  }
};

// Every constant by name, and the roster itself: a symbol added on one side
// and forgotten on the other is the failure this catches.
check(
  "the set of transcribed constants",
  sortedByCodePoint(Object.keys(CONSTANTS)),
  sortedByCodePoint(Object.keys(oracle.constants)),
);
for (const name of sortedByCodePoint(Object.keys(CONSTANTS))) {
  check(`constant ${name}`, CONSTANTS[name], oracle.constants[name]);
}

GRAPHS.forEach((graph, index) => {
  const mine = [...graphFieldExpectations(graph)].sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
  );
  check(`field expectations #${index}`, mine, oracle.fields[index]);
});

CEILINGS.forEach((testCase, index) => {
  const nodes = new Map(Object.entries(testCase.nodes));
  check(`exposure ceiling #${index}`, exposureCeiling(testCase.evidence, nodes), oracle.exposure[index]);
  check(`depth ceiling #${index}`, depthCeiling(testCase.evidence, nodes), oracle.depth[index]);
});

FRESHNESS.forEach(([lastSeen, asOf], index) => {
  check(`freshness ${lastSeen} → ${asOf}`, freshnessOf(lastSeen, asOf), oracle.freshness[index]);
});

IDS.forEach((value, index) => {
  check(`id type ${JSON.stringify(value)}`, idType(value), oracle.id_type[index]);
});

MATCHES.forEach((value, index) => {
  const mine = [PART_ID_RE.test(value), NODE_ID_RE.test(value), INTAKE_KEY_RE.test(value)];
  // Against `fullmatch`, which is what an anchored `test` means here.
  check(`matches ${JSON.stringify(value)}`, mine, oracle.matches[index]);

  // And against `match`, which is not the same predicate: Python's `$` also
  // matches before a trailing newline, so the oracle's own call sites disagree
  // with each other — the ones that validate an id use `match` and admit
  // `"concept:a\n"`, the ones that validate evidence use `fullmatch` and do
  // not. The port has one predicate, the strict one (#129).
  compared += 1;
  const loose = oracle.loose_matches[index] as boolean[];
  if (JSON.stringify(mine) !== JSON.stringify(loose)) {
    if (value.endsWith("\n") && !value.slice(0, -1).includes("\n")) recorded += 1;
    else {
      divergences += 1;
      console.error(`domain: loose match ${JSON.stringify(value)}`);
      console.error(`  mine:   ${JSON.stringify(mine)}`);
      console.error(`  oracle: ${JSON.stringify(loose)}`);
    }
  }
});

FOLD_ORDER.forEach(([date, position], index) => {
  check(`fold order ${date}#${position}`, foldOrderKey(date, position), oracle.fold_order[index]);
});

const zone = process.env["TZ"] ?? "<unset>";
console.log(
  `domain [TZ=${zone}]: ${compared} comparisons agree with the oracle ` +
    `(${recorded} recorded divergences)`,
);
process.exit(divergences === 0 ? 0 : 1);
